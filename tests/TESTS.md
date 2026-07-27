# Cadence test kit

Three layers, because they catch different classes of bug. Run all three before
calling a change done.

```
node tests/cadence.tests.mjs                     # CORE logic          — 762 assertions
node tests/shell.tests.mjs                       # DOM / storage / UI  —  62 assertions
node tests/detector-metrics.mjs <audio-file>     # chart quality on real audio
```

Both test files exit non-zero on failure, so they work in a pipeline.

## Setup

```
npm install                # jsdom, for shell.tests.mjs only
```

`detector-metrics.mjs` needs `ffmpeg` on PATH to accept mp3/m4a/wav. Without it,
pass a raw mono float32 @ 44100 file (`.f32`) instead:

```
ffmpeg -i song.mp3 -ac 1 -ar 44100 -f f32le song.f32
```

All three resolve `index.html` at the repository root, relative to their own
location rather than the working directory, so they run from anywhere. Pass
`--build cadence.html` to `detector-metrics.mjs` to point at a different file.

## 1. `cadence.tests.mjs` — CORE

Extracts everything between the `/* CORE-START */` and `/* CORE-END */` markers
and tests it as a pure module: no DOM, no audio, fast. Covers MIDI and Forge
parsing, chart generation, thinning, lane assignment at 4/6/8 lanes, grading,
holds, Crescendo, Fortissimo, the combo multiplier, weekly events, share codes,
the three audio detectors, sustain measurement, and alignment.

**Its most important job is regression, not coverage.** Several assertions exist
solely to prove that bundled charts have not moved — those charts back the
weekly event and every saved best, so a chart change silently invalidates
scores. If a change makes those fail, the change is wrong unless invalidating
scores is the deliberate intent.

## 2. `shell.tests.mjs` — the shell

Runs the real `index.html` in jsdom with mocked AudioContext, canvas and
IndexedDB (see `shell-harness.mjs`). Four areas, each of which had a genuine bug
that only this layer could catch:

| Area | The bug it exists to prevent |
|---|---|
| Batch import | A corrupt file used to abort the whole batch, and a failed audio import left an orphaned blob in IndexedDB. |
| Selective deletion | Clear-all deleted songs but left every saved best behind, accumulating forever. Also `classList.add("")` threw on any unselected import row. |
| Decoded-audio cache | Three unbounded `decodedCache.set` sites; a decoded 7-minute stereo track is ~140MB, so a batch could exhaust a phone. |
| Hold input | iOS fires `pointercancel` on your holding finger the moment a second finger lands, which used to end the hold. A late-lifting finger could also release the *next* hold in the same lane. |

Writing tests at this layer is worth the trouble: three of those four were found
by the test rather than by playing.

## 3. `detector-metrics.mjs` — chart quality

Grades audio-import charts against ground truth computed by a **different
method** than the detectors under test: a time-domain low-band envelope peak
finder sharing no code with the spectral detectors it judges. Never grade a
detector with itself.

Reference figures for Fire Cross (OC ReMix, 6:45, dense guitar rock — the file
these detectors were tuned against):

```
ground-truth booms      988  (2.43/s)
boom detector recall    100%
Easy   601 notes  1.48/s  precision 100.0%  recall  60.8%  holds  70
Normal 1078 notes 2.66/s  precision  91.7%  recall 100.0%  holds 114
Hard   1812 notes 4.46/s  precision  54.5%  recall 100.0%  holds 397
analysis time           ~5s
```

How to read it: **precision** is the share of chart notes landing on an audible
thump — Easy should be at or near 100%, because every note it plays should be
one you can hear. **Recall** is the share of thumps that got a note — Easy is
deliberately sparse (it samples the drum line rather than transcribing it), but
Normal should be high. **Max concurrent holds must stay at 2 or below** on audio
charts; above that the chart demands more fingers than a player has.

A cleaner recording (piano, orchestral, anything with space in the mix) should
score better than these figures. A denser one will score worse, and that's the
honest limit of charting by ear rather than a bug to tune away — the paired-MIDI
import path exists for those.

## Notes for whoever picks this up

- CORE is shared byte-for-byte with Cadence Heroes. Any change inside the
  markers must be mirrored there; report the CORE byte length and sha256 so the
  other side can prove its copy matches:
  ```
  python3 -c "import re,hashlib;c=re.search(r'/\* CORE-START \*/([\s\S]*?)/\* CORE-END \*/',open('index.html').read()).group(1);print(len(c),hashlib.sha256(c.encode()).hexdigest())"
  ```
- Audio behaviour cannot be verified headlessly. These suites prove structure,
  timing and bookkeeping; whether something *sounds* right is a listening test
  only a person can run.
- When a test fails, check the fixture before the code. Several apparent
  failures during development were bad mocks — a blob without `arrayBuffer`, or
  forgetting that `Audio2.ctx` is null until `Audio2.ensure()` runs.
