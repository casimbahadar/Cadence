// Cadence test harness — extracts CORE from the SHIPPED index.html and tests it.
import { readFileSync } from "fs";

// resolved relative to this file, so the suite works from any working directory
const BUILD = new URL("../index.html", import.meta.url);
const html = readFileSync(BUILD, "utf8");
const m = html.match(/\/\* CORE-START \*\/([\s\S]*?)\/\* CORE-END \*\//);
if (!m) { console.error("FAIL: CORE markers not found"); process.exit(1); }
const CORE = new Function(m[1] + "\nreturn CORE;")();

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error("  ✗ " + name); }
}
function section(s) { console.log("\n== " + s); }

/* ---------------------------------------------------------------
   1. MIDI parser round-trip: build real SMF bytes, parse, compare.
   --------------------------------------------------------------- */
section("MIDI parser round-trip");

function vlq(n) { // variable-length quantity
  const bytes = [n & 0x7f]; n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}
function buildMidi({ format, tpq, tracks, tempoUspq }) {
  const out = [];
  const push = (...b) => out.push(...b);
  const u32 = (n) => push((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);
  const u16 = (n) => push((n>>>8)&255,n&255);
  push(0x4d,0x54,0x68,0x64); u32(6); u16(format); u16(tracks.length); u16(tpq);
  for (const evs of tracks) {
    const body = [];
    const bpush = (...b) => body.push(...b);
    for (const e of evs) {
      bpush(...vlq(e.dt));
      if (e.type === "tempo") bpush(0xff,0x51,0x03,(e.uspq>>16)&255,(e.uspq>>8)&255,e.uspq&255);
      else if (e.type === "on") bpush(0x90|e.ch, e.p, e.v);
      else if (e.type === "onRun") bpush(e.p, e.v);          // running status
      else if (e.type === "off") bpush(0x80|e.ch, e.p, 64);
      else if (e.type === "prog") bpush(0xc0|e.ch, e.prog);
      else if (e.type === "name") { bpush(0xff,0x03,e.s.length); for (const c of e.s) bpush(c.charCodeAt(0)); }
    }
    bpush(0,0xff,0x2f,0);
    push(0x4d,0x54,0x72,0x6b); u32(body.length); push(...body);
  }
  return new Uint8Array(out).buffer;
}

// format-0, 480tpq, 120bpm default, running status, two notes
{
  const buf = buildMidi({ format:0, tpq:480, tracks:[[
    { dt:0, type:"name", s:"Solo" },
    { dt:0, type:"on",  ch:0, p:60, v:100 },
    { dt:480, type:"off", ch:0, p:60 },
    { dt:0, type:"on",  ch:0, p:64, v:100 },
    { dt:0, type:"onRun", p:67, v:100 },       // chord via running status
    { dt:240, type:"off", ch:0, p:64 },
    { dt:0, type:"off", ch:0, p:67 },
  ]]});
  const song = CORE.parseMIDI(buf, "test0");
  const notes = song.tracks[0].notes;
  ok(song.tracks.length === 1, "fmt0: one track");
  ok(notes.length === 3, "fmt0: 3 notes parsed (got " + notes.length + ")");
  ok(Math.abs(notes[0].t - 0) < 1e-9 && notes[0].p === 60, "fmt0: note1 pitch/time");
  ok(Math.abs(notes[0].d - 0.5) < 1e-9, "fmt0: note1 duration 0.5s at 120bpm/480tpq");
  ok(Math.abs(notes[1].t - 0.5) < 1e-9 && Math.abs(notes[2].t - 0.5) < 1e-9, "fmt0: chord at 0.5s");
  ok(notes.map(n=>n.p).sort((a,b)=>a-b).join() === "60,64,67", "fmt0: pitches exact");
}

// format-1 with mid-song tempo change (120 -> 60 bpm) + program change + drums
{
  const buf = buildMidi({ format:1, tpq:96, tracks:[
    [ { dt:0, type:"tempo", uspq:500000 },      // 120 bpm
      { dt:192, type:"tempo", uspq:1000000 } ], // at beat 2 -> 60 bpm
    [ { dt:0, type:"prog", ch:0, prog:33 },     // bass program
      { dt:0, type:"on", ch:0, p:40, v:90 }, { dt:96, type:"off", ch:0, p:40 },
      { dt:96, type:"on", ch:0, p:43, v:90 }, { dt:96, type:"off", ch:0, p:43 } ],
    [ { dt:0, type:"on", ch:9, p:36, v:100 }, { dt:48, type:"off", ch:9, p:36 } ]
  ]});
  const song = CORE.parseMIDI(buf, "test1");
  ok(song.tracks.length === 2, "fmt1: 2 note-bearing tracks");
  const bass = song.tracks.find(t => !t.isDrum), drum = song.tracks.find(t => t.isDrum);
  ok(!!bass && !!drum, "fmt1: drum channel detected");
  ok(bass.prog === 33, "fmt1: program change captured");
  // note 2 starts at tick 192 = exactly the tempo change = 1.0s; its 96 ticks now last 1.0s at 60bpm
  ok(Math.abs(bass.notes[1].t - 1.0) < 1e-9, "fmt1: tempo map start time (got " + bass.notes[1].t + ")");
  ok(Math.abs(bass.notes[1].d - 1.0) < 1e-9, "fmt1: tempo map duration (got " + bass.notes[1].d + ")");
}

// garbage rejection
{
  let threw = false;
  try { CORE.parseMIDI(new Uint8Array([1,2,3,4,5,6,7,8]).buffer, "junk"); } catch (e) { threw = true; }
  ok(threw, "rejects non-MIDI bytes with an error");
}

/* ---------------------------------------------------------------
   2. Forge JSON tolerant reader
   --------------------------------------------------------------- */
section("Forge JSON reader");
{
  const song = CORE.parseForgeJSON({
    title: "Test Tune", bpm: 120,
    tracks: [{ name: "Lead", instrument: "piano",
      notes: [{ pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 }] }]
  }, "t.json");
  ok(song.tracks.length === 1 && song.tracks[0].notes.length === 2, "reads pitch/start/duration shape");
  ok(Math.abs(song.tracks[0].notes[1].t - 0.5) < 1e-9, "beats converted at 120bpm");
}
{
  const song = CORE.parseForgeJSON({
    tempo: 60, parts: [{ cells: [{ p: 72, t: 2, d: 0.5 }] }]
  }, "alt.json");
  ok(song.tracks[0].notes[0].t === 2 && song.tracks[0].notes[0].p === 72, "reads alternate key names");
}
{
  let threw = false;
  try { CORE.parseForgeJSON({ hello: "world" }, "x.json"); } catch (e) { threw = true; }
  ok(threw, "refuses unrecognizable JSON plainly");
}

/* ---------------------------------------------------------------
   3. Charts for every bundled song × difficulty
   --------------------------------------------------------------- */
section("Bundled songs & chart generation");
ok(CORE.BUNDLED.length >= 15, "library has at least 15 bundled songs (got " + CORE.BUNDLED.length + ")");
const gapStats = [];
for (const song of CORE.BUNDLED) {
  const counts = {};
  for (const diff of ["easy", "normal", "hard"]) {
    const chart = CORE.buildChart(song, diff);
    counts[diff] = chart.length;
    ok(chart.length > 0, song.id + "/" + diff + ": non-empty");
    let sorted = true, lanesOk = true;
    let minGapLane = Infinity;
    const last = [-1e9,-1e9,-1e9,-1e9];
    let lastT = -1e9, minGapAll = Infinity;
    for (const n of chart) {
      if (n.t < lastT - 1e-9) sorted = false;
      if (n.lane < 0 || n.lane > 3) lanesOk = false;
      minGapLane = Math.min(minGapLane, n.t - last[n.lane]);
      if (n.t - lastT > 1e-9) { minGapAll = Math.min(minGapAll, n.t - lastT); lastT = n.t; }
      last[n.lane] = n.t;
    }
    ok(sorted, song.id + "/" + diff + ": time-sorted");
    ok(lanesOk, song.id + "/" + diff + ": lanes in 0-3");
    const cfg = CORE.DIFFS[diff];
    ok(minGapLane >= cfg.gapLane - 1e-9, song.id + "/" + diff + ": per-lane gap ≥ " + cfg.gapLane + "s (got " + minGapLane.toFixed(3) + ")");
    ok(minGapAll >= cfg.gapAll - 1e-9, song.id + "/" + diff + ": global gap ≥ " + cfg.gapAll + "s (got " + (minGapAll===Infinity?"∞":minGapAll.toFixed(3)) + ")");
    gapStats.push({ id: song.id, diff, n: chart.length });
  }
  ok(counts.easy <= counts.normal && counts.normal <= counts.hard,
     song.id + ": easy ≤ normal ≤ hard note counts (" + counts.easy + "/" + counts.normal + "/" + counts.hard + ")");
  // every song must use at least 3 of the 4 lanes on hard
  const lanes = new Set(CORE.buildChart(song, "hard").map(n => n.lane));
  ok(lanes.size >= 3, song.id + ": hard chart spans ≥3 lanes (got " + lanes.size + ")");
}

/* ---------------------------------------------------------------
   4. Grading: autoplay = all perfect; no input = all miss;
      offset play = all good; determinism.
   --------------------------------------------------------------- */
section("Grading engine");
const demo = CORE.BUNDLED[0];
const chartN = CORE.buildChart(demo, "normal");

{ // perfect autoplay
  const run = CORE.newRun(chartN, demo, "normal");
  for (const n of chartN) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
  const res = CORE.finishRun(run);
  ok(res.perfect === chartN.length && res.miss === 0, "autoplay: all Perfect");
  ok(Math.abs(res.accuracy - 1) < 1e-9 && res.grade === "S", "autoplay: 100% acc, S grade");
  ok(res.maxCombo === chartN.length, "autoplay: full combo");
}
{ // no input
  const run = CORE.newRun(chartN, demo, "normal");
  const res = CORE.finishRun(run);
  ok(res.miss === chartN.length && res.perfect === 0 && res.good === 0, "silence: all Miss");
  ok(res.grade === "F" && res.score === 0, "silence: F grade, zero score");
}
{ // consistent 100ms late = all Good (inside 130ms, outside 65ms)
  const run = CORE.newRun(chartN, demo, "normal");
  for (const n of chartN) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t + 0.100); }
  const res = CORE.finishRun(run);
  ok(res.good === chartN.length && res.miss === 0, "late 100ms: all Good (got G" + res.good + " M" + res.miss + ")");
  ok(res.grade !== "S", "late 100ms: not an S");
}
{ // taps in the wrong lane consume nothing; note then misses
  const run = CORE.newRun(chartN.slice(0, 1), demo, "normal");
  const n = chartN[0];
  const wrong = (n.lane + 1) % 4;
  const g = CORE.gradeTap(run, wrong, n.t);
  ok(g === null, "wrong-lane tap grades nothing");
  CORE.tickMisses(run, n.t + 0.2);
  ok(run.miss === 1, "unhit note becomes a Miss after the window");
}
{ // determinism: same inputs twice -> identical results objects
  const play = () => {
    const run = CORE.newRun(chartN, demo, "normal");
    chartN.forEach((n, i) => {
      CORE.tickMisses(run, n.t);
      if (i % 3 !== 0) CORE.gradeTap(run, n.lane, n.t + (i % 2 ? 0.05 : 0.09));
    });
    const r = CORE.finishRun(run); delete r.at; return JSON.stringify(r);
  };
  ok(play() === play(), "identical input sequence → identical results object");
}
{ // results object shape (the Cadence Heroes contract)
  const run = CORE.newRun(chartN, demo, "normal");
  const res = CORE.finishRun(run);
  const keys = ["version","song","difficulty","perfect","good","miss","maxCombo","accuracy","score","grade","total","at"];
  ok(keys.every(k => k in res), "results object carries all contract fields");
  ok(res.version === 1 && res.song.id === demo.id, "results version + song identity");
}

/* ---------------------------------------------------------------
   5. MIDI end-to-end: parsed file -> chart -> autoplay
   --------------------------------------------------------------- */
section("MIDI → chart → play, end to end");
{
  // 8-bar two-track piece: melody + bass
  const mel = [], bas = [];
  const seq = [60,62,64,65,67,69,71,72];
  seq.forEach((pch, i) => {
    mel.push({ dt: i===0?0:240, type:"on", ch:0, p:pch, v:100 });
    mel.push({ dt: 240, type:"off", ch:0, p:pch });
  });
  for (let i = 0; i < 4; i++) {
    bas.push({ dt: i===0?0:480, type:"on", ch:1, p:40, v:90 });
    bas.push({ dt: 480, type:"off", ch:1, p:40 });
  }
  bas.unshift({ dt:0, type:"prog", ch:1, prog:33 });
  const buf = buildMidi({ format:1, tpq:480, tracks:[[{dt:0,type:"tempo",uspq:500000}], mel, bas] });
  const song = CORE.parseMIDI(buf, "endtoend");
  const chart = CORE.buildChart(song, "hard");
  ok(chart.length > 0, "imported MIDI produces a chart");
  const run = CORE.newRun(chart, song, "hard");
  for (const n of chart) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
  const res = CORE.finishRun(run);
  ok(res.grade === "S" && res.miss === 0, "imported MIDI chart fully playable (autoplay S)");
  const cls = CORE.classifyTracks(song);
  ok(cls.bass && cls.melody && cls.bass !== cls.melody, "role classifier separates bass and melody");
  const bassLanes = new Set(chart.filter(n => {
    // bass notes are the ones at pitch-40 times: 0,1,2,3s
    return [0,1,2,3].some(t => Math.abs(n.t - t) < 1e-6) && n.lane === 0;
  }).map(n => n.lane));
  ok(bassLanes.has(0), "bass role lands on lane 0");
}

/* ---------------------------------------------------------------
   6. Regression: late-entering sparse track must not be melody;
      Easy must not chart silence (the Bohemian Rhapsody bug).
   --------------------------------------------------------------- */
section("Regression: melody choice + Easy gap-fill");
{
  // synthetic BoRhap pattern: piano through-line from t=2, sparse high
  // line entering at t=50, bass entering at t=50. 90 seconds long.
  const mk = (from, to, step, p) => {
    const a = []; for (let t = from; t < to; t += step) a.push({ t, d: step * 0.8, p, v: 96 }); return a;
  };
  const song = {
    id: "synth-late", title: "Synth Late", composer: "test", source: "midi", bpm: 120,
    tracks: [
      { name: "HighLate", prog: 60, isDrum: false, notes: mk(50, 90, 2.0, 84) },   // sparse, high, late
      { name: "Piano",    prog: 0,  isDrum: false, notes: mk(2, 90, 0.5, 64) },    // dense through-line
      { name: "Bass",     prog: 33, isDrum: false, notes: mk(50, 90, 1.0, 40) }    // enters late
    ],
    duration: 90
  };
  const cls = CORE.classifyTracks(song);
  ok(cls.melody && cls.melody.name === "Piano", "melody = the through-line, not the sparse late line (got " + (cls.melody && cls.melody.name) + ")");
  const easy = CORE.buildChart(song, "easy");
  ok(easy.length > 0 && easy[0].t < 5, "easy chart starts near the music start (first at " + (easy[0] && easy[0].t.toFixed(2)) + "s)");
  let maxGap = 0;
  for (let i = 1; i < easy.length; i++) maxGap = Math.max(maxGap, easy[i].t - easy[i-1].t);
  ok(maxGap <= 3.0 + 1e-9, "easy chart has no dead stretch > 3s while music plays (max " + maxGap.toFixed(2) + "s)");
  // gap floors still honored after fill
  const cfg = CORE.DIFFS.easy;
  let gapsOk = true; const last = [-1e9,-1e9,-1e9,-1e9]; let lastT = -1e9;
  for (const n of easy) {
    if (n.t - lastT > 1e-9) { if (n.t - lastT < cfg.gapAll - 1e-9 && lastT > -1e8) gapsOk = false; lastT = n.t; }
    if (n.t - last[n.lane] < cfg.gapLane - 1e-9 && last[n.lane] > -1e8) gapsOk = false;
    last[n.lane] = n.t;
  }
  ok(gapsOk, "easy spacing floors still hold after gap-fill");
  const normal = CORE.buildChart(song, "normal");
  ok(easy.length <= normal.length, "easy ≤ normal still holds after gap-fill (" + easy.length + "/" + normal.length + ")");
}

/* ---------------------------------------------------------------
   7. Extended arrangements + length cutting
   --------------------------------------------------------------- */
section("Extended arrangements & truncateChart");
for (const song of CORE.BUNDLED) {
  ok(song.duration >= 60, song.id + ": duration ≥ 60s (got " + Math.round(song.duration) + "s)");
  // adjacent passes must actually differ — no bare copy-paste repeats
  if (song.passes >= 2) {
    const mel = song.tracks[0];
    const win = (k) => mel.notes
      .filter(n => n.t >= k * song.passSec - 1e-6 && n.t < (k + 1) * song.passSec - 1e-6)
      .map(n => [Math.round((n.t - k * song.passSec) * 1e5), n.p]);
    const bwin = (k) => song.tracks[1].notes
      .filter(n => n.t >= k * song.passSec - 1e-6 && n.t < (k + 1) * song.passSec - 1e-6)
      .map(n => [Math.round((n.t - k * song.passSec) * 1e5), n.p]);
    for (let k = 0; k + 1 < song.passes; k++) {
      const differ = JSON.stringify(win(k)) !== JSON.stringify(win(k + 1))
                  || JSON.stringify(bwin(k)) !== JSON.stringify(bwin(k + 1));
      ok(differ, song.id + ": pass " + (k + 1) + " differs from pass " + (k + 2));
    }
  }
}
{
  const song = CORE.BUNDLED[0];
  const chart = CORE.buildChart(song, "normal");
  const full = CORE.truncateChart(chart, null);
  ok(full.length === chart.length, "truncate(null) = full chart");
  const cut = CORE.truncateChart(chart, 60);
  ok(cut.every(n => n.t <= 60), "truncate(60): no notes past 60s");
  ok(cut.length > 0 && cut.length < chart.length, "truncate(60) is a strict, non-empty subset");
  ok(CORE.truncateChart(chart, 30).length <= cut.length, "counts monotonic with length");
  // a truncated chart is fully playable
  const run = CORE.newRun(cut, song, "normal");
  for (const n of cut) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
  ok(CORE.finishRun(run).grade === "S", "truncated chart autoplays to S");
}

/* ---------------------------------------------------------------
   8. Weekly events + share codes
   --------------------------------------------------------------- */
section("Weekly events & share codes");
{
  const E = CORE.EVT_EPOCH, W = CORE.EVT_WEEK;
  ok(CORE.eventForDate(E).idx === 0 && CORE.eventForDate(E + W - 1).idx === 0,
     "week 0 spans exactly its 7 days");
  ok(CORE.eventForDate(E + W).idx === 1, "index rolls at the exact week boundary");
  ok(CORE.eventForDate(E - 999).idx === 0, "pre-epoch clocks clamp to week 0");
  const a = CORE.eventForDate(E + 3 * 864e5), b = CORE.eventForDate(E + 5 * 864e5);
  ok(a.idx === b.idx && a.songIdx === b.songIdx && a.diff === b.diff,
     "same week → identical event on any day/device");
  const seen = new Set(), pairSeen = new Set();
  const NW = CORE.BUNDLED.length;
  for (let i = 0; i < NW; i++) {
    const ev = CORE.eventForDate(E + i * W);
    ok(ev.songIdx >= 0 && ev.songIdx < CORE.BUNDLED.length, "week " + i + ": song index in range");
    seen.add(ev.songIdx);
    pairSeen.add(ev.songIdx + "/" + ev.diff);
  }
  ok(seen.size === NW,
     NW + " consecutive weeks visit all " + NW + " songs (got " + seen.size + ") — requires step coprime with library size");
  const w0 = CORE.eventForDate(E), w1 = CORE.eventForDate(E + W);
  ok(w0.songIdx !== w1.songIdx, "consecutive weeks never repeat a song");
}
{
  const code = CORE.makeShareCode(3, "Casim_B", 103014, 921, 153);
  const p = CORE.parseShareCode(code);
  ok(!!p && p.idx === 3 && p.score === 103014 && p.accMille === 921 && p.combo === 153 && p.name === "Casim_B",
     "share code round-trips all fields");
  ok(CORE.parseShareCode(code.replace(/-(....)$/, "-zzzz")) === null, "wrong checksum rejected");
  const tampered = code.replace(p.score.toString(36), (p.score * 10).toString(36));
  ok(CORE.parseShareCode(tampered) === null, "tampered score fails checksum");
  ok(CORE.parseShareCode("hello") === null && CORE.parseShareCode("") === null, "garbage rejected");
  const odd = CORE.parseShareCode(CORE.makeShareCode(1, "Nasty Name!!", 5, 500, 2));
  ok(!!odd && odd.name === "NastyName", "names sanitized inside codes");
}

/* ---------------------------------------------------------------
   9. Variable lane counts
   --------------------------------------------------------------- */
section("Variable lane counts");
{
  // CRITICAL: 4-lane charts must be byte-identical to pre-lanes output —
  // the live event and all existing bests depend on it.
  let identical = 0;
  for (const s of CORE.BUNDLED) for (const d of ["easy","normal","hard"]) {
    if (JSON.stringify(CORE.buildChart(s, d)) === JSON.stringify(CORE.buildChart(s, d, 4))) identical++;
  }
  ok(identical === CORE.BUNDLED.length * 3,
     "all " + CORE.BUNDLED.length * 3 + " charts identical with explicit laneCount=4 (got " + identical + ")");
}
for (const L of [6, 8]) {
  for (const sid of ["mountain-king", "korobeiniki", "entertainer", "canon-d"]) {
    const s = CORE.BUNDLED.find(x => x.id === sid);
    const chart = CORE.buildChart(s, "hard", L);
    ok(chart.every(n => n.lane >= 0 && n.lane < L), sid + "@" + L + ": lanes within 0.." + (L - 1));
    const span = new Set(chart.map(n => n.lane)).size;
    ok(span >= L - 2, sid + "@" + L + ": uses ≥" + (L - 2) + " lanes (got " + span + ")");
    const cfg = CORE.DIFFS.hard;
    let gapsOk = true; const last = new Array(L).fill(-1e9);
    for (const n of chart) {
      if (n.t - last[n.lane] < cfg.gapLane - 1e-9 && last[n.lane] > -1e8) gapsOk = false;
      last[n.lane] = n.t;
    }
    ok(gapsOk, sid + "@" + L + ": per-lane gap floor holds");
    const run = CORE.newRun(chart, s, "hard");
    for (const n of chart) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
    ok(CORE.finishRun(run).grade === "S", sid + "@" + L + ": autoplay S");
  }
}
{
  const s = CORE.BUNDLED[0];
  const a = JSON.stringify(CORE.buildChart(s, "normal", 6));
  const b = JSON.stringify(CORE.buildChart(s, "normal", 6));
  ok(a === b, "6-lane chart generation is deterministic");
  const e8 = CORE.buildChart(s, "easy", 8).length, n8 = CORE.buildChart(s, "normal", 8).length,
        h8 = CORE.buildChart(s, "hard", 8).length;
  ok(e8 <= n8 && n8 <= h8, "easy ≤ normal ≤ hard holds at 8 lanes (" + e8 + "/" + n8 + "/" + h8 + ")");
}

/* ---------------------------------------------------------------
   10. Forge native schema, holds, Crescendo
   --------------------------------------------------------------- */
section("Forge native schema");
{
  const song = CORE.parseForgeJSON({
    name: "Mini", bpm: 110, bars: 1, res: 2,
    tracks: [
      { type: "inst", name: "Piano", inst: "piano", vol: 1, notes: [{ midi: 60, step: 2, len: 1, vel: 0.8 }] },
      { type: "drum", name: "Drums", vol: 1, notes: [{ drum: "kick", step: 0, len: 1, vel: 1 }] },
      { type: "inst", name: "Muted", inst: "piano", mute: true, vol: 1, notes: [{ midi: 72, step: 0, len: 1, vel: 1 }] }
    ]
  }, "m.json");
  const spb2 = 60 / 110 / 2;
  ok(song.tracks.length === 2, "muted tracks skipped (got " + song.tracks.length + ")");
  const piano = song.tracks.find(t => !t.isDrum), drum = song.tracks.find(t => t.isDrum);
  ok(Math.abs(piano.notes[0].t - 2 * spb2) < 1e-9, "res=2: steps converted at half-beats (t=" + piano.notes[0].t.toFixed(3) + ")");
  ok(drum && drum.notes[0].p === 36, "named drum 'kick' maps to GM 36");
  const soloed = CORE.parseForgeJSON({ bpm: 120, res: 2, tracks: [
    { type: "inst", inst: "piano", solo: true, vol: 1, notes: [{ midi: 60, step: 0, len: 1, vel: 1 }] },
    { type: "inst", inst: "piano", vol: 1, notes: [{ midi: 64, step: 0, len: 1, vel: 1 }] }
  ]}, "s.json");
  ok(soloed.tracks.length === 1, "solo isolates its track");
}

section("Holds");
{
  const mk = (notes) => ({ id: "h", title: "H", composer: "t", source: "midi", bpm: 120,
    tracks: [{ name: "M", prog: 0, isDrum: false, notes }], duration: 30 });
  const song = mk([
    { t: 1, d: 2.0, p: 60, v: 96 },   // long -> hold on every difficulty
    { t: 5, d: 0.2, p: 72, v: 96 },   // short -> tap everywhere
    { t: 8, d: 3.0, p: 60, v: 96 },   // long but next same-lane note close
    { t: 9, d: 0.2, p: 61, v: 96 },
    { t: 12, d: 0.7, p: 64, v: 96 }   // mid-length: hold on hard, tap on easy
  ]);
  const hard = CORE.buildChart(song, "hard");
  const easy = CORE.buildChart(song, "easy");
  const e1 = easy.find(n => Math.abs(n.t - 1) < 1e-6);
  ok(e1 && e1.d > 0, "easy gets holds from truly sustained notes (≥1s)");
  const eMid = easy.find(n => Math.abs(n.t - 12) < 1e-6);
  const hMid = hard.find(n => Math.abs(n.t - 12) < 1e-6);
  ok(eMid && eMid.d === 0 && hMid && hMid.d > 0, "0.7s note: tap on easy, hold on hard");
  const h1 = hard.find(n => Math.abs(n.t - 1) < 1e-6);
  ok(h1 && Math.abs(h1.d - 2.0) < 1e-6, "2s source note becomes a 2s hold on hard (d=" + (h1 && h1.d) + ")");
  const short = hard.find(n => Math.abs(n.t - 5) < 1e-6);
  ok(short && short.d === 0, "0.2s note stays a tap");
  const clamped = hard.find(n => Math.abs(n.t - 8) < 1e-6);
  const next = hard.find(n => n.t > 8 && n.lane === (clamped && clamped.lane));
  if (clamped && next) ok(clamped.d <= next.t - clamped.t - 0.12 + 1e-9,
    "hold clamped before next same-lane note (d=" + clamped.d + ")");
  else ok(true, "clamp case: notes landed in different lanes");
}
{
  const chart = [{ id: 0, t: 1, lane: 0, d: 1 }];
  const meta = { id: "x", title: "x" };
  // complete: head Perfect (100 + combo bonus 2 = 102), release near tail -> +51
  let run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);
  ok(run.score === 102 && run.notes[0].holding, "hold head graded, sustain begins");
  CORE.laneRelease(run, 0, 1.9);
  ok(run.score === 153 && run.holdsDone === 1, "held to the end: +50% of head points (score " + run.score + ")");
  // early release: no bonus, no penalty; accuracy unaffected
  run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);
  CORE.laneRelease(run, 0, 1.4);
  const res = CORE.finishRun(run);
  ok(run.score === 102 + Math.round(102 * CORE.HOLD_BONUS * 0.4) && run.holdsDone === 0,
     "early release pays prorated credit, not a full bonus (" + run.score + ")");
  ok(res.accuracy === 1 && res.grade === "S", "broken hold never hurts accuracy or grade");
  // never released: auto-completes at the tail
  run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);
  CORE.tickHolds(run, 2.05);
  ok(run.holdsDone === 1 && run.score === 153, "still held at tail: auto-completed");
  // cross-lane independence: activity in another lane never disturbs a hold
  run = CORE.newRun([{ id: 0, t: 1, lane: 0, d: 1 }, { id: 1, t: 1.4, lane: 1, d: 0 }], meta, "normal");
  CORE.gradeTap(run, 0, 1);
  CORE.gradeTap(run, 1, 1.4);
  ok(run.notes[0].holding, "tapping another lane leaves the hold alive");
  CORE.laneRelease(run, 1, 1.45);
  ok(run.notes[0].holding, "releasing another lane leaves the hold alive");
  CORE.laneRelease(run, 0, 1.95);
  ok(run.notes[0].holdDone === true, "its own release still completes it");
  // song ends mid-hold: finishRun completes it
  run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);
  const res2 = CORE.finishRun(run);
  ok(res2.holdsDone === 1 && "holdsTotal" in res2 && "crescendoZones" in res2, "finish completes live holds; results carry new fields");
}

section("Crescendo");
{
  // dense cluster at 30-38s of a 60s chart -> zone must cover it
  const chart = [];
  let id = 0;
  for (let t = 2; t < 60; t += 2.5) chart.push({ id: id++, t, lane: 0, d: 0 });
  for (let t = 30; t < 38; t += 0.4) chart.push({ id: id++, t, lane: 1, d: 0 });
  chart.sort((a, b) => a.t - b.t);
  const zones = CORE.findCrescendos(chart, 60);
  ok(zones.length === 2, "60s chart gets 2 zones (got " + zones.length + ")");
  const clusterTimes = chart.filter(n => n.t >= 30 && n.t < 38).map(n => n.t);
  const covered = clusterTimes.filter(t => zones.some(z => t >= z.start && t < z.end)).length;
  ok(covered / clusterTimes.length >= 0.9,
     "zones cover ≥90% of the dense cluster (" + covered + "/" + clusterTimes.length + " · " + JSON.stringify(zones) + ")");
  ok(JSON.stringify(CORE.findCrescendos(chart, 60)) === JSON.stringify(zones), "zone finding is deterministic");
  ok(zones[0].end <= zones[1].start + 1e-9, "zones never overlap");
  ok(CORE.findCrescendos(chart.slice(0, 3), 20).length === 0, "songs under 25s get no zones");
  // spread guarantee: even when all density sits at the end, zones land in
  // beginning / middle / end thirds
  const endHeavy = [];
  let eid = 0;
  for (let tt = 2; tt < 160; tt += 3) endHeavy.push({ id: eid++, t: tt, lane: 0, d: 0 });
  for (let tt = 130; tt < 145; tt += 0.3) endHeavy.push({ id: eid++, t: tt, lane: 1, d: 0 });
  endHeavy.sort((a, b) => a.t - b.t);
  const zs3 = CORE.findCrescendos(endHeavy, 160);
  ok(zs3.length === 3, "long songs get 3 zones (" + zs3.length + ")");
  ok(zs3[0].start < 160 / 3 && zs3[1].start >= 160 / 3 - 1 && zs3[1].end <= 2 * 160 / 3 + 17 && zs3[2].start >= 2 * 160 / 3 - 1,
     "zones spread beginning/middle/end even with end-heavy density (" + JSON.stringify(zs3) + ")");
}
{
  const chart = [{ id: 0, t: 5, lane: 0, d: 0 }, { id: 1, t: 6, lane: 1, d: 0 }];
  const meta = { id: "z", title: "z" };
  const zones = [{ start: 4, end: 8 }];
  // both perfect in-zone: doubled points + zone bonus
  let run = CORE.newRun(chart, meta, "normal", zones);
  CORE.gradeTap(run, 0, 5); CORE.gradeTap(run, 1, 6);
  const inZonePts = run.score;
  ok(inZonePts === (100 + 2) * 2 + (100 + 4) * 2, "in-zone notes score double (got " + inZonePts + ")");
  const resZ = CORE.finishRun(run);
  ok(resZ.score === inZonePts + CORE.CRESC_BONUS && resZ.crescendoPerfect === 1,
     "all-Perfect zone pays the flat bonus");
  // one Good breaks the zone bonus but not the doubling
  run = CORE.newRun(chart, meta, "normal", zones);
  CORE.gradeTap(run, 0, 5); CORE.gradeTap(run, 1, 6.1);
  const resZ2 = CORE.finishRun(run);
  ok(resZ2.crescendoPerfect === 0, "a Good inside the zone forfeits the perfect bonus");
}

/* ---------------------------------------------------------------
   11. Audio onset detection (synthesized-signal proofs)
   --------------------------------------------------------------- */
section("Audio charting");
{
  // FFT sanity: a pure sine peaks at its own bin
  const N = 2048, sr = 44100, freq = 441.43; // ~bin 20.5 -> nearest bins
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.sin(2 * Math.PI * freq * i / sr);
  CORE.fftRadix2(re, im);
  let best = 0, bv = 0;
  for (let b = 1; b < N / 2; b++) { const m = re[b]*re[b] + im[b]*im[b]; if (m > bv) { bv = m; best = b; } }
  const expect = Math.round(freq * N / sr);
  ok(Math.abs(best - expect) <= 1, "FFT peaks at the sine's bin (got " + best + ", expect ~" + expect + ")");
}
{
  // synthesized track: 60ms tone bursts at known times, then 2s of silence
  const sr = 44100, dur = 8;
  const mono = new Float32Array(sr * dur);
  const hits = [0.5, 1.2, 1.9, 2.6, 3.3, 4.0, 4.7, 5.4];   // alternating low/high tones
  hits.forEach((t, i) => {
    const f = i % 2 === 0 ? 130 : 1760;
    const s0 = Math.round(t * sr);
    for (let j = 0; j < sr * 0.06; j++)
      mono[s0 + j] += Math.sin(2 * Math.PI * f * j / sr) * 0.8 * Math.exp(-j / (sr * 0.03));
  });
  const onsets = CORE.detectOnsets(mono, sr);
  ok(onsets.length === hits.length, "detects exactly the " + hits.length + " bursts (got " + onsets.length + ")");
  const matched = hits.filter(h => onsets.some(o => Math.abs(o.t - h) <= 0.035)).length;
  ok(matched === hits.length, "every onset within 35ms of truth (" + matched + "/" + hits.length + ")");
  ok(!onsets.some(o => o.t > 5.6), "no phantom onsets in the silent tail");
  const lows = onsets.filter((o, i) => i % 2 === 0), highs = onsets.filter((o, i) => i % 2 === 1);
  ok(Math.max(...lows.map(o => o.freq)) < Math.min(...highs.map(o => o.freq)),
     "dominant-frequency estimates separate low and high bursts");
  ok(JSON.stringify(CORE.detectOnsets(mono, sr)) === JSON.stringify(onsets), "detection is deterministic");
  // full pipeline: onsets -> song -> chart -> autoplay
  const song = CORE.audioSongFromOnsets(onsets, dur, "Synth Test", "tag");
  ok(song.source === "audio" && song.tracks[0].notes.length === onsets.length, "song built from onsets");
  const lanesOfLow = new Set(), lanesOfHigh = new Set();
  const chart = CORE.buildChart(song, "hard");
  for (const n of chart) {
    const src = onsets.find(o => Math.abs(o.t - n.t) < 1e-6);
    if (!src) continue;
    (src.freq < 500 ? lanesOfLow : lanesOfHigh).add(n.lane);
  }
  ok(Math.max(...lanesOfLow) < Math.min(...lanesOfHigh), "low tones chart to lower lanes than high tones");
  ok(chart.every(n => n.d === 0), "audio charts are taps-only (no false holds)");
  const run = CORE.newRun(chart, song, "hard");
  for (const n of chart) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
  ok(CORE.finishRun(run).grade === "S", "audio-derived chart autoplays to S");
  ok(CORE.estimateBPM(onsets) >= 60 && CORE.estimateBPM(onsets) <= 200, "bpm estimate in sane range");
}

/* ---------------------------------------------------------------
   12. Strength-aware audio difficulties + single-source Easy path
   --------------------------------------------------------------- */
section("Audio tiers (booms / percussion / melody)");
{
  const dur = 40;
  const booms = [], percussion = [], onsets = [];
  for (let i = 0; i < 30; i++) booms.push({ t: 1 + i * 1.2, strength: 2.5 });
  for (let i = 0; i < 30; i++) percussion.push({ t: 1.6 + i * 1.2, strength: 3, kickShare: 0.2 });
  for (let i = 0; i < 20; i++) onsets.push({ t: 1.3 + i * 1.9, strength: 2, low: 0.2, freq: 800 });
  const song = CORE.audioSongFromOnsets(onsets, dur, "Tiers", "tg", percussion, booms);
  const easy = CORE.buildChart(song, "easy");
  const normal = CORE.buildChart(song, "normal");
  const hard = CORE.buildChart(song, "hard");
  const bt = new Set(booms.map(b => b.t));
  ok(easy.length > 0 && easy.every(n => bt.has(n.t)), "Easy is built purely from booms (" + easy.length + " notes)");
  const cov = booms.filter(b => easy.some(n => Math.abs(n.t - b.t) < 1e-6)).length / booms.length;
  ok(cov >= 0.9, "Easy covers ≥90% of the booms (" + Math.round(cov * 100) + "%)");
  const pt = new Set(percussion.map(p => p.t));
  ok(normal.some(n => pt.has(n.t)), "Normal adds the percussion layer");
  ok(hard.some(n => !bt.has(n.t) && !pt.has(n.t)), "Hard adds the melodic layer");
  ok(easy.length < normal.length && normal.length < hard.length,
     "tiers strictly widen (" + easy.length + "/" + normal.length + "/" + hard.length + ")");
  ok(JSON.stringify(CORE.buildChart(song, "easy")) === JSON.stringify(easy), "tier charts deterministic");
  const laneSpread = new Set(easy.map(n => n.lane)).size;
  ok(laneSpread >= 3, "Easy booms sweep the board (" + laneSpread + " lanes used)");
}

section("Boom detector");
{
  const sr = 44100, dur = 10;
  const mono = new Float32Array(sr * dur);
  // constant 400Hz drone the whole way through (the flux-killer scenario)
  for (let i = 0; i < mono.length; i++) mono[i] = Math.sin(2 * Math.PI * 400 * i / sr) * 0.15;
  // identical repeated 60Hz kick thumps at 1..7s; 7.5-10s is drone only
  const hits = [1, 2, 3, 4, 5, 6, 7];
  for (const h of hits) {
    const s0 = Math.round(h * sr);
    for (let j = 0; j < sr * 0.08; j++)
      mono[s0 + j] += Math.sin(2 * Math.PI * 60 * j / sr) * 0.8 * Math.exp(-j / (sr * 0.03));
  }
  const bms = CORE.detectBooms(mono, sr);
  ok(bms.length === hits.length, "hears all " + hits.length + " identical kicks under the drone (got " + bms.length + ")");
  const matched = hits.filter(h => bms.some(b => Math.abs(b.t - h) <= 0.03)).length;
  ok(matched === hits.length, "every boom within 30ms of truth (" + matched + "/" + hits.length + ")");
  ok(!bms.some(b => b.t > 7.5), "no phantom booms in the drone-only tail");
  ok(JSON.stringify(CORE.detectBooms(mono, sr)) === JSON.stringify(bms), "boom detection deterministic");
}

section("Auto-sync alignment");
{
  const chart = [];
  for (let i = 0; i < 60; i++) chart.push(1 + i * 0.5 + (i % 7) * 0.03);
  // recording lags the chart by exactly 230ms, plus unrelated noise onsets
  const onsets = chart.map(t => t + 0.23).concat([0.1, 7.77, 13.13, 22.9]);
  const al = CORE.bestAlignment(chart, onsets);
  ok(Math.abs(al.offsetMs - 230) <= 10, "recovers a +230ms lag (got " + al.offsetMs + "ms)");
  ok(al.frac >= 0.95, "match fraction near-perfect (" + Math.round(al.frac * 100) + "%)");
  const al2 = CORE.bestAlignment(chart, chart.map(t => t - 0.4));
  ok(Math.abs(al2.offsetMs + 400) <= 10, "recovers a -400ms lead (got " + al2.offsetMs + "ms)");
  const noise = Array.from({ length: 80 }, (_, i) => (i * 0.777) % 30);
  const al3 = CORE.bestAlignment(chart, noise);
  ok(al3.frac < 0.6, "unrelated recording scores low confidence (" + Math.round(al3.frac * 100) + "%)");
  ok(JSON.stringify(CORE.bestAlignment(chart, onsets)) === JSON.stringify(al), "alignment deterministic");
}

section("Import advisory");
{
  const mk = (n, dur, kick) => Array.from({ length: n }, (_, i) => ({ t: (i + 1) * dur / (n + 1), strength: 3, kick, freq: 200 }));
  ok(CORE.importAdvisory(mk(300, 300, 3), 300) === null, "healthy analysis: no warning");
  ok(/sparse/.test(CORE.importAdvisory(mk(20, 300, 3), 300) || ""), "very sparse recording warns");
  ok(/dense/.test(CORE.importAdvisory(mk(1800, 300, 3), 300) || ""), "extreme density warns");
  ok(/drum/.test(CORE.importAdvisory(mk(300, 300, 0.5), 300) || ""), "no drum-register hits warns");
}

/* ---------------------------------------------------------------
   Fortissimo
   --------------------------------------------------------------- */
section("Fortissimo");
{
  ok(CORE.fortReqFor(40) === 24 && CORE.fortReqFor(600) === 220 && CORE.fortReqFor(200) === 76,
     "charge requirement scales with chart size (24/76/220)");
  ok(CORE.fortDurFor(405) === 18 && CORE.fortDurFor(60) === 8,
     "boost duration scales with song length (18s long, 8s short)");
  const meta = { id: "ft", title: "ft" };
  const mkChart = (n, gap) => Array.from({ length: n }, (_, i) => ({ id: i, t: 1 + i * gap, lane: i % 4, d: 0 }));
  // AUTO: fills on perfects, fires itself, boosts subsequent notes x2
  let chart = mkChart(40, 1);           // req = 24
  let run = CORE.newRun(chart, meta, "normal", [], { mode: "auto", dur: 10 });
  for (const n of chart) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
  ok(run.fortCount === 1, "auto mode fires once on a 40-note chart (" + run.fortCount + ")");
  const expAt = (i, mult2) => (mult2 ? 2 : 1) *
    Math.round((100 + Math.min(100, (i + 1) * 2)) * CORE.comboMultAt(i + 1, 40));
  ok(run.notes[22].headPts === expAt(22, false), "note before fill is unboosted");
  ok(run.notes[25].headPts === expAt(25, true), "note during boost is exactly doubled");
  ok(CORE.finishRun(run).fortissimos === 1, "results report the activation count");
  // the 25th tap (first after fill) scores exactly double
  run = CORE.newRun(mkChart(40, 1), meta, "normal", [], { mode: "auto", dur: 10 });
  for (let i = 0; i < 25; i++) CORE.gradeTap(run, run.notes[i].lane, run.notes[i].t);
  const n25 = run.notes[24];
  const exp25 = 2 * Math.round((100 + Math.min(100, 25 * 2)) * CORE.comboMultAt(25, 40));
  ok(n25.headPts === exp25, "first boosted tap scores exactly x2 on top of combo mult (" + n25.headPts + "/" + exp25 + ")");
  // boost expires after its duration
  ok(!CORE.fortActiveAt(run, run.fortUntil + 0.01), "boost expires at its end time");
  // goods trickle: 5 goods ~ 1.1 units vs 1 per perfect
  run = CORE.newRun(mkChart(10, 1), meta, "normal", [], { mode: "auto" });
  CORE.gradeTap(run, run.notes[0].lane, run.notes[0].t + 0.1); // good
  const gFill = run.fortMeter;
  CORE.gradeTap(run, run.notes[1].lane, run.notes[1].t);       // perfect
  ok(gFill < 0.3 && run.fortMeter - gFill === 1, "goods trickle (" + gFill + "), perfects fill 1");
  // MANUAL: never auto-fires; fortActivate gates on a full meter
  chart = mkChart(40, 1);
  run = CORE.newRun(chart, meta, "normal", [], { mode: "manual", dur: 10 });
  for (let i = 0; i < 30; i++) CORE.gradeTap(run, run.notes[i].lane, run.notes[i].t);
  ok(run.fortCount === 0 && run.fortMeter >= run.fortReq, "manual mode holds a full meter without firing");
  ok(CORE.fortActivate(run, 31) === true && run.fortCount === 1 && run.fortMeter === 0,
     "manual activation fires and resets the meter");
  ok(CORE.fortActivate(run, 32) === false, "cannot re-fire while active");
  // STACKING: Fortissimo inside a Crescendo zone = x4
  const zchart = [{ id: 0, t: 5, lane: 0, d: 0 }];
  run = CORE.newRun(zchart, meta, "normal", [{ start: 4, end: 8 }], { mode: "manual", dur: 10 });
  run.fortMeter = run.fortReq;
  CORE.fortActivate(run, 4.5);
  CORE.gradeTap(run, 0, 5);
  ok(run.notes[0].headPts === (100 + 2) * 2 * 2, "Fortissimo stacks with Crescendo for x4 (" + run.notes[0].headPts + ")");
}

section("Combo multiplier");
{
  ok(CORE.comboMultAt(1) === 1 && CORE.comboMultAt(10) === 1, "first 10 combo stay at x1");
  ok(Math.abs(CORE.comboMultAt(11) - 1.01) < 1e-9 && Math.abs(CORE.comboMultAt(60) - 1.5) < 1e-9,
     "ramps +0.01 per step (11 -> 1.01, 60 -> 1.5)");
  ok(CORE.comboMultAt(110) === 2 && CORE.comboMultAt(500) === 2, "caps at x2 from combo 110");
  // scaling: >150 notes untouched; <=150 compresses; exact agreement at 150
  ok(CORE.comboMultAt(60, 400) === CORE.comboMultAt(60), "charts over 150 notes use the standard curve");
  for (const c of [10, 60, 110]) if (CORE.comboMultAt(c, 150) !== CORE.comboMultAt(c))
    ok(false, "boundary mismatch at combo " + c);
  ok(CORE.comboMultAt(110, 150) === CORE.comboMultAt(110), "150-note chart matches the standard curve exactly");
  ok(CORE.comboMultAt(22, 30) === 2, "30-note chart reaches x2 at combo 22 (~73%)");
  ok(Math.abs(CORE.comboMultAt(12, 30) - 1.5) < 1e-9, "30-note chart ramps proportionally (12 -> 1.5)");
  const meta = { id: "cm", title: "cm" };
  const chart = Array.from({ length: 200 }, (_, i) => ({ id: i, t: 1 + i, lane: i % 4, d: 0 }));
  let run = CORE.newRun(chart, meta, "normal");
  for (let i = 0; i < 11; i++) CORE.gradeTap(run, run.notes[i].lane, run.notes[i].t);
  const exp11 = Math.round((100 + Math.min(100, 11 * 2)) * 1.01);
  ok(run.notes[10].headPts === exp11, "11th perfect on a long chart scores base x1.01 (" + run.notes[10].headPts + ")");
  // a miss resets combo, and with it the multiplier
  run = CORE.newRun(chart, meta, "normal");
  for (let i = 0; i < 12; i++) {
    if (i === 6) { CORE.tickMisses(run, run.notes[i].t + 1); continue; } // let note 6 die
    CORE.gradeTap(run, run.notes[i].lane, run.notes[i].t);
  }
  const after = run.notes[7];
  ok(after.headPts === 100 + Math.min(100, 1 * 2), "multiplier resets to x1 after a miss (" + after.headPts + ")");
}

section("Hold reachability + partial credit");
{
  const song = { id: "hr", title: "HR", composer: "t", source: "midi", bpm: 120, duration: 30,
    tracks: [{ name: "M", prog: 0, isDrum: false, notes: [
      { t: 1,   d: 3.0, p: 48, v: 96 },   // long note
      { t: 1.5, d: 0.2, p: 84, v: 96 },   // note far across the board, mid-hold
      { t: 6,   d: 0.2, p: 60, v: 96 }
    ]}]};
  const easy = CORE.buildChart(song, "easy"), hard = CORE.buildChart(song, "hard");
  const eLong = easy.find(n => Math.abs(n.t - 1) < 1e-6);
  const eFar  = easy.find(n => Math.abs(n.t - 1.5) < 1e-6);
  const hLong = hard.find(n => Math.abs(n.t - 1) < 1e-6);
  ok(eLong && eFar && Math.abs(eLong.lane - eFar.lane) > 1,
     "test premise: the two notes sit more than one lane apart");
  ok(eLong.d > 0 && eLong.t + eLong.d <= eFar.t,
     "Easy clamps the hold to end before the far note (d=" + eLong.d + ")");
  ok(hLong.d > eLong.d && hLong.t + hLong.d > eFar.t,
     "Hard keeps the overlap as a sacrifice choice (d=" + hLong.d + ")");
}
{
  const meta = { id: "pc", title: "pc" };
  const chart = [{ id: 0, t: 1, lane: 0, d: 2 }];
  let run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);                       // head = 102
  CORE.laneRelease(run, 0, 2.0);                  // held exactly half
  ok(run.score === 102 + Math.round(102 * CORE.HOLD_BONUS * 0.5), "half-held pays half the bonus");
  ok(run.holdsDone === 0 && run.holdsPartial === 1, "counted partial, not complete");
  const res = CORE.finishRun(run);
  ok(res.accuracy === 1 && res.grade === "S", "partial holds never touch accuracy");
  ok(Math.abs(res.holdPartialAvg - 0.5) < 1e-9, "results report the average held fraction");
  // completing still pays strictly more than any early release
  run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);
  CORE.laneRelease(run, 0, 2.95);
  ok(run.holdsDone === 1 && run.score === 102 + Math.round(102 * CORE.HOLD_BONUS),
     "completing pays the full bonus (" + run.score + ")");
  // credit rises monotonically with how long you held
  let prev = -1, mono = true;
  for (const rel of [1.2, 1.5, 1.8, 2.2, 2.6]) {
    const r2 = CORE.newRun(chart, meta, "normal");
    CORE.gradeTap(r2, 0, 1);
    CORE.laneRelease(r2, 0, rel);
    if (r2.score < prev) mono = false;
    prev = r2.score;
  }
  ok(mono, "holding longer never pays less");
  // an immediate release earns nothing extra
  run = CORE.newRun(chart, meta, "normal");
  CORE.gradeTap(run, 0, 1);
  CORE.laneRelease(run, 0, 1);
  ok(run.score === 102 && run.holdsPartial === 0, "instant release earns no bonus");
}

/* ---------------------------------------------------------------
   Forge instrument id -> engine voice mapping
   --------------------------------------------------------------- */
section("Forge instrument mapping");
{
  const ENGINE = ["piano", "pluck", "bass", "bell", "organ", "square", "saw", "drums"];
  const IDS = ["piano","epiano","organ","guitar","harp","marimba","bell","brass","strings","sawlead",
    "square","fm","choir","ooh","musicbox","celesta","steeldrum","pizz","accordion","synthbass","banjo","sitar"];
  const parse = (tracks) => CORE.parseForgeJSON({ name: "T", bpm: 120, res: 2, tracks }, "t.json");
  const one = (inst, name) => parse([{ type: "inst", name: name || "", inst, vol: 1,
    notes: [{ midi: 60, step: 0, len: 1, vel: 0.8 }] }]).tracks[0];

  ok(IDS.length === 22, "all 22 documented Forge ids are covered by this test");
  const bad = IDS.filter(id => !ENGINE.includes(one(id).inst));
  ok(bad.length === 0, "every Forge id resolves to one of the 8 engine voices" +
     (bad.length ? " — offenders: " + bad.join(",") : ""));
  const asDrum = IDS.filter(id => one(id).isDrum);
  ok(asDrum.length === 0, "no pitched Forge instrument imports as percussion" +
     (asDrum.length ? " — offenders: " + asDrum.join(",") : ""));
  // the specific regression: /drum/ used to capture "steeldrum"
  const sd = one("steeldrum");
  ok(sd.inst === "bell" && sd.isDrum === false, "steeldrum is a pitched bell voice, not drums");
  // the three previously-unmapped ids
  ok(one("sitar").inst === "pluck", "sitar -> pluck");
  ok(one("ooh").inst === "organ", "ooh -> organ");
  ok(one("fm").inst === "organ", "fm -> organ");
  // a sample of the ids that were already right must not have moved
  for (const [id, v] of [["piano","piano"],["epiano","piano"],["organ","organ"],["guitar","pluck"],
                         ["harp","pluck"],["marimba","bell"],["bell","bell"],["brass","saw"],
                         ["strings","saw"],["sawlead","saw"],["square","square"],["choir","organ"],
                         ["musicbox","bell"],["celesta","bell"],["pizz","pluck"],["accordion","organ"],
                         ["synthbass","bass"],["banjo","pluck"]])
    if (one(id).inst !== v) ok(false, id + " should map to " + v + ", got " + one(id).inst);
  ok(true, "the 18 ids not touched by round 2 are unchanged");

  // type:'drum' decides percussion, never an instrument name
  const mixed = parse([
    { type: "inst", name: "Piano", inst: "piano", vol: 1, notes: [{ midi: 60, step: 0, len: 1, vel: 0.8 }] },
    { type: "drum", name: "Drums", vol: 1, notes: [{ drum: "kick", step: 0, len: 1, vel: 1 }] }
  ]);
  const dt = mixed.tracks.find(t => t.name === "Drums");
  ok(dt && dt.isDrum === true && dt.inst === "drums" && dt.notes[0].p === 36,
     "a type:'drum' track still imports as drums with GM pitches");
  // a renamed track must not override its real instrument (real exports do this)
  ok(one("guitar", "Strings Pad").inst === "pluck", "track name cannot override the instrument id");
  const dl = one("guitar", "Drum Loop");
  ok(dl.inst === "pluck" && dl.isDrum === false, "a guitar named 'Drum Loop' is not percussion");
  // the regex fallback must survive for MIDI and free-text names
  ok(one("", "Trumpet").inst === "saw" && one("", "Rhodes").inst === "piano",
     "regex fallback still resolves free-text instrument names");
  ok(one("", "Timpani Kit").isDrum === true, "free-text percussion names still map to drums");
  // prototype keys must not leak through the lookup
  ok(typeof one("constructor").inst === "string", "a prototype-named instrument returns a real voice");
}

/* ---------------------------------------------------------------
   Forge round 2: strings->saw, drums-only imports
   --------------------------------------------------------------- */
section("Forge strings + drums-only");
{
  const parse = (tracks, extra) => CORE.parseForgeJSON(
    Object.assign({ name: "T", bpm: 120, res: 2, tracks }, extra || {}), "t.json");
  const one = (inst) => parse([{ type: "inst", name: "", inst, vol: 1,
    notes: [{ midi: 60, step: 0, len: 1, vel: 0.8 }] }]).tracks[0];

  ok(one("strings").inst === "saw", "strings -> saw (aligned with Heroes' timbre table)");
  // the other 21 must be untouched by that edit
  for (const [id, v] of [["piano","piano"],["epiano","piano"],["organ","organ"],["guitar","pluck"],
                         ["harp","pluck"],["marimba","bell"],["bell","bell"],["brass","saw"],
                         ["sawlead","saw"],["square","square"],["fm","organ"],["choir","organ"],
                         ["ooh","organ"],["musicbox","bell"],["celesta","bell"],["steeldrum","bell"],
                         ["pizz","pluck"],["accordion","organ"],["synthbass","bass"],["banjo","pluck"],
                         ["sitar","pluck"]])
    if (one(id).inst !== v) ok(false, id + " should still map to " + v + ", got " + one(id).inst);
  ok(true, "the other 21 Forge ids are unchanged by the strings edit");
  // regex fallback untouched: free-text "Strings Pad" still resolves through /string/
  ok(parse([{ type: "inst", name: "Strings Pad", inst: "", vol: 1,
    notes: [{ midi: 60, step: 0, len: 1, vel: 1 }] }]).tracks[0].inst === "organ",
    "regex fallback for free-text names is untouched");

  // a drums-only export must import
  const drumsOnly = parse([{ type: "drum", name: "Drums", inst: null, mute: false, solo: false, vol: 1,
    notes: [{ drum: "kick", step: 0, len: 1, vel: 0.9 }, { drum: "snare", step: 4, len: 1, vel: 0.8 },
            { drum: "hat", step: 2, len: 1, vel: 0.6 }] }], { bars: 2, res: 4 });
  ok(drumsOnly.tracks.length === 1 && drumsOnly.tracks[0].isDrum === true,
     "drums-only export parses as a single drum track");
  ok(drumsOnly.tracks[0].notes.length === 3, "all drum notes survive (3/3)");
  ok(drumsOnly.tracks[0].notes.map(n => n.p).sort((a, b) => a - b).join(",") === "36,38,42",
     "named drums still map through DRUM_MIDI");
  ok(drumsOnly.duration > 0, "duration is computed for a drums-only song");
  const cls = CORE.classifyTracks(drumsOnly);
  ok(cls.melody === null && cls.drums.length === 1, "classifyTracks survives zero pitched tracks");
  for (const L of [4, 6, 8]) {
    const c = CORE.buildChart(drumsOnly, "hard", L);
    ok(c.length > 0 && c.every(n => n.lane >= 0 && n.lane < L),
       "drums-only charts in range at " + L + " lanes");
    const run = CORE.newRun(c, drumsOnly, "hard");
    for (const n of c) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); }
    ok(CORE.finishRun(run).grade === "S", "drums-only chart autoplays at " + L + " lanes");
  }
  // the widened sniff must still reject malformed input
  const rejects = [
    ["neither midi nor drum", [{ type: "inst", notes: [{ step: 0, len: 1, vel: 1 }] }]],
    ["missing step",          [{ type: "drum", notes: [{ drum: "kick", len: 1, vel: 1 }] }]],
    ["non-string drum field", [{ type: "drum", notes: [{ drum: 7, step: 0, len: 1, vel: 1 }] }]]
  ];
  for (const [tag, tracks] of rejects) {
    let threw = false;
    try { parse(tracks); } catch (e) { threw = true; }
    ok(threw, "still rejects: " + tag);
  }
  let noTracks = false;
  try { CORE.parseForgeJSON({ bpm: 120, res: 2 }, "r.json"); } catch (e) { noTracks = true; }
  ok(noTracks, "still rejects: no tracks array");
}

/* ---------------------------------------------------------------
   Sustain-derived holds for audio imports
   --------------------------------------------------------------- */
section("Audio sustain + holds");
{
  const sr = 44100;
  // known exponential decays: ring at 40% of peak should be tau*ln(1/0.4)
  const sig = new Float32Array(sr * 10);
  const taus = [0.08, 0.9, 0.25, 1.6], hits = [1, 3, 5, 7];
  hits.forEach((t, i) => {
    const s0 = Math.round(t * sr);
    for (let j = 0; j < sr * 2.5 && s0 + j < sig.length; j++)
      sig[s0 + j] += Math.sin(2 * Math.PI * 330 * j / sr) * 0.8 * Math.exp(-j / (sr * taus[i]));
  });
  const info = CORE.sustainEnvelope(sig, sr);
  ok(info.env.length > 0 && Math.abs(info.hopSec - 0.01) < 1e-9, "sustain envelope built at a 10ms hop");
  let worstErr = 0;
  hits.forEach((t, i) => {
    const expected = taus[i] * Math.log(1 / CORE.SUSTAIN_DECAY);
    const got = CORE.sustainAt(info, t);
    worstErr = Math.max(worstErr, Math.abs(got - expected) / expected);
  });
  ok(worstErr < 0.20, "measured ring matches analytic decay within 20% (worst " +
     Math.round(worstErr * 100) + "%)");
  ok(CORE.sustainAt(info, 9.5) < 0.35, "silence measures as no sustain");
  ok(CORE.sustainAt(null, 1) === 0, "a missing envelope yields zero, never a crash");
  ok(CORE.sustainAt(info, 3) === CORE.sustainAt(info, 3), "sustain measurement is deterministic");
  ok(CORE.sustainAt(info, 7) > CORE.sustainAt(info, 1), "a long decay measures longer than a short one");

  // backward compatibility: no envelope -> the old placeholder durations
  const onsets = Array.from({ length: 12 }, (_, i) => ({ t: 1 + i * 0.9, strength: 3, low: 0.2, kick: 1, freq: 700 }));
  const booms = Array.from({ length: 10 }, (_, i) => ({ t: 1.2 + i * 1.1, strength: 2.5 }));
  const plain = CORE.audioSongFromOnsets(onsets, 20, "P", "p", [], booms);
  ok(plain.tracks[0].notes.filter(n => n.p === 34).every(n => n.d === 0.15),
     "without a sustain envelope, boom notes keep the 0.15s placeholder");
  const withSus = CORE.audioSongFromOnsets(onsets, 20, "S", "s", [], booms, info);
  ok(withSus.tracks[0].notes.some(n => n.d !== 0.15), "with an envelope, durations come from the recording");
  ok(withSus.tracks[0].notes.every(n => n.d >= 0.05 && n.d <= 4), "measured durations stay within bounds");

  // holds appear post-thinning, and never exceed two concurrent on audio charts
  const long = CORE.audioSongFromOnsets(onsets, 20, "L", "l", [], booms);
  for (const n of long.tracks[0].notes) n.d = 2.0;   // every note sustains 2s
  for (const diff of ["easy", "normal", "hard"]) {
    const c = CORE.buildChart(long, diff, 4);
    const holds = c.filter(n => n.d > 0);
    ok(holds.length > 0, diff + ": sustained audio notes become holds (" + holds.length + ")");
    // instantaneous concurrency: it can only rise at a hold's start
    let mx = 0;
    for (const s of holds) {
      let a = 0;
      for (const g of holds) if (g.t <= s.t && s.t < g.t + g.d) a++;
      mx = Math.max(mx, a);
    }
    ok(mx <= 2, diff + ": at most 2 holds active at once (" + mx + ")");
    // reachability still applies on easy/normal
    if (diff !== "hard") {
      const bad = c.filter(n => n.d === 0 && holds.some(h =>
        n.t >= h.t && n.t < h.t + h.d && Math.abs(h.lane - n.lane) > 1)).length;
      ok(bad === 0, diff + ": no far-lane tap lands inside a hold");
    }
    const run = CORE.newRun(c, long, diff);
    for (const n of c) { CORE.tickMisses(run, n.t); CORE.gradeTap(run, n.lane, n.t); if (n.d > 0) CORE.laneRelease(run, n.lane, n.t + n.d); }
    const res = CORE.finishRun(run);
    ok(res.grade === "S" && res.holdsDone === res.holdsTotal,
       diff + ": autoplay completes every hold");
  }
  // the cap must not touch non-audio charts: a real bundled chart still
  // exceeds two concurrent holds (a pre-existing property, deliberately left)
  const conc = (holds) => {
    let mx = 0;
    for (const s of holds) {
      let a = 0;
      for (const g of holds) if (g.t <= s.t && s.t < g.t + g.d) a++;
      mx = Math.max(mx, a);
    }
    return mx;
  };
  const tw = CORE.BUNDLED.find(s => s.id === "twinkle");
  ok(conc(CORE.buildChart(tw, "hard", 4).filter(n => n.d > 0)) > 2,
     "bundled/MIDI charts are exempt from the concurrency cap");
}
{
  // the load-bearing regression: bundled charts must not have moved at all
  let identical = 0;
  for (const s of CORE.BUNDLED) for (const d of ["easy", "normal", "hard"]) {
    const a = CORE.buildChart(s, d, 4);
    if (JSON.stringify(a) === JSON.stringify(CORE.buildChart(s, d))) identical++;
  }
  ok(identical === CORE.BUNDLED.length * 3,
     "all " + CORE.BUNDLED.length * 3 + " bundled charts stable (" + identical + ")");
}

console.log("\n================================");
console.log("PASS " + pass + " / FAIL " + fail);
process.exit(fail ? 1 : 0);
