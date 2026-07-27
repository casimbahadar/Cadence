# Cadence

A mobile-first rhythm game that charts any song you give it — a MIDI file, a
Forge Sequencer project, or a plain MP3 it listens to and figures out by ear.

One HTML file. No dependencies, no build step, no server. Open it and play.

**▶ [Play it here](https://casimbahadar.github.io/Cadence/)** *(update this link
to match your repository name)*

---

## What it does

Notes fall down four lanes and you tap them as they cross the line. Twenty-four
songs are built in, and you can add your own three different ways.

- **Three difficulties** per song, generated from the source material rather than
  hand-authored — Easy, Normal and Hard are different selections of the same
  music, not different songs.
- **4, 6 or 8 lanes** on tablet and desktop; phones stay at 4 because more is
  visually cramped. Keyboard play is supported (`DFJK`, `SDFJKL`, `ASDFJKL;`).
- **Hold notes** where the music actually sustains, with prorated credit if you
  let go early to reach something else.
- **Weekly event** — a rotating song and difficulty, the same for everyone, with
  shareable score codes.
- **Everything is local.** Nothing is uploaded, ever. See [Privacy](#privacy).

## Bringing your own music

| Import | What happens | Best for |
|---|---|---|
| **MIDI** | Instruments and pitch decide the lanes. Precise, because the note data is exact. | Anything you can find a MIDI for. |
| **MIDI + audio** | Same chart, but the real recording plays over it — vocals and all. Cadence listens to the recording and syncs it to the chart automatically. | Songs you want to hear properly. |
| **Audio only** | No MIDI needed. Cadence analyses the recording, finds the hits, and builds the chart itself. | Anything you have as a file. |
| **Forge Sequencer** | Your own compositions from [Musical Forge Studio](https://github.com/casimbahadar/Musical-Forge-Studio) play as first-party charts. | Music you wrote. |

You can select several files at once in any of these. Imported recordings are
stored on your device so they load automatically next time.

### How audio-only charting works

Three detectors run over the waveform, each feeding a different difficulty:

- **Booms** — a time-domain low-band envelope finds the audible thumps: kick
  drums and bass hits. These *are* the Easy chart.
- **Percussion** — harmonic/percussive separation by median filtering isolates
  the drum layer from sustained content, adding snares, hats and cymbals for
  Normal.
- **Onsets** — spectral flux catches melodic attacks, which Hard adds on top.

A fourth pass measures how long each note actually rings, so holds land where the
music genuinely sustains rather than at arbitrary intervals.

The result is honest rather than perfect. On a dense guitar-rock remix, every
Easy note lands on an audible thump (100% precision) while covering about 61% of
them — Easy samples the drum line rather than transcribing it. A cleaner mix
scores better; a denser one worse. When analysis suggests a recording will chart
poorly, the app says so at import instead of handing you a bad chart silently.

## Scoring

Four systems stack:

- **Note grade** — Perfect (±65 ms) or Good (±130 ms).
- **Combo multiplier** — climbs from ×1 to ×2 as you keep the chain alive, scaled
  so short songs can still reach the cap.
- **Crescendo** — the densest passage of each third of the song glows gold and
  pays double, with a flat bonus for a flawless zone.
- **Fortissimo** — Perfect notes charge a meter; when it fires, everything scores
  double for a stretch. Auto by default, or switch to Manual in Settings and
  save it for a Crescendo — the two stack to ×4.

## Controls

Tap the pads, or the lane itself. On desktop use the home row. Holds need the pad
held down; releasing early keeps a share of the bonus proportional to how much
you held.

## Privacy

Everything stays on your device. Scores and settings live in `localStorage`;
imported recordings live in `IndexedDB`. No account, no analytics, no network
requests — the page works fully offline once loaded. Music you import is never
transmitted anywhere, which also means what you import is between you and the
file.

## Development

There is no build step. `index.html` is the entire application; edit it and
reload.

```bash
npm install          # jsdom, for the shell tests only
npm test             # CORE suite + shell suite
npm run serve        # http://localhost:8080
```

| Command | What it checks |
|---|---|
| `npm run test:core` | Chart generation, grading, parsing, detectors — 762 assertions, no DOM |
| `npm run test:shell` | Import, deletion, storage, pointer input in a headless browser — 62 assertions |
| `npm run metrics <file>` | Chart quality against a real recording (needs `ffmpeg`) |
| `npm run core-hash` | CORE byte length and sha256 |

See [`tests/TESTS.md`](tests/TESTS.md) for what each layer catches and why.

### The CORE block

Everything between the `/* CORE-START */` and `/* CORE-END */` markers is pure
logic with no DOM access — parsing, chart generation, grading, scoring, the audio
detectors. It is extracted directly for testing, and it is shared byte-for-byte
with **Cadence Heroes**, the RPG built on the same engine. Any change inside the
markers has to be mirrored there; `npm run core-hash` is how both sides prove
their copies match.

## Deploying

GitHub Pages serves this as-is. Settings → Pages → deploy from your default
branch, root folder. `index.html` is at the root, and `.nojekyll` stops Jekyll
from touching anything.

## Music

All twenty-four bundled songs are arrangements of **public-domain** works,
sequenced for this project:

Ode to Joy · Twinkle Variations · Minuet in G · Greensleeves · Korobeiniki · In
the Hall of the Mountain King · The Entertainer · Für Elise · Canon in D · Eine
kleine Nachtmusik · The Blue Danube · Habanera · Turkish March · William Tell
Finale · Sakura Sakura · Kojō no Tsuki · Tōryanse · Sōran Bushi · Furusato ·
Itsuki Lullaby · Kuroda Bushi · Rokudan no Shirabe · The General's Command ·
Ambush from Ten Sides

The underlying compositions are out of copyright; the arrangements are original
to this project. Music you import yourself is yours, stays on your device, and
is never redistributed by this app.

## License

Not yet chosen — see the note in the repository discussion. Until a `LICENSE`
file is added, default copyright applies: the author retains all rights, and this
code may be read but not reused, modified or redistributed.
