/* Cadence SHELL tests — the parts cadence.tests.mjs can't reach: DOM flow,
   file pickers, IndexedDB lifecycle, pointer input, library UI.

   Run:  node shell.tests.mjs          (needs jsdom in this directory)
   Exits non-zero if anything fails.

   Covers four areas, each of which had a real bug caught by these tests:
     1. batch import        — a corrupt file used to end the whole batch
     2. selective deletion  — clear-all used to orphan every saved best
     3. decoded-audio cache — three unbounded set() sites, ~140MB per song
     4. hold input          — iOS pointercancel killed a hold you were holding
*/
import { makeDom, ok, section, summary, wait, testSignal } from "./shell-harness.mjs";

const forgeSong = (id) => ({
  id, name: id, bpm: 120, res: 2, bars: 1,
  tracks: [{ type: "inst", name: "Piano", inst: "piano", vol: 1,
    notes: Array.from({ length: 24 }, (_, i) => ({ midi: 60 + (i % 7), step: i, len: 1, vel: 0.8 })) }]
});

/* ============================================================ 1. IMPORT */
{
  const env = await makeDom({ failBytes: 7 });
  const { d, w } = env;

  section("Batch import — pickers accept multiple files");
  ok(d.getElementById("file-midi").hasAttribute("multiple"), "MIDI picker accepts multiple");
  ok(d.getElementById("file-audio").hasAttribute("multiple"), "audio picker accepts multiple");
  ok(d.getElementById("file-forge").hasAttribute("multiple"), "Forge picker accepts multiple");
  ok(!d.getElementById("pair-file").hasAttribute("multiple"),
     "pairing stays single-file (one recording per chart)");

  section("Batch import — three Forge projects at once");
  env.clearToasts();
  env.fireFiles("file-forge", [env.jsonFile("a.json", forgeSong("AAA")),
                               env.jsonFile("b.json", forgeSong("BBB")),
                               env.jsonFile("c.json", forgeSong("CCC"))]);
  await wait(600);
  ok(w.eval("SAVE.imports.length") === 3, "all three imported");
  ok(w.eval("JSON.stringify(SAVE.imports.map(s=>s.title))") === '["AAA","BBB","CCC"]',
     "titles preserved and in order");
  ok(d.getElementById("scr-songs").classList.contains("active"), "lands on the library once");
  ok(/Added 3 songs/.test(env.toasts()), "one summary toast, not three");

  section("Batch import — a corrupt file must not end the batch");
  w.eval("SAVE.imports = []"); env.clearToasts();
  env.fireFiles("file-forge", [env.jsonFile("ok1.json", forgeSong("D1")),
                               env.jsonFile("bad.json", { nope: true }),
                               env.jsonFile("ok2.json", forgeSong("D2"))]);
  await wait(600);
  ok(w.eval("SAVE.imports.length") === 2, "the two good files still imported");
  ok(/couldn't be read/.test(env.toasts()), "the failure is reported, not swallowed");

  section("Batch import — re-importing replaces rather than duplicates");
  env.clearToasts();
  env.fireFiles("file-forge", [env.jsonFile("ok1.json", forgeSong("D1"))]);
  await wait(400);
  ok(w.eval("SAVE.imports.length") === 2, "library size unchanged");
  ok(/Updated in your library/.test(env.toasts()), "reported as an update");

  section("Batch import — three recordings, real detectors running");
  w.eval("SAVE.imports = []"); env.clearToasts();
  env.fireFiles("file-audio", [env.audioFile("s1.mp3", 1000),
                               env.audioFile("s2.mp3", 2000),
                               env.audioFile("s3.mp3", 3000)]);
  await wait(6000);
  ok(w.eval("SAVE.imports.length") === 3, "three audio songs charted and stored");
  ok(w.eval("SAVE.imports.every(s=>s.source==='audio')"), "all marked as audio-sourced");
  ok(env.idb.size === 3, "one recording blob per song in IndexedDB");
  ok(w.eval("decodedCache.size") <= w.eval("DECODED_MAX"),
     "decoded buffers stay within the cache cap during a batch");

  section("Batch import — a corrupt recording leaves no orphaned blob");
  w.eval("SAVE.imports = []"); env.idb.clear(); env.clearToasts();
  env.fireFiles("file-audio", [env.audioFile("good1.mp3", 1500),
                               env.audioFile("bad.mp3", 7),
                               env.audioFile("good2.mp3", 2500)]);
  await wait(6000);
  ok(w.eval("SAVE.imports.length") === 2, "good recordings imported either side of the bad one");
  ok(env.idb.size === 2, "exactly two blobs stored — the failed one rolled back");
  env.dom.window.close();
}

/* ========================================================== 2. DELETION */
{
  const env = await makeDom();
  const { d, w } = env;
  const seed = () => w.eval(`
    SAVE.imports = ["A","B","C"].map((id,i) => ({ id:"imp-"+id, title:"Song "+id, composer:"x",
      source: i===2 ? "audio" : "midi", bpm:120, duration:30,
      tracks:[{name:"M",prog:0,isDrum:false,notes:[{t:1,d:0.2,p:60,v:96}]}] }));
    SAVE.audioPair["imp-C"] = { name:"c.mp3", size:10, offset:0, durable:true };
    SAVE.best["imp-A::easy"] = { grade:"S", score:1 };
    SAVE.best["imp-C::hard::L6"] = { grade:"A", score:2 };
    SAVE.best["ode-to-joy::easy"] = { grade:"S", score:3 };
    decodedCache.set("imp-C", {});
    LIB.filter = "all"; LIB.page = 0; exitSelect(); renderSongs(); show("scr-songs");
  `);
  seed();
  env.idb.set("imp-C", { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

  section("Library — normal mode is unaffected");
  env.click(d.querySelector(".songrow"));
  await wait(100);
  ok(d.getElementById("diffsheet").classList.contains("open"),
     "tapping a row still opens the difficulty sheet");
  w.eval("$('diffsheet').classList.remove('open')");

  section("Library — select mode");
  env.click(d.getElementById("lib-select"));
  await wait(60);
  ok(w.eval("LIB.selecting") === true, "select mode engages");
  ok(d.getElementById("lib-select").textContent === "Done", "the button becomes Done");
  // bundled songs must never be removable
  const locked = [...d.querySelectorAll(".songrow")].find(r => r.className.includes("locked"));
  ok(!!locked, "bundled rows render as locked in select mode");
  if (locked) { env.click(locked); await wait(40); }
  ok(w.eval("LIB.sel.size") === 0, "a bundled row cannot be selected");

  // this path once crashed: classList.add("") on an unselected import row
  w.eval("LIB.filter='midi'; LIB.page=0; renderSongs();");
  await wait(60);
  const impRows = () => [...d.querySelectorAll(".songrow")].filter(r => r.textContent.includes("Song "));
  ok(impRows().length === 2, "imported rows render in select mode without throwing");
  env.click(impRows()[0]); await wait(40);
  ok(w.eval("LIB.sel.size") === 1, "tapping an import selects it");
  env.click(impRows()[0]); await wait(40);
  ok(w.eval("LIB.sel.size") === 0, "tapping it again deselects");

  section("Library — removal takes two taps");
  w.eval("LIB.sel = new Set(['imp-A','imp-B']); renderSongs();");
  await wait(40);
  env.click(d.getElementById("lib-remove"));
  await wait(60);
  ok(w.eval("SAVE.imports.length") === 3, "one tap deletes nothing");
  ok(/confirm/i.test(d.getElementById("lib-remove").textContent), "the button asks for confirmation");
  env.click(d.getElementById("lib-remove"));
  await wait(250);
  ok(w.eval("SAVE.imports.length") === 1, "the second tap removes both selected songs");
  ok(w.eval("LIB.selecting") === false, "select mode exits after removal");

  section("Library — removing an audio import cleans up everything");
  w.eval("LIB.filter='audio'; LIB.page=0; LIB.selecting=true; LIB.sel=new Set(['imp-C']); renderSongs();");
  env.click(d.getElementById("lib-remove")); await wait(60);
  env.click(d.getElementById("lib-remove")); await wait(250);
  ok(w.eval("SAVE.imports.length") === 0, "library entry gone");
  ok(!env.idb.has("imp-C"), "stored recording deleted from IndexedDB");
  ok(w.eval("!SAVE.audioPair['imp-C']"), "pairing record deleted");
  ok(w.eval("!decodedCache.has('imp-C')"), "decoded buffer released");
  ok(w.eval("!SAVE.best['imp-C::hard::L6']"), "its saved bests deleted");
  ok(w.eval("!!SAVE.best['ode-to-joy::easy']"), "bundled songs' bests untouched");

  section("Library — select mode never leaks across navigation");
  w.eval("LIB.selecting = true; LIB.sel = new Set(['x']); show('scr-title');");
  ok(w.eval("LIB.selecting") === false && w.eval("LIB.sel.size") === 0,
     "leaving the library drops select mode");

  section("Settings — clear-all routes through the same cleanup");
  w.eval(`SAVE.imports = [{id:"z1",title:"Z1",composer:"x",source:"midi",bpm:120,duration:10,
      tracks:[{name:"M",prog:0,isDrum:false,notes:[{t:1,d:0.2,p:60,v:96}]}]}];
    SAVE.audioPair["z1"] = { name:"z", size:1, durable:true };
    SAVE.best["z1::easy"] = { grade:"S" }; renderSettings();`);
  env.idb.set("z1", {});
  env.click(d.getElementById("btn-clearimports"));
  await wait(250);
  ok(w.eval("SAVE.imports.length") === 0, "all imports removed");
  ok(!env.idb.has("z1"), "their recordings removed");
  ok(w.eval("!SAVE.best['z1::easy']"), "their bests removed (this used to leak forever)");
  env.dom.window.close();
}

/* ===================================================== 3. DECODED CACHE */
{
  const env = await makeDom();
  const { w } = env;
  w.eval("Audio2.ensure()");   // startPlay does this before any decode in the real flow
  const keys = () => JSON.parse(w.eval("JSON.stringify([...decodedCache.keys()])"));

  section("Decoded-audio cache — bounded");
  ok(w.eval("DECODED_MAX") >= 1, "a cap is defined");
  w.eval("decodedCache.clear(); cacheDecoded('A',{n:'A'}); cacheDecoded('B',{n:'B'}); cacheDecoded('C',{n:'C'});");
  ok(w.eval("decodedCache.size") === 2, "cap enforced on write");
  ok(JSON.stringify(keys()) === '["B","C"]', "oldest entry evicted");

  section("Decoded-audio cache — reads refresh (true LRU)");
  w.eval(`decodedCache.clear(); cacheDecoded('A',{n:'A'}); cacheDecoded('B',{n:'B'});
    SAVE.audioPair['A'] = { name:'a.mp3', size:1, offset:0, durable:true };
    SAVE.audioPair['B'] = { name:'b.mp3', size:1, offset:0, durable:true };`);
  env.resetDecodeCount();
  const hit = await w.eval("preparePairedAudio({ id:'A', source:'audio', title:'A' })");
  ok(hit && hit.n === "A", "a cached buffer is returned");
  ok(env.decodeCount === 0, "a cache hit does not re-decode");
  ok(JSON.stringify(keys()) === '["B","A"]', "the read moved A to most-recent");
  w.eval("cacheDecoded('C',{n:'C'});");
  ok(w.eval("decodedCache.has('A')") && !w.eval("decodedCache.has('B')"),
     "the replayed song survives; the stale one is evicted");

  section("Decoded-audio cache — eviction is lossless");
  env.idb.set("B", { arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)) });
  env.resetDecodeCount();
  const revived = await w.eval("preparePairedAudio({ id:'B', source:'audio', title:'B' })");
  ok(!!revived, "an evicted song still plays");
  ok(env.decodeCount === 1, "it re-decodes from IndexedDB exactly once");
  ok(w.eval("decodedCache.size") <= w.eval("DECODED_MAX"), "still within the cap afterwards");

  section("Decoded-audio cache — repeat reads don't grow it");
  w.eval("decodedCache.clear(); cacheDecoded('A',{n:'A'});");
  for (let i = 0; i < 5; i++) await w.eval("preparePairedAudio({ id:'A', source:'audio', title:'A' })");
  ok(w.eval("decodedCache.size") === 1, "five reads leave one entry");
  env.dom.window.close();
}

/* ======================================================= 4. HOLD INPUT */
{
  const env = await makeDom();
  const { d, w } = env;
  const pad = (i) => d.querySelectorAll("#pads .pad")[i];
  const setT = (t) => w.eval(`G.startAt = Audio2.now() - ${t};`);
  const note = (i) => JSON.parse(w.eval(`JSON.stringify(G.run.notes[${i}])`));
  const arm = () => w.eval(`
    Audio2.ensure(); activePtr.clear();
    SAVE.calibrated = true; SAVE.offset = 0;
    G.playing = true; G.paused = false; G.lanes = 4; G.effDur = 20;
    buildPads(4);
    G.run = CORE.newRun([
      { id:0, t:1.0, lane:0, d:1.0 },
      { id:1, t:1.5, lane:1, d:0   },
      { id:2, t:2.4, lane:0, d:1.0 }
    ], { id:"x", title:"x" }, "normal", [], { mode:"auto" });
  `);

  section("Holds — a second thumb in another lane must not break the hold");
  arm();
  setT(1.0); env.pointer(pad(0), "pointerdown", 1);
  ok(note(0).holding === true, "the hold begins");
  setT(1.5); env.pointer(pad(1), "pointerdown", 2);
  env.pointer(d, "pointerup", 2);
  ok(note(0).holding === true, "tapping and releasing another lane leaves it held");

  section("Holds — iOS pointercancel is not a release");
  arm();
  setT(1.0); env.pointer(pad(0), "pointerdown", 1);
  setT(1.3); env.pointer(d, "pointercancel", 1);
  ok(note(0).holding === true,
     "a system-cancelled pointer keeps the hold alive (iOS fires this on multi-touch)");

  section("Holds — a late-lifting finger can't release the next hold");
  arm();
  setT(1.0); env.pointer(pad(0), "pointerdown", 1);        // finger A starts hold 1
  setT(2.1); w.eval("CORE.tickHolds(G.run, songTime() - SAVE.offset)");  // hold 1 auto-completes
  setT(2.4); env.pointer(pad(0), "pointerdown", 2);        // finger B starts hold 2, same lane
  ok(note(2).holding === true, "finger B's hold begins");
  setT(2.6); env.pointer(d, "pointerup", 1);               // finger A finally lifts
  ok(note(2).holding === true, "finger A's late lift does not release finger B's hold");

  section("Holds — a genuine release still completes");
  arm();
  setT(1.0); env.pointer(pad(0), "pointerdown", 1);
  setT(1.95); env.pointer(d, "pointerup", 1);
  ok(note(0).holdDone === true, "released near the tail: completed");
  ok(w.eval("G.run.holdsDone") === 1, "counted as a completed hold");

  section("Holds — early release earns prorated credit");
  arm();
  setT(1.0); env.pointer(pad(0), "pointerdown", 1);
  const head = w.eval("G.run.score");
  setT(1.5); env.pointer(d, "pointerup", 1);               // half held
  const after = w.eval("G.run.score");
  ok(after > head, "partial credit is awarded (" + head + " -> " + after + ")");
  ok(w.eval("G.run.holdsDone") === 0 && w.eval("G.run.holdsPartial") === 1,
     "counted as partial, not complete");
  // the broken hold must not itself count as a miss: only the two notes this
  // test never taps should be missed
  const res = JSON.parse(w.eval("JSON.stringify(CORE.finishRun(G.run))"));
  ok(note(0).grade === "perfect", "the note keeps its Perfect grade after the hold broke");
  ok(res.miss === 2, "a broken hold is not counted as a miss (" + res.miss + " misses = the 2 untapped notes)");
  env.dom.window.close();
}

summary();
