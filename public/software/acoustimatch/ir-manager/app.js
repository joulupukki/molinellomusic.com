// AcoustiMatch IR manager - page logic
// SPDX-License-Identifier: GPL-3.0-or-later
import { PedalLink, VOICING_RANGES, VOICING_PROTOCOL } from "./protocol.js";
import { decodeIR, encodeWav, response, khz, ms } from "./wav.js";

// The Daisy Seed's built-in USB serial port (libDaisy's VID/PID).
const FILTERS = [{ usbVendorId: 0x0483, usbProductId: 0x5740 }];
const USED_TAPS = 2048; // the pedal's convolver length at 48 kHz
const POLL_MS = 800;
const POSITIONS = {
  FunBox: ["Left", "Middle", "Right"],
  Hothouse: ["Down", "Middle", "Up"],
};

const $ = (id) => document.getElementById(id);
// An empty slot: firmware without a built-in IR reports a 1-tap pass-through,
// so the position plays the dry pickup. (Older firmware reports its factory IR.)
const isEmpty = (s) => !s.custom && s.length === 1;
const state = {
  port: null,
  reader: null,
  link: null,
  info: null,
  active: -1,
  slots: [],
  taps: [],
  signature: "",
  plates: [], // per slot: { el, mode: "view"|"rename"|"staged"|"working", staged, msg }
  poll: null,
  polling: false,
  pollFailures: 0,
  busy: 0,
  connecting: false,
  reading: null, // the read loop's promise
  voicing: null, // saved wet-path voicing (protocol 3+), as the page shows it
  bypass: false, // "Bypass all" A/B: both features previewed off, nothing saved
};
const MAX_POLL_FAILURES = 3;

// ---- Connection -------------------------------------------------------------

function showError(text) {
  const e = $("connectErr");
  e.textContent = text;
  e.hidden = !text;
}

// `quiet`: an automatic reconnect on page load, which shouldn't complain.
async function connect(port, quiet = false) {
  if (state.port || state.connecting) return;
  state.connecting = true;
  showError("");
  try {
    try {
      // Replies are up to ~1 KB; the default 255-byte buffer is too small.
      await port.open({ baudRate: 115200, bufferSize: 65536 });
    } catch {
      if (!quiet)
        showError("The pedal's USB port is busy. Close any other tab or app that's using it, then try again.");
      return;
    }
    state.port = port;
    const link = new PedalLink(async (bytes) => {
      const w = port.writable.getWriter();
      try {
        await w.write(bytes);
      } finally {
        w.releaseLock();
      }
    });
    state.link = link;
    state.reading = readLoop(port, link);

    try {
      const info = await link.hello();
      if (info.product !== "AcoustiMatch") throw new Error();
      state.info = info;
    } catch {
      await disconnect();
      if (!quiet)
        showError(
          "A Daisy Seed is connected, but it isn't answering as an AcoustiMatch pedal. Update the pedal to firmware with IR manager support, then reconnect.",
        );
      return;
    }
  } finally {
    state.connecting = false;
  }
  onConnected();
}

// Read until this port is disconnected. Web Serial replaces port.readable
// after a non-fatal error (such as a buffer overrun), so take a new reader
// then - but only while the port is still ours, and never without yielding:
// a stream that ends immediately must not be able to spin the page.
async function readLoop(port, link) {
  while (state.port === port && port.readable) {
    const reader = port.readable.getReader();
    state.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return; // cancelled by disconnect()
        if (value?.length) link.receive(value);
      }
    } catch {
      // Fatal errors (unplugged) leave port.readable null and end the loop.
    } finally {
      reader.releaseLock();
      if (state.reader === reader) state.reader = null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function disconnect() {
  const port = state.port;
  clearInterval(state.poll);
  state.poll = null;
  state.port = null; // stops the read loop
  state.link?.close();
  try {
    await state.reader?.cancel();
  } catch {}
  try {
    await state.reading;
  } catch {}
  try {
    await port?.close();
  } catch {}
  Object.assign(state, {
    reader: null, reading: null, link: null, info: null, signature: "", active: -1,
    polling: false, pollFailures: 0, voicing: null, bypass: false,
  });
  $("voicing").hidden = true;
  $("panel").hidden = true;
  $("conn").hidden = true;
  $("intro").hidden = false;
}

async function onConnected() {
  const { info } = state;
  $("intro").hidden = true;
  $("panel").hidden = false;
  $("conn").hidden = false;
  $("conn").classList.add("on");
  $("connText").textContent = `Connected to AcoustiMatch (${info.platform})`;
  $("details").textContent =
    `Platform: ${info.platform}\nFirmware: ${info.firmware}\nProtocol: ${info.protocol}\n` +
    `Longest IR stored: ${info.maxTaps} samples\nIR length used: ${USED_TAPS} samples at ${khz(info.dspRate)} (${ms(USED_TAPS, info.dspRate)})`;
  const labels = POSITIONS[info.platform] || POSITIONS.FunBox;
  document.querySelectorAll(".switch b").forEach((b) => (b.textContent = labels[+b.dataset.pos]));
  buildPlates(info.slots, labels);
  await refresh();
  if (info.protocol >= VOICING_PROTOCOL) await loadVoicing();
  state.poll = setInterval(poll, POLL_MS);
}

// ---- Pedal state -------------------------------------------------------------

async function refresh(force = false) {
  const { active, slots } = await state.link.list();
  const sig = JSON.stringify(slots);
  if (force || sig !== state.signature) {
    const old = state.slots;
    state.slots = slots;
    state.signature = sig;
    for (const s of slots) {
      const o = old[s.index];
      if (force || !o || JSON.stringify(o) !== JSON.stringify(s) || !state.taps[s.index])
        state.taps[s.index] = await state.link.readSlot(s.index, s.length);
    }
    state.plates.forEach((_, i) => renderPlate(i));
  }
  setActive(active);
}

// One status check at a time: if the pedal is slow to answer, checks must not
// pile up behind each other.
async function poll() {
  if (state.busy || !state.link || state.polling) return;
  state.polling = true;
  try {
    await refresh();
    state.pollFailures = 0;
  } catch {
    if (!state.port) return;
    if (!state.port.readable) {
      await disconnect();
      showError("The pedal was disconnected. Plug it back in and click Connect pedal.");
    } else if (++state.pollFailures >= MAX_POLL_FAILURES) {
      await disconnect();
      showError("The pedal stopped answering. Unplug its USB cable, plug it back in, then click Connect pedal.");
    }
  } finally {
    state.polling = false;
  }
}

function setActive(i) {
  state.active = i;
  const lever = $("lever");
  const first = lever.hidden || !lever.style.left;
  lever.hidden = i < 0 || i > 2;
  // Jump into place on connect; slide when the toggle is flipped.
  lever.style.transition = first ? "none" : "";
  lever.style.left = `calc(100% / 6 + ${i} * 100% / 3)`;  // centre of column i
  state.plates.forEach((p, k) => (p.el.querySelector(".playing").hidden = k !== i));
}

// Run a pedal operation with polling paused.
async function withBusy(fn) {
  state.busy++;
  try {
    return await fn();
  } finally {
    state.busy--;
  }
}

// ---- Plates --------------------------------------------------------------------

function buildPlates(n, labels) {
  const root = $("plates");
  root.textContent = "";
  state.plates = [];
  for (let i = 0; i < n; i++) {
    const el = $("plateTpl").content.firstElementChild.cloneNode(true);
    el.querySelector(".pos").textContent = `Toggle 1 ${labels[i].toLowerCase()}`;
    el.setAttribute("aria-label", `Toggle 1 ${labels[i]} position`);
    const p = { el, mode: "view", staged: null, msg: null, confirmReset: false };
    state.plates.push(p);

    const input = el.querySelector("input[type=file]");
    input.addEventListener("change", () => {
      if (input.files[0]) stageFile(i, input.files[0]);
      input.value = "";
    });
    el.addEventListener("dragover", (e) => {
      if (p.mode === "working" || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      el.classList.add("drop");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop");
      const f = e.dataTransfer.files[0];
      if (f && p.mode !== "working") stageFile(i, f);
    });
    root.appendChild(el);
  }
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderPlate(i) {
  const p = state.plates[i];
  const s = state.slots[i];
  if (!p || !s) return;
  const el = p.el;
  const empty = isEmpty(s);
  el.querySelector(".head .tag").textContent = s.custom ? "Your IR" : empty ? "Empty" : "Factory IR";
  el.querySelector(".head .tag").classList.toggle("custom", s.custom);
  el.querySelector(".facts").textContent = empty
    ? "Plays the dry pickup"
    : `${khz(s.rate)}, ${ms(Math.min(s.length, USED_TAPS * s.rate / 48000), s.rate)}`;
  // While a new file is staged, preview its response instead.
  if (p.staged) drawCurve(el.querySelector("svg.curve"), p.staged.taps, state.info.dspRate, p.staged.name);
  else drawCurve(el.querySelector("svg.curve"), state.taps[i], s.rate, s.name);

  const view = el.querySelector(".view");
  const body = el.querySelector(".body");
  body.textContent = "";
  view.hidden = p.mode === "staged" || p.mode === "rename";
  el.querySelector(".name").textContent = s.name;

  if (p.mode === "rename") {
    const row = document.createElement("form");
    row.className = "rename";
    const inp = document.createElement("input");
    inp.value = s.name;
    inp.maxLength = 31;
    inp.setAttribute("aria-label", "IR name");
    row.append(inp, button("Save", "primary", () => {}));
    row.addEventListener("submit", (e) => {
      e.preventDefault();
      doRename(i, inp.value.trim());
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setMode(i, "view");
    });
    body.append(row);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("Cancel", "quiet", () => setMode(i, "view")));
    body.append(actions);
    queueMicrotask(() => inp.select());
  } else if (p.mode === "staged" || (p.mode === "working" && p.staged)) {
    const st = p.staged;
    const box = document.createElement("div");
    box.className = "staged";
    const file = document.createElement("p");
    file.className = "file";
    file.textContent = `New IR from ${st.file.name}`;
    const label = document.createElement("label");
    label.textContent = "Name on the pedal";
    const inp = document.createElement("input");
    inp.value = st.name;
    inp.maxLength = 31;
    inp.disabled = p.mode === "working";
    inp.addEventListener("input", () => (st.name = inp.value));
    label.append(inp);
    box.append(file, label);
    if (st.notes.length) {
      const ul = document.createElement("ul");
      for (const n of st.notes) {
        const li = document.createElement("li");
        li.textContent = n;
        ul.append(li);
      }
      box.append(ul);
    }
    if (p.mode === "working") {
      const prog = document.createElement("progress");
      prog.max = 1;
      prog.value = st.progress || 0;
      st.progressEl = prog;
      box.append(prog);
    } else {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        button("Load onto pedal", "primary", () => doUpload(i)),
        button("Cancel", "quiet", () => {
          p.staged = null;
          setMode(i, "view");
        }),
      );
      box.append(actions);
    }
    body.append(box);
  } else {
    const actions = document.createElement("div");
    actions.className = "actions";
    const working = p.mode === "working";
    const replace = button(empty ? "Load IR" : "Replace", "", () => el.querySelector("input[type=file]").click());
    const rename = button("Rename", "", () => setMode(i, "rename"));
    const download = button("Download", "", () => doDownload(i));
    actions.append(replace);
    if (!empty) actions.append(download);
    if (s.custom) actions.append(rename);
    if (s.custom) {
      const reset = button(p.confirmReset ? "Confirm clear" : "Clear slot", "danger quiet", () => {
        if (!p.confirmReset) {
          p.confirmReset = true;
          renderPlate(i);
          setTimeout(() => {
            p.confirmReset = false;
            renderPlate(i);
          }, 4000);
        } else {
          p.confirmReset = false;
          doReset(i);
        }
      });
      actions.append(reset);
    }
    for (const b of actions.children) b.disabled = working;
    body.append(actions);
  }

  if (p.msg) {
    const m = document.createElement("p");
    m.className = `msg ${p.msg.kind}`;
    m.textContent = p.msg.text;
    body.append(m);
  }
}

function setMode(i, mode, msg = null) {
  const p = state.plates[i];
  p.mode = mode;
  p.msg = msg;
  renderPlate(i);
}

// ---- Actions -----------------------------------------------------------------

async function stageFile(i, file) {
  const p = state.plates[i];
  try {
    const d = await decodeIR(file, state.info.dspRate, state.info.maxTaps, USED_TAPS);
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 31);
    p.staged = { file, name, ...d };
    setMode(i, "staged");
  } catch (e) {
    p.staged = null;
    setMode(i, "view", { kind: "err", text: e.message });
  }
}

async function doUpload(i) {
  const p = state.plates[i];
  const st = p.staged;
  const name = st.name.trim() || "Untitled IR";
  setMode(i, "working");
  try {
    await withBusy(async () => {
      await state.link.uploadSlot(i, st.taps, state.info.dspRate, name, (f) => {
        st.progress = f;
        if (st.progressEl) st.progressEl.value = f;
      });
      p.staged = null;
      await refresh(true);
    });
    setMode(i, "view", { kind: "ok", text: "Loaded onto the pedal." });
  } catch (e) {
    setMode(i, "staged", { kind: "err", text: `Couldn't load the IR: ${e.message}. Try again.` });
  }
}

async function doRename(i, name) {
  if (!name) return;
  setMode(i, "working");
  try {
    await withBusy(async () => {
      await state.link.rename(i, name);
      await refresh(true);
    });
    setMode(i, "view", { kind: "ok", text: "Renamed." });
  } catch (e) {
    setMode(i, "view", { kind: "err", text: `Couldn't rename: ${e.message}.` });
  }
}

async function doReset(i) {
  setMode(i, "working");
  try {
    await withBusy(async () => {
      await state.link.reset(i);
      await refresh(true);
    });
    const text = isEmpty(state.slots[i]) ? "Cleared. This position plays the dry pickup." : "Reset to the factory IR.";
    setMode(i, "view", { kind: "ok", text });
  } catch (e) {
    setMode(i, "view", { kind: "err", text: `Couldn't clear: ${e.message}.` });
  }
}

function doDownload(i) {
  const s = state.slots[i];
  const blob = encodeWav(state.taps[i], s.rate);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s.name.replace(/[\\/:*?"<>|]/g, "_") || "IR"}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Voicing (protocol 3+) ------------------------------------------

// Slider for each voicing value. `log`: the slider moves in equal ratios.
const VOICING_UI = {
  softAmount: { label: "Amount", step: 0.05, fmt: (v) => v.toFixed(2) },
  softFastMs: { label: "Attack detector", step: 0.05, log: true, fmt: (v) => `${v.toFixed(2)} ms` },
  softSlowMs: { label: "Note level detector", step: 0.5, log: true, fmt: (v) => `${v.toFixed(1)} ms` },
  softMaxCutDb: { label: "Most cut", step: 0.5, fmt: (v) => `${v.toFixed(1)} dB` },
  softKneeDb: { label: "Threshold", step: 0.25, fmt: (v) => `${v.toFixed(2)} dB` },
  reflLevelDb: { label: "Level", step: 0.5, fmt: (v) => `${v.toFixed(1).replace("-", "\u2212")} dB` },
  reflSize: { label: "Room size", step: 0.01, fmt: (v) => `${v.toFixed(2)}\u00d7` },
  reflDampingHz: { label: "Brightness", step: 50, log: true, fmt: (v) => `${(v / 1000).toFixed(1)} kHz` },
};
const SLIDER_STEPS = 1000; // resolution of log sliders
const SEND_INTERVAL_MS = 50; // at most ~20 slider updates a second
const HOLD_MS = 400; // Bypass all held at least this long = momentary

const voicingIO = { sending: false, changed: false, bypassChanged: false, last: 0, timer: null };

function toSlider(key, v) {
  const [lo, hi] = VOICING_RANGES[key];
  return VOICING_UI[key].log ? Math.round((Math.log(v / lo) / Math.log(hi / lo)) * SLIDER_STEPS) : v;
}
function fromSlider(key, x) {
  const [lo, hi] = VOICING_RANGES[key];
  const ui = VOICING_UI[key];
  const v = ui.log ? lo * Math.pow(hi / lo, x / SLIDER_STEPS) : x;
  return Math.min(hi, Math.max(lo, Math.round(v / ui.step) * ui.step));
}

function buildVoicing() {
  if (state.voicingBuilt) return;
  state.voicingBuilt = true;
  for (const box of document.querySelectorAll("#voicing .rows")) {
    for (const key of box.dataset.keys.split(" ")) {
      const ui = VOICING_UI[key];
      const [lo, hi] = VOICING_RANGES[key];
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      label.textContent = ui.label;
      label.htmlFor = `v_${key}`;
      const out = document.createElement("output");
      out.id = `o_${key}`;
      out.htmlFor = `v_${key}`;
      const inp = document.createElement("input");
      inp.type = "range";
      inp.id = `v_${key}`;
      inp.min = ui.log ? 0 : lo;
      inp.max = ui.log ? SLIDER_STEPS : hi;
      inp.step = ui.log ? 1 : ui.step;
      inp.addEventListener("input", () => onVoicingSlider(key, +inp.value));
      inp.addEventListener("change", () => sendVoicing({ changed: true, now: true }));
      row.append(label, out, inp);
      box.append(row);
    }
  }
  for (const id of ["softEnabled", "reflEnabled"]) {
    $(id).addEventListener("change", () => {
      state.voicing[id] = $(id).checked;
      sendVoicing({ changed: true, now: true });
    });
  }
  // Bypass all: a click toggles it; holding it bypasses only while held.
  const b = $("bypassAll");
  let press = null; // { t, started } for the current pointer press
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    press = { t: performance.now(), started: !state.bypass };
    setBypass(!state.bypass);
  });
  // (press stays set until the click that follows pointerup consumes it.)
  const release = () => {
    if (press?.started && performance.now() - press.t >= HOLD_MS) setBypass(false);
    if (press) press.started = false;
  };
  b.addEventListener("pointerup", release);
  b.addEventListener("pointercancel", () => {
    release();
    press = null; // no click follows a cancelled press
  });
  b.addEventListener("click", () => {
    if (press) press = null; // handled on pointerdown/up
    else setBypass(!state.bypass); // keyboard
  });
}

function renderVoicing() {
  const v = state.voicing;
  for (const key of Object.keys(VOICING_UI)) {
    $(`v_${key}`).value = toSlider(key, v[key]);
    $(`o_${key}`).textContent = VOICING_UI[key].fmt(v[key]);
  }
  for (const id of ["softEnabled", "reflEnabled"]) {
    $(id).checked = v[id];
    $(id).nextElementSibling.textContent = v[id] ? "On" : "Off";
  }
  $("featSoft").hidden = !state.voicingFeatures.softener;
  const reflOk = state.voicingFeatures.reflections;
  $("featRefl").classList.toggle("unavailable", !reflOk);
  $("reflNote").hidden = reflOk;
  $("bypassAll").setAttribute("aria-pressed", String(state.bypass));
}

function onVoicingSlider(key, x) {
  const v = state.voicing;
  v[key] = fromSlider(key, x);
  // The note-level detector must stay slower than the attack detector.
  if (key === "softFastMs" && v.softSlowMs <= v.softFastMs)
    v.softSlowMs = Math.min(VOICING_RANGES.softSlowMs[1], Math.ceil((v.softFastMs + 0.5) * 2) / 2);
  if (key === "softSlowMs" && v.softSlowMs <= v.softFastMs)
    v.softFastMs = Math.max(VOICING_RANGES.softFastMs[0], v.softSlowMs - 0.5);
  renderVoicing();
  sendVoicing({ changed: true });
}

function setBypass(on) {
  if (state.bypass === on) return;
  state.bypass = on;
  renderVoicing();
  sendVoicing({ bypassChanged: true, now: true });
}

function voicingError(text) {
  $("voicingErr").textContent = text;
  $("voicingErr").hidden = !text;
}

// Send the latest voicing state, throttled; requests never overlap. `changed`:
// values or enables changed (save them). `bypassChanged`: only what's playing.
function sendVoicing({ changed = false, bypassChanged = false, now = false } = {}) {
  const io = voicingIO;
  io.changed ||= changed;
  io.bypassChanged ||= bypassChanged;
  if (io.sending || !state.link || !state.voicing) return;
  const wait = now ? 0 : SEND_INTERVAL_MS - (performance.now() - io.last);
  clearTimeout(io.timer);
  if (wait > 0) {
    io.timer = setTimeout(() => sendVoicing(), wait);
    return;
  }
  if (!io.changed && !io.bypassChanged) return;
  const save = io.changed;
  io.changed = io.bypassChanged = false;
  io.sending = true;
  io.last = performance.now();
  const v = { ...state.voicing };
  withBusy(async () => {
    if (save) await state.link.setVoicing(v, true);
    if (state.bypass) await state.link.setVoicing({ ...v, softEnabled: false, reflEnabled: false }, false);
    else if (!save) await state.link.setVoicing(v, false); // back to the saved sound
  })
    .then(() => voicingError(""))
    .catch((e) => voicingError(`Couldn't update the pedal: ${e.message}.`))
    .finally(() => {
      io.sending = false;
      if (io.changed || io.bypassChanged) sendVoicing();
    });
}

async function loadVoicing() {
  try {
    const { voicing, preview, features } = await state.link.getVoicing();
    state.voicing = voicing;
    state.voicingFeatures = features;
    state.bypass = false;
    // A preview left playing (page closed mid-A/B): go back to the saved sound.
    if (preview) await state.link.setVoicing(voicing, false);
    buildVoicing();
    renderVoicing();
    voicingError("");
    $("voicing").hidden = false;
  } catch (e) {
    $("voicing").hidden = true;
  }
}

// ---- Response curve ------------------------------------------------------------

function drawCurve(svg, taps, rate, name) {
  const W = 300, H = 84, lo = 40, hi = 16000, range = 24;
  const x = (f) => (Math.log(f / lo) / Math.log(hi / lo)) * W;
  const y = (db) => H / 2 - (Math.max(-range, Math.min(range, db)) / range) * (H / 2 - 6);
  const ns = "http://www.w3.org/2000/svg";
  svg.textContent = "";
  svg.setAttribute("aria-label", `Frequency response of ${name}`);
  for (const f of [100, 1000, 10000]) {
    const l = document.createElementNS(ns, "line");
    l.setAttribute("class", "grid");
    l.setAttribute("x1", x(f));
    l.setAttribute("x2", x(f));
    l.setAttribute("y1", 0);
    l.setAttribute("y2", H);
    svg.append(l);
  }
  const zero = document.createElementNS(ns, "line");
  zero.setAttribute("class", "grid");
  zero.setAttribute("x1", 0);
  zero.setAttribute("x2", W);
  zero.setAttribute("y1", y(0));
  zero.setAttribute("y2", y(0));
  svg.append(zero);
  if (!taps) return;
  const pts = response(taps.subarray(0, Math.round((USED_TAPS * rate) / 48000)), rate);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("class", "line");
  path.setAttribute("d", pts.map((p, k) => `${k ? "L" : "M"}${x(p.f).toFixed(1)},${y(p.db).toFixed(1)}`).join(""));
  svg.append(path);
}

// ---- Start -----------------------------------------------------------------------

if (!("serial" in navigator)) {
  $("unsupported").hidden = false;
  $("connect").disabled = true;
} else {
  $("connect").addEventListener("click", async () => {
    let port;
    try {
      port = await navigator.serial.requestPort({ filters: FILTERS });
    } catch {
      return; // chooser dismissed
    }
    await connect(port);
  });
  $("disconnect").addEventListener("click", () => disconnect());
  navigator.serial.addEventListener("disconnect", async (e) => {
    if (e.target === state.port) {
      await disconnect();
      showError("The pedal was disconnected. Plug it back in and click Connect pedal.");
    }
  });
  // A pedal this page was allowed to use before reconnects without the chooser.
  navigator.serial.addEventListener("connect", async (e) => {
    if (!state.port) await connect(e.target, true);
  });
  navigator.serial.getPorts().then(async (ports) => {
    const known = ports.find((p) => {
      const i = p.getInfo();
      return i.usbVendorId === FILTERS[0].usbVendorId && i.usbProductId === FILTERS[0].usbProductId;
    });
    if (known && !state.port) await connect(known, true);
  });
}
