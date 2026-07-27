#!/usr/bin/env node
/* Cadence detector validation — measures how well audio-import charts track a
   real recording, using ground truth computed by a DIFFERENT method than the
   detector under test. This is the tool that settled the "booms don't match the
   notes" problem: it proved the flux detector heard only ~60% of the kicks, and
   later proved the boom detector hears them all.
 *
 * The principle worth keeping: never grade a detector with itself. Ground truth
 * here is a time-domain low-band envelope peak finder that shares no code with
 * the spectral detectors it judges.
 *
 * Usage:
 *   node detector-metrics.mjs <audio-file>        (needs ffmpeg on PATH)
 *   node detector-metrics.mjs <file.f32>          (raw mono float32 @ 44100)
 *   node detector-metrics.mjs <file> --build other.html
 *
 * Reference figures from Fire Cross (OC ReMix, 6:45, dense guitar rock), the
 * file these detectors were tuned against:
 *   ground-truth booms      988  (2.43/s)
 *   boom detector recall    100%
 *   Easy precision          100%   (every Easy note lands on an audible thump)
 *   Easy recall             ~61%   (Easy samples the drum line, doesn't transcribe it)
 *   Normal boom recall      100%
 * A clean piano or orchestral recording should score higher; a denser mix lower.
 */
import { readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith("--"));
const buildIdx = args.indexOf("--build");
const build = buildIdx >= 0 ? args[buildIdx + 1]
  : fileURLToPath(new URL("../index.html", import.meta.url));
if (!input) { console.error("usage: node detector-metrics.mjs <audio-file|file.f32> [--build cadence.html]"); process.exit(2); }
if (!existsSync(build)) { console.error("build not found: " + build); process.exit(2); }

const CORE = new Function(
  readFileSync(build, "utf8").match(/\/\* CORE-START \*\/([\s\S]*?)\/\* CORE-END \*\//)[1] + "\nreturn CORE;")();

const SR = 44100;
let pcmPath = input, temp = null;
if (!input.endsWith(".f32")) {
  temp = pcmPath = "/tmp/cadence-metrics-" + process.pid + ".f32";
  try {
    execSync(`ffmpeg -hide_banner -loglevel error -i ${JSON.stringify(input)} -ac 1 -ar ${SR} -f f32le ${JSON.stringify(pcmPath)}`);
  } catch (e) { console.error("ffmpeg failed — install it, or pass a raw .f32 file"); process.exit(2); }
}
const raw = readFileSync(pcmPath);
const mono = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const dur = mono.length / SR;

/* ---- GROUND TRUTH: independent of every detector below ----
   ~150Hz moving-average lowpass, 10ms RMS envelope, prominent local maxima
   with a 250ms refractory gap. This is "what a listener calls a thump". */
function groundTruthBooms() {
  const K = 300, hop = 441, nF = Math.floor(mono.length / hop);
  const lp = new Float32Array(mono.length);
  let acc = 0;
  for (let i = 0; i < mono.length; i++) { acc += mono[i]; if (i >= K) acc -= mono[i - K]; lp[i] = acc / K; }
  const env = new Float32Array(nF);
  for (let f = 0; f < nF; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) s += lp[i] * lp[i]; env[f] = Math.sqrt(s / hop); }
  const out = [];
  for (let f = 15; f < nF - 15; f++) {
    let isMax = true, sum = 0, c = 0;
    for (let k = f - 15; k <= f + 15; k++) { if (env[k] > env[f]) isMax = false; sum += env[k]; c++; }
    if (!isMax || env[f] <= (sum / c) * 1.35) continue;
    const t = f * 0.01;
    if (out.length && t - out[out.length - 1] < 0.25) continue;
    out.push(t);
  }
  return out;
}

const t0 = Date.now();
const booms = CORE.detectBooms(mono, SR);
const perc = CORE.detectPercussion(mono, SR);
const onsets = CORE.detectOnsets(mono, SR);
const sustain = CORE.sustainEnvelope(mono, SR);
const analysisMs = Date.now() - t0;
const truth = groundTruthBooms();
const song = CORE.audioSongFromOnsets(onsets, dur, "metrics", input, perc, booms, sustain);

const near = (t, arr, w) => arr.some(x => Math.abs(x - t) <= w);
const pct = (x) => (x * 100).toFixed(1) + "%";

console.log("\n" + input + "  —  " + dur.toFixed(1) + "s  (" + (dur / 60).toFixed(2) + " min)");
console.log("build: " + build);
console.log("\nanalysis time: " + (analysisMs / 1000).toFixed(1) + "s" +
  (analysisMs / 1000 > dur * 0.05 ? "  <-- slow relative to song length" : ""));
console.log("ground-truth booms: " + truth.length + "  (" + (truth.length / dur).toFixed(2) + "/s)");
console.log("detectors: booms " + booms.length + " | percussion " + perc.length + " | flux onsets " + onsets.length);
console.log("boom detector recall vs ground truth: " +
  pct(truth.filter(b => near(b, booms.map(x => x.t), 0.06)).length / truth.length));

const rings = song.tracks[0].notes.map(n => n.d).sort((a, b) => a - b);
console.log("measured sustain: median " + rings[Math.floor(rings.length / 2)].toFixed(2) + "s | >=0.55s " +
  rings.filter(r => r >= 0.55).length + "/" + rings.length);

console.log("\ndiff    notes  notes/s  boom-precision  boom-recall  holds  max-concurrent-holds");
for (const diff of ["easy", "normal", "hard"]) {
  const c = CORE.buildChart(song, diff, 4);
  const holds = c.filter(n => n.d > 0);
  let mx = 0;
  for (const s of holds) {
    let a = 0;
    for (const g of holds) if (g.t <= s.t && s.t < g.t + g.d) a++;
    mx = Math.max(mx, a);
  }
  const prec = c.filter(n => near(n.t, truth, 0.06)).length / c.length;
  const rec = truth.filter(b => near(b, c.map(n => n.t), 0.06)).length / truth.length;
  console.log(diff.padEnd(8) + String(c.length).padStart(5) + "   " + (c.length / dur).toFixed(2).padStart(6) +
    "   " + pct(prec).padStart(13) + "  " + pct(rec).padStart(11) + "   " +
    String(holds.length).padStart(4) + "   " + String(mx).padStart(6));
}
const adv = CORE.importAdvisory(onsets, dur);
console.log("\nimport advisory: " + (adv || "(none — analysis looks healthy)"));
console.log("\nreading the numbers:");
console.log("  precision = share of chart notes that land on an audible thump. Easy should be very high.");
console.log("  recall    = share of thumps that got a note. Easy is deliberately sparse; Normal should be high.");
console.log("  concurrent holds must stay <= 2 on audio charts, or the chart asks for more fingers than exist.");
if (temp) try { unlinkSync(temp); } catch (e) {}
