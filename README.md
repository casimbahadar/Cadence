# Cadence

A mobile-first rhythm game that charts any song you give it — a MIDI file, a
Forge Sequencer project, or a plain MP3 it listens to and figures out by ear.

One HTML file. No dependencies, no build step, no server. Open it and play.

**▶ [Play it here](https://casimbahadar.github.io/Cadence/)** *(update this link
to match your repository name)*

---

## What it does

Notes fall down four lanes and you tap them as they cross the line. **176 songs
are built in** — 24 hand-arranged public-domain works and 152 original
compositions — and you can add your own three different ways.

- **Three difficulties** per song, generated from the source material rather than
  hand-authored — Easy, Normal and Hard are different selections of the same
  music, not different songs.
- **4, 6 or 8 lanes** on tablet and desktop; phones stay at 4 because more is
  visually cramped. Keyboard play is supported (`DFJK`, `SDFJKL`, `ASDFJKL;`).
- **Hold notes** where the music actually sustains, with prorated credit if you
  let go early to reach something else.
- **Weekly event** — a rotating song and difficulty, the same for everyone, with
  shareable score codes. The rotation walks the entire 176-song catalogue.
- **Search** the library by title or composer, because 176 songs is a lot to page
  through.
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
reload. It is ~2.7MB, most of which is packed song data — about 200KB over the
wire once the server gzips it.

```bash
npm install          # jsdom, for the shell tests only
npm test             # CORE suite + shell suite
npm run serve        # http://localhost:8080
```

| Command | What it checks |
|---|---|
| `npm run test:core` | Chart generation, grading, parsing, detectors — 762 assertions, no DOM |
| `npm run test:shell` | Import, deletion, storage, pointer input, the bundled library in a headless browser — 91 assertions |
| `npm run metrics <file>` | Chart quality against a real recording (needs `ffmpeg`) |
| `npm run core-hash` | CORE byte length and sha256 |

See [`tests/TESTS.md`](tests/TESTS.md) for what each layer catches and why.

### Where the songs live

The 24 public-domain arrangements sit inside CORE. The 152 originals sit
*outside* it, as `LIB_PACKED` — delta-encoded milliseconds parsed from a JSON
string, with each song's notes decoded lazily the first time something asks for
them. That split is deliberate: CORE is shared with Cadence Heroes, which has its
own soundtrack, so song data is treated as content rather than engine logic.

### The CORE block

Everything between the `/* CORE-START */` and `/* CORE-END */` markers is pure
logic with no DOM access — parsing, chart generation, grading, scoring, the audio
detectors. It is extracted directly for testing, and it is shared byte-for-byte
with **Cadence Heroes**, the RPG built on the same engine. Any change inside the
markers has to be mirrored there; `npm run core-hash` is how both sides prove
their copies match.

## Icons and home-screen install

`icons/` holds the generated icon set and `manifest.webmanifest` describes the
installed app. Saved to a phone home screen, Cadence launches without browser
chrome, portrait-locked, on its own dark background.

The favicon is *also* inlined into `index.html` as an SVG data URI, so the file
still carries its identity when opened standalone with no server and no
`icons/` folder next to it. Missing PNGs degrade to that inline icon rather than
to nothing.

To change the mark, replace `tools/icon-source.png` (1024x1024) and re-run the
generator — it derives every size from that one file:

```bash
python3 tools/make-icons.py      # needs Pillow
```

It does two things the source can't do for itself. Artwork usually arrives as a
rounded tile on a background, but iOS and Android apply their *own* rounded
mask, so a pre-rounded source shows its corners inside theirs — the generator
zooms and centre-crops to full bleed and lets the platform do the only rounding.
It also builds a separate maskable variant with the whole picture inside
Android's 80% safe zone, so an adaptive crop can't cut anything important.

One caveat worth testing rather than trusting: on iOS, a site saved to the home
screen has historically used a **separate storage bucket** from Safari, so scores
and settings made in Safari may not appear in the home-screen copy. Check before
relying on it.

## Deploying

GitHub Pages serves this as-is. Settings → Pages → deploy from your default
branch, root folder. `index.html` is at the root, and `.nojekyll` stops Jekyll
from touching anything — including the `icons/` folder and the manifest, which
must be served alongside `index.html` for home-screen installs to pick them up.

## Music

**24 arrangements of public-domain works**, sequenced for this project:

Ode to Joy · Twinkle Variations · Minuet in G · Greensleeves · Korobeiniki · In
the Hall of the Mountain King · The Entertainer · Für Elise · Canon in D · Eine
kleine Nachtmusik · The Blue Danube · Habanera · Turkish March · William Tell
Finale · Sakura Sakura · Kojō no Tsuki · Tōryanse · Sōran Bushi · Furusato ·
Itsuki Lullaby · Kuroda Bushi · Rokudan no Shirabe · The General's Command ·
Ambush from Ten Sides

The underlying compositions are out of copyright; the arrangements are original
to this project.

**152 original compositions**, written in
[Musical Forge Studio](https://github.com/casimbahadar/Musical-Forge-Studio) —
52 Lumoria themes and a 100-piece Forge Collection. These are original works and
are **not** public domain; they are the author's copyright. See
[License](#license), because a repository licence covers the music in this file
as well as the code.

Music you import yourself is yours, stays on your device, and is never
redistributed by this app.

## License

Not yet chosen. Until a `LICENSE` file is added, default copyright applies: the
author retains all rights, and this may be read but not reused, modified or
redistributed.

Worth deciding deliberately rather than by habit, because `index.html` contains
**152 original musical compositions** alongside the code. A permissive licence
such as MIT would grant that music away on the same terms as the source — anyone
could ship the songs in their own product. If the code and the music warrant
different terms, they need separate licences, or the music needs separating from
the repository. This is a note, not legal advice.
