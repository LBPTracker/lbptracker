# Steering index — LBP Tracker

Building a faithful re-implementation of LittleBigPlanet 3's in-game **Music Sequencer** as a
standalone tracker, in the browser. "Faithful" is the whole point of the project: the target is not
*a* tracker that sounds nice, it is a tracker whose output you cannot tell apart from the game's.

Rules for this workspace's steering:
- **All steering files must always be written in English.**
- One topic per file under `steering/`. When adding a topic, create `steering/<topic>.md`
  (English, kebab-case name) and add a one-line entry to the list below saying *when to read it*.
- **Each fact lives in exactly one file — here or in cwlib-ts — and every other file points at
  it.** When a measurement changes, change it where it lives and leave the pointers alone. A
  summary row restating a transcript elsewhere is where two copies drift apart, and the drift is
  invisible because both halves look measured.
- Steering holds durable knowledge about the target (the game) and about how we intend to build.
  Session history belongs to the auto-memory. A wrong turn earns a place in
  `answered-questions.md` only if it is a trap the next reader could fall into again, and it is
  written as the trap, not as the story.
- Facts in steering must be **measured**, not remembered. Every non-obvious claim here was taken
  out of the game's own bytes; if you add one, say how you measured it so the next session can
  re-check it. Where something is still a guess, or is a decision rather than a measurement, it
  lives in `open-questions.md`, not in the descriptive files.

Steering files (read on demand, per the hints):
- [steering/project-brief.md](steering/project-brief.md) — **read FIRST**: what we are building,
  what "faithful" means concretely and how far each part of it has been reached, the deliberate
  deviations, scope, and what counts as evidence here.
- [steering/sequencer-engine-inputs.md](steering/sequencer-engine-inputs.md) — **read before
  touching `lib/src/instrument.ts`, `scale.ts` or `thermometer.ts`**: what the `RInstrument` and
  sample-slot fields mean to the engine (their layout and reader are cwlib-ts's), the playback formula,
  the clip the eboot builds per placement, `Key` and `Scale`, the board's size limit and the
  sequencer's thermometer.
- [steering/synth-engine.md](steering/synth-engine.md) — **read before touching anything in
  `packages/lbp-tracker-lib/src` that makes sound**: what `fmodextinput.prx` does with that data —
  the state block, the clock, the voice, the pitch formula, the sampler, all 27 `Params`, the pan
  law, the voice pool and the echo — with the address of every reading.
- [steering/lbp-audio-engine.md](steering/lbp-audio-engine.md) — read for everything downstream of
  the synthesiser: FMOD Ex 4.44.10 and how little of it the game drives, the sequencer's DSP chain
  (`SMS Reverb`, `SMS WaveHammer`), the 7.1 output stage and the stereo fold.
- [steering/level-sources.md](steering/level-sources.md) — **read before touching how a level is
  fetched** (`lbparchive.ts`, `bonsai.ts`, `song-index.ts`, the three panels, `resource-walk.ts`):
  the public archive and its index, why the route is a hash, the song index and its files, and
  Bonsai and its API.
- [steering/game-assets.md](steering/game-assets.md) — read before touching audio data: where the
  sequencer's samples really are (`.smp` files in the FARCs, by GUID — not the FSB banks), their
  loop points, the FSB4 format and codecs for the SFX side, and the asset-licensing stance.
- [steering/midi-interchange.md](steering/midi-interchange.md) — **read before touching
  `packages/lbp-tracker-lib/src/midi.ts`, or before adding a field to `Sequencer` or `Track`**:
  every side channel the MIDI file carries, what each costs over the corpus, and which one can go
  stale.
- [steering/ableton-interchange.md](steering/ableton-interchange.md) — **read before touching
  `packages/lbp-tracker-lib/src/als.ts`, `als-xml.ts` or `als-sampler.ts`**: why the `.als` is Live
  11.3's schema member for member, the units read off Live's own files and Live itself, the optional
  Samplers built from the game's instruments, the corpus numbers, and how Live was made to check it.
- [steering/tracker-architecture.md](steering/tracker-architecture.md) — read before starting
  implementation: the three packages and the tools package, where the seam runs, why the mixer is ours and lives in
  an AudioWorklet, why the web layer has a bundler and Vue and the libraries have neither, the
  live player's invariants, the build order and what exists.
- [steering/editor.md](steering/editor.md) — **read before touching `index.html`, `src/daw.ts`,
  `src/daw/`, `src/editor/`, `src/player.ts` or `lib/src/song.ts`**: the app as one page around
  one song, what the arrange view draws and why it matches the game's two grids, the editable model
  and its boundary through the record encoder, the player and which edits rebuild the plan, the two
  canvases, how to check it, and what is not there yet.
- [steering/eboot-re.md](steering/eboot-re.md) — **read before opening the eboot or a PRX**: the
  address conventions (the delta trap that costs hours), the techniques that worked, and every
  anchor already mapped.
- [steering/tools.md](steering/tools.md) — read before reaching for anything in `tools/`,
  `packages/*/dev/` or `packages/lbp-tracker-tools` (the song index's builder): what each script
  is for, the trap each exists because of, and the environment variables.
- [steering/open-questions.md](steering/open-questions.md) — **read before planning a work
  session**: the deliberate deviations and what would settle each, the measured residues nothing
  models yet, and the two questions that are not about fidelity at all.
- [steering/answered-questions.md](steering/answered-questions.md) — **read before re-deriving
  anything**: per settled question, the answer in a line, where its measurement now lives, and the
  wrong turns taken on the way — which are the useful part.

**What the game's files hold is cwlib's, and so is its steering**, in the sibling checkout's
[CLAUDE.md](../cwlib-ts/CLAUDE.md) and `../cwlib-ts/steering/`. Read it there before writing any
parser, reader or writer, and before trusting a field's meaning:
- [level-files.md](../cwlib-ts/steering/level-files.md) — the container, the Thing stream, plans,
  streaming chunks, the dependency table, `FAR4` saves, the `.mod`, **the corpora**, and the
  reader's version bound.
- [sequencer-data-model.md](../cwlib-ts/steering/sequencer-data-model.md) — **read before writing
  any parser or playback code**: `PSequencer` / `PInstrument` with offsets, the stream
  conventions, the 4-byte note record, and the circuit-board timeline.
- [export-to-game.md](../cwlib-ts/steering/export-to-game.md) — **read before touching the plan
  export** (`lib/dev/export-plan.ts`, `web/src/daw/plan-export.ts`): the writer, the measured
  Thing shape, and what proves it.
- [lbp-modding-toolchain.md](../cwlib-ts/steering/lbp-modding-toolchain.md) — read before trusting
  or porting anything from ennuo's toolkit: the provenance rule and where we differ from it.
- its own `tools.md`, `open-questions.md` and `answered-questions.md`. Question numbers are one
  sequence across both repositories.

## Layout — two npm workspaces and one git dependency, since 2026-10-18

| directory | package | what it is |
|---|---|---|
| `../cwlib-ts` (github.com/LBPTracker/cwlib-ts) | `@lbptracker/cwlib` | reading **and writing** LBP's serialised resources: container, Thing graph, 50 part readers, saves, archives, and the `.plan` writer — **its own repository**, installed from git |
| `packages/lbp-tracker-lib` | `@lbptracker/lib` | turning that into sound: sampler, DSP chain, render pipeline, MIDI — and `song.ts`, the editable song |
| `packages/lbp-tracker-web` | `@lbptracker/web` | the app: one page, one song, five views — Vite, Vue for the panels, canvases for the grids |

Each has its own `src/`, `test/` and `dev/`: Node harnesses in the libraries, the typecheck entry
point in the web package. `../cwlib-ts` is the sibling checkout of cwlib; a path written that way in
steering means a file in that repository. ❗ **A change to cwlib is a commit and a push there, then
`npm update @lbptracker/cwlib` here**: the lockfile pins its commit. *The monorepo* in
`steering/tracker-architecture.md` has why, and how to try a change before pushing it. Imports cross by package name:
`import { readWorld } from '@lbptracker/cwlib/things/level.ts'`.

- `npm install` — **required**: workspaces resolve the package names through symlinks in
  `node_modules`; cwlib is cloned from GitHub and built into `dist/` by its `prepare`.
- `npm test` — `node --test`, both workspaces at once, from the root (446 tests, 2026-10-18; cwlib's
  67 run in its own repository);
  `npm test -w @lbptracker/lib` for one package.
- `npm run typecheck` — fans out to each package's own `typecheck` script: `tsc -p .` in
  `lbp-tracker-lib`, `vue-tsc` for the web package. ⚠️ **The web package checks `.vue` through
  `typescript-native-bridge`**: `vue-tsc` needs a JavaScript API and `typescript@7` is the native
  compiler and has none. See `packages/lbp-tracker-web/dev/typecheck.mjs` and *The toolchain* in
  `steering/tracker-architecture.md`.
- `npm run check` — typecheck, then tests: the one command to run before a commit.
- `npm run serve` / `build` / `preview` — Vite, **in the web package only**; `127.0.0.1:8173` and
  `:8174`.
- `npm run stage` / `deploy` — the site **plus the assets it fetches**, for Cloudflare: `vite
  build`, then `packages/lbp-tracker-web/dev/stage-site.ts` copies `fixtures/rinst` and
  `fixtures/smp` into `dist/fixtures/` under boring names and writes `_headers`; `deploy` then runs
  `wrangler deploy` on `packages/lbp-tracker-web/wrangler.jsonc`. ⚠️ Plain `build` still never
  copies `fixtures/`. *Deployment* in `steering/tracker-architecture.md` has the measurements.
  ❗ **Every deploy ends with a Discord post of the changelog**, through a webhook whose URL is a
  secret kept out of the repository; the rule and the recipe are in that same section.
- The two workspaces depend on each other as `"*"`, so a version bump touches the three manifests
  here and nothing else (cwlib keeps its own version); the web footer reads its version out of its own `package.json`
  (`packages/lbp-tracker-web/src/version.ts`), and a test holds the root manifest to the same number.

❗ **`lbp-tracker-lib` has no build step and must keep it that way.** Node runs its TypeScript
directly, so the file the browser executes is the file `node --test` executes, which is what the
fidelity argument rests on. The bundler stops at the web package's edge. cwlib is the one
exception, and it is forced: it arrives in `node_modules` as a real copy, where Node refuses to
strip types, so it ships the `dist/*.js` its `prepare` builds — and Node and the browser both run
that same file.

⚠️ **An import map does not reach a Worker or an AudioWorklet** — measured in Chrome, table in
`steering/tracker-architecture.md`. That is *why* the web package has a bundler, and it is the trap
to remember before moving anything into `audio/mixer-worklet.ts`'s import graph: a bare specifier
in there fails to load and the page goes silent with nothing on the main thread to say why.

`fixtures/` is gitignored and always has been: it holds the user's own extracted game data and
other people's levels, and none of it may be committed. Two of its directories are *staged* into a
deployment by the explicit step above; that is the only route out. `steering/tools.md` says how it
is filled.
