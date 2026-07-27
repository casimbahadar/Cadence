/* Shared harness for Cadence's SHELL tests (DOM, storage, input, UI flow).
   CORE logic is covered separately by cadence.tests.mjs.

   Why this exists: every shell suite needs the same ~50 lines of AudioContext,
   canvas and IndexedDB mocks. Duplicating them meant four copies drifting apart.

   Usage:
     import { makeDom, ok, section, summary } from "./shell-harness.mjs";
     const env = await makeDom();
     ok(cond, "what should be true");
     summary();                        // prints counts, exits non-zero on failure
*/
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";

let pass = 0, fail = 0;
export function section(name) { console.log("\n-- " + name + " --"); }
export function ok(cond, msg) {
  if (cond) { pass++; console.log("  ok  " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
  return !!cond;
}
export function summary() {
  console.log("\n================================");
  console.log("SHELL PASS " + pass + " / FAIL " + fail);
  process.exit(fail ? 1 : 0);
}

/* A short synthesized signal: a sustained drone with kick thumps over it.
   Deliberately the case spectral flux struggles with, so charts built from it
   exercise the boom detector rather than the melodic path. */
export function testSignal(sampleRate = 44100, seconds = 6, hits = [1, 2, 3, 4]) {
  const mono = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < mono.length; i++) mono[i] = Math.sin(2 * Math.PI * 400 * i / sampleRate) * 0.1;
  for (const t of hits) {
    const s0 = Math.round(t * sampleRate);
    for (let j = 0; j < sampleRate * 0.08 && s0 + j < mono.length; j++)
      mono[s0 + j] += Math.sin(2 * Math.PI * 60 * j / sampleRate) * 0.8 * Math.exp(-j / (sampleRate * 0.05));
  }
  return { mono, sampleRate, duration: seconds };
}

/* Builds a jsdom instance running the real cadence.html.
   opts.file          which build to load (default index.html)
   opts.audio         { mono, sampleRate, duration } returned by decodeAudioData
   opts.failBytes     an arrayBuffer of exactly this length makes decoding throw,
                      so tests can drive the corrupt-file path
   Returns { dom, w, d, idb, decodeCount, click, fireFiles, toasts } */
export async function makeDom(opts = {}) {
  // default: the build one level up from tests/, so any CWD works
  const file = opts.file || new URL("../index.html", import.meta.url);
  const html = readFileSync(file, "utf8");
  const audio = opts.audio || testSignal();
  const idb = new Map();
  const counters = { decodes: 0 };

  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(win) {
      win.AudioContext = class {
        constructor() { this.currentTime = 5; this.state = "running"; this.sampleRate = audio.sampleRate; }
        resume() {}
        createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createOscillator() { return { type: "", frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, detune: { value: 0 }, connect() {}, start() {}, stop() {} }; }
        createBuffer(c, l) { return { getChannelData() { return new Float32Array(l); } }; }
        createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
        createBiquadFilter() { return { type: "", frequency: { value: 0 }, connect() {} }; }
        createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect() {} }; }
        decodeAudioData(ab) {
          counters.decodes++;
          if (opts.failBytes && ab && ab.byteLength === opts.failBytes)
            return Promise.reject(new Error("corrupt audio"));
          return Promise.resolve({
            length: audio.mono.length, duration: audio.duration,
            sampleRate: audio.sampleRate, numberOfChannels: 1,
            getChannelData: () => audio.mono
          });
        }
        get destination() { return {}; }
      };
      win.HTMLCanvasElement.prototype.getContext = () => ({
        setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {},
        arcTo() {}, closePath() {}, fill() {}, stroke() {}, fillText() {},
        createLinearGradient() { return { addColorStop() {} }; },
        set font(v) {}, set textAlign(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}
      });
      // minimal IndexedDB: one store, synchronous-ish, backed by a Map
      win.indexedDB = {
        open() {
          const req = {};
          setTimeout(() => {
            const db = {
              close() {},
              createObjectStore() {},
              transaction() {
                const tx = {};
                tx.objectStore = () => ({
                  put(v, k) { idb.set(k, v); },
                  get(k) {
                    const rq = {};
                    setTimeout(() => { rq.result = idb.get(k) || null; rq.onsuccess && rq.onsuccess(); }, 0);
                    return rq;
                  },
                  delete(k) { idb.delete(k); }
                });
                setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
                return tx;
              }
            };
            req.result = db;
            req.onupgradeneeded && req.onupgradeneeded();
            req.onsuccess && req.onsuccess();
          }, 0);
          return req;
        }
      };
    }
  });

  await wait(300);
  const w = dom.window, d = w.document;

  // capture toasts so tests can assert on user-visible messaging
  w.eval("window.__toasts = []; (function(){ const o = toast; toast = function(m){ window.__toasts.push(m); return o(m); }; })();");

  return {
    dom, w, d, idb,
    get decodeCount() { return counters.decodes; },
    resetDecodeCount() { counters.decodes = 0; },
    click: (el) => el.dispatchEvent(new w.Event("click", { bubbles: true })),
    pointer: (el, type, pointerId) => {
      const ev = new w.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "pointerId", { value: pointerId });
      el.dispatchEvent(ev);
      return ev;
    },
    fireFiles: (inputId, files) => {
      const input = d.getElementById(inputId);
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    jsonFile: (name, obj) => {
      const text = JSON.stringify(obj);
      const f = new w.File([text], name, { type: "application/json" });
      f.text = () => Promise.resolve(text);
      return f;
    },
    audioFile: (name, bytes) => {
      const f = new w.File([new Uint8Array(bytes)], name, { type: "audio/mpeg" });
      f.arrayBuffer = () => Promise.resolve(new ArrayBuffer(bytes));
      return f;
    },
    toasts: () => w.eval("JSON.stringify(window.__toasts)"),
    clearToasts: () => w.eval("window.__toasts = []"),
    lastToast: () => w.eval("window.__toasts[window.__toasts.length-1] || ''")
  };
}

export const wait = (ms) => new Promise(r => setTimeout(r, ms));
