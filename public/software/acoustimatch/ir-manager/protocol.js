// AcoustiMatch IR manager - pedal link protocol (mirror of src/ir_link.h)
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Transport-independent: give PedalLink a `write(Uint8Array)` function and
// feed it received bytes with `receive(Uint8Array)`. The web page wires it to
// Web Serial; the Node test wires it to a fake pedal process.

export const SYNC = 0xa5;
export const CMD = {
  HELLO: 0x01,
  LIST: 0x02,
  READ: 0x03,
  BEGIN: 0x04,
  DATA: 0x05,
  COMMIT: 0x06,
  RENAME: 0x07,
  RESET: 0x08,
  GET_VOICING: 0x09,
  SET_VOICING: 0x0a,
};
const REPLY = 0x80;
export const STATUS = {
  OK: 0,
  BAD_REQUEST: 1,
  BAD_SLOT: 2,
  BAD_STATE: 3,
  BAD_CRC: 4,
  FLASH_ERROR: 5,
  UNKNOWN_CMD: 6,
};
const STATUS_TEXT = {
  1: "the pedal rejected the request",
  2: "no such slot",
  3: "the upload was interrupted",
  4: "the data was corrupted in transfer",
  5: "the pedal couldn't write its flash memory",
  6: "the pedal's firmware doesn't support this",
};

export const NAME_LEN = 32;
export const VOICING_LEN = 36;
export const VOICING_VERSION = 2;
export const VOICING_PROTOCOL = 3; // first protocol with this voicing block

// Wet-path voicing block (src/voicing.h), field order as on the wire after
// the version / soft_enabled / refl_enabled / reserved bytes.
export const VOICING_FIELDS = [
  "softAmount", "softFastMs", "softSlowMs", "softMaxCutDb",
  "reflLevelDb", "reflSize", "reflDampingHz", "softKneeDb",
];
// Accepted ranges, as in src/voicing.h.
export const VOICING_RANGES = {
  softAmount: [0, 2],
  softFastMs: [0.25, 5],
  softSlowMs: [3, 60],
  softMaxCutDb: [0, 12],
  softKneeDb: [0, 9],
  reflLevelDb: [-40, 0],
  reflSize: [0.5, 1.5],
  reflDampingHz: [1000, 16000],
};

export function encodeVoicing(v) {
  const b = new Uint8Array(VOICING_LEN);
  const dv = new DataView(b.buffer);
  b[0] = VOICING_VERSION;
  b[1] = v.softEnabled ? 1 : 0;
  b[2] = v.reflEnabled ? 1 : 0;
  VOICING_FIELDS.forEach((k, i) => dv.setFloat32(4 + 4 * i, v[k], true));
  return b;
}

export function decodeVoicing(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v = { softEnabled: bytes[1] === 1, reflEnabled: bytes[2] === 1 };
  VOICING_FIELDS.forEach((k, i) => (v[k] = dv.getFloat32(4 + 4 * i, true)));
  return v;
}
const SLOT_ENTRY = 44;
const MAX_FRAME_PAYLOAD = 1024 + 64;

export function crc16(bytes, crc = 0xffff) {
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeFrame(cmd, payload = new Uint8Array(0)) {
  const f = new Uint8Array(payload.length + 6);
  f[0] = SYNC;
  f[1] = cmd;
  f[2] = payload.length & 0xff;
  f[3] = payload.length >> 8;
  f.set(payload, 4);
  const c = crc16(f.subarray(1, 4 + payload.length));
  f[4 + payload.length] = c & 0xff;
  f[5 + payload.length] = c >> 8;
  return f;
}

// Fixed-width ASCII field, NUL-padded, printable characters only.
export function encodeName(name) {
  const out = new Uint8Array(NAME_LEN);
  let n = 0;
  for (const ch of name) {
    if (n >= NAME_LEN - 1) break;
    const c = ch.codePointAt(0);
    out[n++] = c >= 0x20 && c <= 0x7e ? c : 0x5f; // '_'
  }
  return out;
}

function decodeString(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

export class PedalError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class PedalLink {
  constructor(write) {
    this.write = write;
    this.rx = new Uint8Array(0);
    this.waiting = null; // { cmd, resolve, reject, timer }
    this.queue = Promise.resolve();
    this.needsSettle = false;
    this.info = null;
  }

  // Bytes from the pedal.
  receive(chunk) {
    const merged = new Uint8Array(this.rx.length + chunk.length);
    merged.set(this.rx);
    merged.set(chunk, this.rx.length);
    this.rx = merged;
    for (;;) {
      let skip = 0;
      while (skip < this.rx.length && this.rx[skip] !== SYNC) skip++;
      this.rx = this.rx.subarray(skip);
      if (this.rx.length < 4) return;
      const len = this.rx[2] | (this.rx[3] << 8);
      if (len > MAX_FRAME_PAYLOAD) {
        this.rx = this.rx.subarray(1);
        continue;
      }
      if (this.rx.length < len + 6) return;
      const want = this.rx[4 + len] | (this.rx[5 + len] << 8);
      if (crc16(this.rx.subarray(1, 4 + len)) !== want) {
        this.rx = this.rx.subarray(1);
        continue;
      }
      const cmd = this.rx[1];
      const payload = this.rx.slice(4, 4 + len);
      this.rx = this.rx.subarray(len + 6);
      this.#deliver(cmd, payload);
    }
  }

  #deliver(cmd, payload) {
    const w = this.waiting;
    if (!w || cmd !== (w.cmd | REPLY)) return; // stale reply from a timed-out request
    this.waiting = null;
    clearTimeout(w.timer);
    w.resolve(payload);
  }

  // Abandon any in-flight request (port closed).
  close(reason = "Disconnected") {
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(new PedalError(reason));
      this.waiting = null;
    }
  }

  // One request/reply exchange. Requests are serialized: the pedal handles one
  // at a time and the protocol has no request IDs.
  request(cmd, payload = new Uint8Array(0), timeoutMs = 1500) {
    const run = async () => {
      if (this.needsSettle) {
        // After a timeout, give the pedal time to drop any half-received frame.
        await new Promise((r) => setTimeout(r, 300));
        this.needsSettle = false;
      }
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = null;
          this.needsSettle = true;
          reject(new PedalError("The pedal didn't respond"));
        }, timeoutMs);
        this.waiting = { cmd, resolve, reject, timer };
      });
      await this.write(encodeFrame(cmd, payload));
      const data = await reply;
      const status = data[0];
      if (status !== STATUS.OK)
        throw new PedalError(STATUS_TEXT[status] || `pedal error ${status}`, status);
      return new DataView(data.buffer, data.byteOffset, data.byteLength);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async hello() {
    const v = await this.request(CMD.HELLO, undefined, 1000);
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    this.info = {
      protocol: v.getUint8(1),
      slots: v.getUint8(2),
      nameLen: v.getUint8(3),
      maxTaps: v.getUint16(4, true),
      maxChunk: v.getUint16(6, true),
      dspRate: v.getUint32(8, true),
      firmware: decodeString(bytes.subarray(12, 36)),
      platform: decodeString(bytes.subarray(36, 52)),
      product: decodeString(bytes.subarray(52, 68)),
    };
    return this.info;
  }

  async list() {
    const v = await this.request(CMD.LIST);
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const active = v.getUint8(1);
    const n = v.getUint8(2);
    const slots = [];
    for (let i = 0; i < n; i++) {
      const at = 3 + i * SLOT_ENTRY;
      slots.push({
        index: i,
        custom: v.getUint8(at) === 1,
        rate: v.getUint32(at + 4, true),
        length: v.getUint32(at + 8, true),
        name: decodeString(bytes.subarray(at + 12, at + 12 + NAME_LEN)),
      });
    }
    return { active, slots };
  }

  // The slot's effective IR (custom or factory) as Float32Array.
  async readSlot(slot, length, onProgress) {
    const total = length * 4;
    const out = new Uint8Array(total);
    const chunk = this.info ? this.info.maxChunk : 1024;
    let off = 0;
    while (off < total) {
      const p = new Uint8Array(7);
      const dv = new DataView(p.buffer);
      p[0] = slot;
      dv.setUint32(1, off, true);
      dv.setUint16(5, Math.min(chunk, total - off), true);
      const v = await this.request(CMD.READ, p);
      const got = v.byteLength - 5;
      if (got <= 0 || v.getUint32(1, true) !== off) throw new PedalError("Read failed");
      out.set(new Uint8Array(v.buffer, v.byteOffset + 5, got), off);
      off += got;
      onProgress?.(off / total);
    }
    const taps = new Float32Array(length);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < length; i++) taps[i] = dv.getFloat32(i * 4, true);
    return taps;
  }

  async uploadSlot(slot, taps, rate, name, onProgress) {
    const bytes = new Uint8Array(taps.length * 4);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < taps.length; i++) dv.setFloat32(i * 4, taps[i], true);

    const b = new Uint8Array(16 + NAME_LEN);
    const bv = new DataView(b.buffer);
    b[0] = slot;
    bv.setUint32(4, rate, true);
    bv.setUint32(8, taps.length, true);
    bv.setUint32(12, crc32(bytes), true);
    b.set(encodeName(name), 16);
    await this.request(CMD.BEGIN, b);

    const chunk = this.info ? this.info.maxChunk : 1024;
    for (let off = 0; off < bytes.length; off += chunk) {
      const part = bytes.subarray(off, Math.min(off + chunk, bytes.length));
      const p = new Uint8Array(4 + part.length);
      new DataView(p.buffer).setUint32(0, off, true);
      p.set(part, 4);
      await this.request(CMD.DATA, p);
      onProgress?.((off + part.length) / bytes.length);
    }
    // Erasing and programming flash takes a few hundred ms.
    await this.request(CMD.COMMIT, undefined, 6000);
  }

  async rename(slot, name) {
    const p = new Uint8Array(4 + NAME_LEN);
    p[0] = slot;
    p.set(encodeName(name), 4);
    await this.request(CMD.RENAME, p, 6000);
  }

  async reset(slot) {
    await this.request(CMD.RESET, new Uint8Array([slot]), 4000);
  }

  // Protocol 3+. The saved voicing, whether a preview is playing instead, and
  // what this firmware runs ({ softener, reflections }).
  async getVoicing() {
    const v = await this.request(CMD.GET_VOICING);
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const features = bytes[2 + VOICING_LEN];
    return {
      voicing: decodeVoicing(bytes.subarray(1, 1 + VOICING_LEN)),
      preview: bytes[1 + VOICING_LEN] === 1,
      features: { softener: !!(features & 1), reflections: !!(features & 2) },
    };
  }

  // Apply `voicing` on the pedal. save=false previews it (played, not saved).
  async setVoicing(voicing, save = true) {
    const p = new Uint8Array(VOICING_LEN + 1);
    p.set(encodeVoicing(voicing));
    p[VOICING_LEN] = save ? 0 : 1;
    await this.request(CMD.SET_VOICING, p);
  }
}
