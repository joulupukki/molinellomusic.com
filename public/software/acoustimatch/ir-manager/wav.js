// AcoustiMatch IR manager - IR file handling (decode, export, response plot)
// SPDX-License-Identifier: GPL-3.0-or-later

// Header facts for display; null if this isn't a RIFF/WAVE file.
export function parseWavInfo(buf) {
  const v = new DataView(buf);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let info = null;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && o + 24 <= buf.byteLength) {
      info = {
        format: v.getUint16(o + 8, true),
        channels: v.getUint16(o + 10, true),
        rate: v.getUint32(o + 12, true),
        bits: v.getUint16(o + 22, true),
      };
    } else if (id === "data" && info) {
      info.frames = Math.floor(size / Math.max(1, (info.bits / 8) * info.channels));
      return info;
    }
    o += 8 + size + (size & 1);
  }
  return info;
}

// Decode an IR file to mono at `rate`, at most `maxTaps` long. The browser's
// decoder handles 16/24/32-bit integer and 32-bit float WAVs (and most other
// audio formats) and resamples to the context's rate.
export async function decodeIR(file, rate, maxTaps, usedTaps) {
  const buf = await file.arrayBuffer();
  const info = parseWavInfo(buf);
  let audio;
  try {
    const ctx = new OfflineAudioContext(1, 1, rate);
    audio = await ctx.decodeAudioData(buf.slice(0));
  } catch {
    throw new Error(`${file.name} isn't an audio file this browser can read. Use a WAV file.`);
  }
  const n = Math.min(audio.length, maxTaps);
  const taps = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) taps[i] += ch[i] / audio.numberOfChannels;
  }
  let peak = 0;
  for (const x of taps) peak = Math.max(peak, Math.abs(x));
  if (peak < 1e-6) throw new Error(`${file.name} is silent.`);

  const srcRate = info?.rate || audio.sampleRate;
  const notes = [];
  if (audio.numberOfChannels > 1) notes.push("Stereo file, mixed to mono.");
  if (srcRate !== rate) notes.push(`Converted from ${khz(srcRate)} to ${khz(rate)}.`);
  if (audio.length > usedTaps)
    notes.push(
      `The pedal plays the first ${ms(usedTaps, rate)} of this ${ms(audio.length, rate)} IR and fades out the rest.`,
    );
  return { taps, notes, srcRate, srcLength: audio.length };
}

export const khz = (r) => `${+(r / 1000).toFixed(1)} kHz`;
export const ms = (n, r) => `${Math.round((n / r) * 1000)} ms`;

// Mono 32-bit float WAV.
export function encodeWav(taps, rate) {
  const data = taps.length * 4;
  const b = new ArrayBuffer(44 + data);
  const v = new DataView(b);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  str(36, "data");
  v.setUint32(40, data, true);
  for (let i = 0; i < taps.length; i++) v.setFloat32(44 + i * 4, taps[i], true);
  return new Blob([b], { type: "audio/wav" });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k), wi = Math.sin(a * k);
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - xr;
        im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
}

// Magnitude response, 1/6-octave smoothed, at log-spaced points from 40 Hz to
// 16 kHz, in dB relative to its own 200 Hz - 5 kHz average.
export function response(taps, rate, points = 96) {
  const n = 8192;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < Math.min(taps.length, n); i++) re[i] = taps[i];
  fft(re, im);
  const pow = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) pow[i] = re[i] * re[i] + im[i] * im[i];
  const lo = 40, hi = 16000, out = [];
  for (let p = 0; p < points; p++) {
    const f = lo * Math.pow(hi / lo, p / (points - 1));
    const a = Math.max(1, Math.floor((f * Math.pow(2, -1 / 12) * n) / rate));
    const b = Math.max(a + 1, Math.ceil((f * Math.pow(2, 1 / 12) * n) / rate));
    let s = 0;
    for (let i = a; i < b && i < n / 2; i++) s += pow[i];
    out.push({ f, db: 10 * Math.log10(s / (b - a) + 1e-20) });
  }
  const ref = out.filter((x) => x.f >= 200 && x.f <= 5000);
  const mean = ref.reduce((s, x) => s + x.db, 0) / ref.length;
  return out.map((x) => ({ f: x.f, db: x.db - mean }));
}
