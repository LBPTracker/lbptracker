# Tracker architecture — how it is built, and why

Read before starting implementation. This describes the shape and the reasoning behind the
non-obvious choices, so a future session can disagree with the reasoning rather than rediscover
it. What the game does is in [synth-engine.md](synth-engine.md) and
[lbp-audio-engine.md](lbp-audio-engine.md); this file is about how *we* reproduce it.

## The central decision: own the mixer

The obvious way to build a sampler in the browser is one `AudioBufferSourceNode` per voice with
`playbackRate` set for pitch. **Do not do that for this project.** `playbackRate` resampling is the
browser's own interpolator — unspecified, different between Chrome, Firefox and Safari — and the
game's is a two-tap linear interpolator over octave mipmaps built from an int16 pair average
([synth-engine.md](synth-engine.md)). Every pitched note would carry a small, engine-dependent
timbre error, which is precisely the thing this project exists to avoid.

Instead: **one `AudioWorkletProcessor` that is the whole mixer**
(`packages/lbp-tracker-lib/src/audio/mixer-worklet.ts` around `mixer.ts`). It owns the voices, the
interpolation, the envelopes, the filter, the LFOs, the per-channel gain and pan, the two sends and
the effects, and emits final stereo frames. That gives an interpolator matched to the engine,
sample-accurate scheduling instead of `setTimeout` drift, deterministic output — the same project
renders identically on every browser and every run — and offline rendering by reusing the same
`Mixer`.

⚠️ **Offline export must drive `Mixer` directly, not the worklet.** Measured in Chrome: samples and
voices posted to an `AudioWorkletNode` port *before* `OfflineAudioContext.startRendering()` never
reach the processor, and the render comes out silent; the identical sequence in a realtime
`AudioContext` produces the expected tone (441 Hz at the expected amplitude). Port messages are
not part of the offline render's ordering guarantees. `Mixer` is plain TypeScript with no Web
Audio, so calling it in a loop for export is the same code path. Do not "fix" it with delays.

`packages/lbp-tracker-lib/src/render.ts` is that loop: the whole pipeline as one platform-neutral
function, with `packages/lbp-tracker-lib/dev/render-level.ts` the Node wrapper and
`packages/lbp-tracker-web/src/render-worker.ts` the browser one. ✔ On 2026-09-02 the two produced
the *same file* — 368 seconds of `This Is Halloween`, 70,704,044 bytes, one SHA-256.

### Each voice's clock is the engine's block

The engine derives everything modulation-driven at both ends of a **256-frame chunk** and ramps
across it, and the AudioWorklet's render quantum is 128, so the grid cannot be "the offset within
this call". Three things follow, all in `mixer.ts`: a voice counts its grid in its own rendered
frames, from its first frame and again from its gate — the two events the engine only takes at a
chunk's top (*60* in [answered-questions.md](answered-questions.md)) — so a 128-frame live call and
a whole-song offline call evaluate on the same boundaries; a voice evaluates a *segment* — the rest
of the block, cut short only at its own events (the gate, a cut, our fade) — once, and a caller's
slice merely continues it (`Voice.segLeft`); and a voice whose envelope ended inside a segment still
renders that segment to its end before it is dropped, or the ladder's tail would stop at the slice
boundary (−33 dB when it did). A voice is one of the engine's records and carries its layers inside
it (`VoiceSpec.layers`), so the pool, the tag and the segment are all per note. ❗ **On the
engine's clock, the default since 2026-10-12, the grid is not the voice's own**: it is the song's
chunks (`VoiceSpec.engineGrid`, *The clock* in [synth-engine.md](synth-engine.md)), blocks counted
from the clock's start and cut where the step clock cut them, and the gate does not restart it.
The voice's own grid is the tracker's clock's, kept as an A/B, and the keyboard bench's.
`packages/lbp-tracker-lib/test/audio.test.ts` pins "the mixer renders the same audio whatever the
block size", and it catches a grid mistake within a minute of it being made.

## The monorepo — three packages, one seam, one of them next door

| directory | package | what it is |
|---|---|---|
| `../cwlib-ts` | `@lbptracker/cwlib` | reading LBP's serialised resources: the container, the Thing graph and its **53** part readers, plans, chunks, saves, archives, the instruments — **its own repository**, `github.com/LBPTracker/cwlib-ts` |
| `packages/lbp-tracker-lib` | `@lbptracker/lib` | turning that into sound: the sampler, the DSP chain, the render pipeline, MIDI |
| `packages/lbp-tracker-web` | `@lbptracker/web` | the app: one page, one song, five views ([editor.md](editor.md)) |

❗ **The split is by dependency direction, not by taxonomy**, and the import graph decided it:
`cwlib` is closed under its own imports and names nothing above it. That is why `scale.ts` and
`swing.ts` are in `lib` despite being sequencer facts — they are readings of `fmodextinput.prx`,
about what the *engine* does with the data. ❗ **Every resource's reader, writer and the types
that hold its data are `cwlib`'s**, whichever package uses them — `RInstrument` included, which
was `lib`'s `rinstrument.ts` until 2026-10-24 and is `@lbptracker/cwlib/resources/rinstrument.ts`; what
`lib` does with it — `instrument.ts`'s sampler model and zone walk — stays here. A test lives
with the package it exercises; `notes.test.ts` tests `cwlib`'s records but reaches for `lib`'s
`quantise`, so it sits in `lib` rather than put a `cwlib → lib` edge in a package that must not
have one.

**Platform APIs are injected, never imported into `cwlib`.** `loadResource(bytes, inflate)` takes
its inflater as an argument: `platform/node.ts` passes `zlib.inflateSync`, `platform/web.ts` a
`DecompressionStream` wrapper. That is what keeps the same parser running under `node --test`
against the corpus and in the browser against a file the user picked.

### cwlib is a git dependency

Since 2026-10-18 `cwlib` lives in its own repository, split out of `packages/cwlib-ts` with its
history (`git subtree split`; the 53 commits that touched that folder). A path written
`../cwlib-ts/…` anywhere in steering is a file in that repository, checked out next to this one.
Both workspaces depend on it as `git+https://github.com/LBPTracker/cwlib-ts.git`, and the lockfile pins
the commit.

❗ **It ships JavaScript, and that is forced, not chosen.** A git dependency lands in
`node_modules` as a real copy, not a symlink, and Node 24 refuses to strip types under
`node_modules` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on 24.20.0 with a
one-file package. So cwlib's `prepare` runs `tsc -p tsconfig.build.json` into `dist/`, which npm
does on install, and its `exports` maps `@lbptracker/cwlib/<name>.ts` onto `dist/<name>.js` with
its `.d.ts`: every import specifier here stayed as it was. The fidelity property survives in the
form that matters — `node --test` and the browser both run that same `dist/*.js` — but cwlib's
own tests run on its sources, in its repository (`npm run check` there; 67 tests, its corpus tests
find this repository's `fixtures/` through `LBP_FIXTURES`, defaulting to the sibling checkout).

- **Changing cwlib**: commit and push there, then `npm update @lbptracker/cwlib` here, which moves
  the lockfile's commit. To try a change before pushing, `npm run build` in `../cwlib-ts` and
  `npm install --no-save ../cwlib-ts` here: a `file:` install is a symlink, so it sees the fresh
  `dist/` until the next plain `npm install` puts the pinned commit back.
- ⚠️ cwlib's build is the one place `rewriteRelativeImportExtensions` is on (the bullet below says
  why it had to go here): its sources import each other only by relative path, so TS2877 never
  fires there.

## The toolchain

Node 24 strips TypeScript types at load, so `node packages/…/whatever.ts` just runs; it also ships
the test runner (`node --test` finds every `*.test.ts` across the workspaces) and zlib. **`lib`
needs nothing else**: no build, no bundler, no transpile — the file the browser runs is the file
`node --test` runs, which is the property the fidelity argument rests on. (`cwlib` builds; the
section above says why it must.)

- ⚠️ **`npm install` is required.** Workspaces resolve `@lbptracker/lib/…` through symlinks in
  `node_modules`, and `@lbptracker/cwlib` is cloned and built there.
- ❗ **Node does not strip types inside `node_modules`, and `lib` survives it** because a workspace
  entry is a symlink and Node resolves the realpath before deciding. Measured with a two-package
  probe before the split; if it ever changes, every test stops loading at once and the reason will
  not be obvious. cwlib, a real copy, did not survive it, and is why it ships `dist/`.
- ⚠️ **Strip-only type removal bans any syntax that emits code**: parameter properties, `enum`,
  `namespace` and decorators fail at load with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Declare fields
  longhand and use `as const` objects. `tsconfig.base.json` sets `erasableSyntaxOnly` to enforce it
  at compile time.
- ⚠️ **`rewriteRelativeImportExtensions` had to go**: it makes `tsc` reject every `.ts` extension
  on a non-relative specifier (TS2877, all 283 of them). `noEmit` is set and the emit is Vite's, so
  it did nothing but forbid the package names; `allowImportingTsExtensions` is what allows `.ts`.
- ⚠️ **Typechecking found a bug the tests could not.** `loop`, `loopStart` and `loopEnd` belong to
  `AudioBufferSourceNode`, not `AudioBuffer`; setting them on the buffer is silently ignored, and
  the bench's "browser resampler" control was not looping while our mixer did.
- ⚠️ **`typescript@7` is the native compiler** — a Go binary, no `lib/tsc.js`, no JavaScript API —
  and Volar, which puts `.vue` files in front of the checker, patches that API, so `vue-tsc` on it
  dies with `ERR_PACKAGE_PATH_NOT_EXPORTED: './lib/tsc'`. **`typescript-native-bridge`** is a fork
  carrying a `tsgoChecker` overlay — the API for Volar, tsgo still doing the checking — pinned to
  the same 7.0.2; `packages/lbp-tracker-web/dev/typecheck.mjs` hands `vue-tsc` its path and it
  announces itself with `TNB ACTIVE`. It is a third-party fork days old when adopted, which is why
  it checks **the web package only** and the libraries go through `tsc -p` against the real
  `typescript`. It was accepted only after being made to fail (a `const x: number = string` in
  `Fader.vue` and a `max: 'oops'` in a spec both came back as TS2322): **an exit code of 0 from a
  checker means nothing on its own.**
- ⚠️ `typescript` and `typescript-native-bridge` both declare `bin: tsc`, so npm installs neither
  shim (`node_modules/.bin` holds `vite` and `vue-tsc` and no `tsc`) and a script saying `tsc`
  dies with `'tsc' is not recognized` — which reads as a broken PATH. `lib`'s `typecheck`
  script therefore names the file: `node ../../node_modules/typescript/bin/tsc -p .`. Both
  packages are hoisted to the root `node_modules`, so the path is stable.
- Each package owns its `test` and `typecheck` scripts; the root's `typecheck` is
  `npm run typecheck --workspaces`, which runs both and exits non-zero if any fails
  (measured with a `const x: number = 'oops'` in `cwlib`: exit 1, and the web check still ran
  after it), and `npm run check` chains it with the tests. `node --test` at
  the root finds every `*.test.ts` under `packages/` in one process, which is faster than two.

## Serving and shipping: Vite, in the web package only

`npm run serve` is `vite` on `127.0.0.1:8173`; `npm run build` writes `dist/`; `npm run preview`
serves it on `:8174`. `packages/lbp-tracker-web/vite.config.ts` is the **only** build in the
repository.

❗ **Why a bundler at all, measured rather than argued.** The project ran with none until
2026-09-06 — a hand-rolled dev server stripped types per request and a hand-rolled build did the
same ahead of time (`git log -- packages/lbp-tracker-web/dev` has them). One measurement killed it,
probed in Chrome with a page carrying `{"@probe/": "./pkg/"}` and three consumers of one module:

| context | bare specifier |
|---|---|
| the page | ✔ resolves |
| `new Worker(url, {type:'module'})` | ✘ load error |
| `audioWorklet.addModule(url)` | ✘ `Failed to resolve module specifier` |

`render-worker.ts` reaches `assets.ts`, `render.ts` and `backup.ts` — the worker's module graph is
very nearly the whole engine. Without a bundler every one of those files would have to name its
neighbours with a path like `../../cwlib-ts/src/sequencer/project.ts`, and the packages would be folders with
extra steps. ⚠️ **The AudioWorklet needs `?worker&url`, not a path**:
`import MIXER_WORKLET_URL from '@lbptracker/lib/audio/mixer-worklet.ts?worker&url'` makes Vite
bundle that graph ahead of time; a bare specifier inside the worklet realm fails to load and the
page goes silent with no error on the main thread.

`?open=fixtures/levels/x.lvl` on any page fetches that file from the site and opens it as if
dropped (`widgets/open-panel.ts`): a file input cannot be filled from a script, and it is how the
pages are checked in an automated browser. The deployed site serves no levels, so there it 404s
into the page's error line. `?level=<sha1>` is the other query route and is the shareable one — a
published level fetched from the archive; *Checking it* in [editor.md](editor.md) has it.

What was kept: the libraries had no build until cwlib left the repository (the bundler stops at
the web package's edge; `node --test` runs 306 tests against the source); the output is
relocatable (`base: './'`, every path `./assets/…`, checked by grep after each build and by
serving `dist/` at a bare root);
**`fixtures/` is served, never built** — a ten-line middleware serves `/fixtures/…` in dev and
preview, and `publicDir` was not used because it would copy the lot into `dist/`; and the dev server
makes **no outbound requests** (below).

⚠️ **`asset()` anchors on `import.meta.url` and now depends on chunk depth.** It resolves against
`new URL('../', import.meta.url)` because a bare relative URL in a **worker** resolves against the
worker's directory and a leading slash breaks under a prefix — and that rests on the web package's
modules being exactly one directory below the site root (`/src/assets.ts` in dev, `/assets/assets-*.js`
in the build). Both checked in the browser; change `build.rollupOptions.output` filenames and the
fixtures 404 with no other symptom.

### Deployment — Cloudflare, assets included

`npm run deploy` is `vite build`, then `packages/lbp-tracker-web/dev/stage-site.ts`, then
`wrangler deploy` on `packages/lbp-tracker-web/wrangler.jsonc` — an assets-only Worker, no script,
`send_metrics` off. `wrangler login` once before the first deploy. Live at
<https://lbptracker.sgdc3.it> since 2026-09-06 — a Custom Domain in `wrangler.jsonc`, so Cloudflare
owns the DNS record and the certificate; the `workers.dev` address is off on purpose (313 files
uploaded on the first deploy, the sourcemaps included). ⚠️ Cloudflare canonicalises `/x.html` to
`/x` with a 307 (`html_handling` is the default `auto-trailing-slash`); since the app became one
page there is only `/`.

❗ **The staging step is the one place game data enters `dist/`.** It copies exactly what
`fixtures/rinst/manifest.json` and `fixtures/smp/manifest.json` name — 286 files, 6.7 MB on
2026-09-06 — rewrites the two manifests, and writes `_headers`: hashed bundles immutable, samples a
day, `nosniff` everywhere. `fixtures/archive` stays out; the pages read levels from archive.org.

⚠️ **The staged names are not the game's.** `publicName` turns `#` into `-sharp` and a space into
`_`, so no host ever has to decode `%23` back into a file name — the class of trap that cost a day
in `assets.ts`. The manifest is the indirection; `fixtures/` on disk is untouched;
`test/stage-site.test.ts` holds every name in the real manifests to being the identity under
`encodeURIComponent`, with no collisions (the game already has a `harp_fsharp3.smp`, which is why
the rule is `-sharp` and not `sharp`).

⚠️ **Vite's preview never exercises the staged copies** — its middleware answers `/fixtures/` from
the repository first. The check is `npx wrangler dev` (launch config `cloudflare`, port 8175),
which serves `dist/` the way Cloudflare will, `_headers` included. Measured that way on
2026-09-06: the choir's two `#` samples loaded under the staged names, the three header rules
applied, the worklet started. ⚠️ npm 11's install-script gate holds `workerd`'s and `esbuild`'s
postinstall; `wrangler dev` and `wrangler deploy --dry-run` both ran regardless, because the
platform binaries arrive as optional dependencies.

**The site is a PWA, and its parts live in `packages/lbp-tracker-web/public/`** (Vite copies that
directory to `dist/` verbatim, which is why they are there and not in `src/`):
`manifest.webmanifest`, `icon-192.png`, `icon-maskable.svg`, `robots.txt`, `sitemap.xml` and
`sw.js`. ⚠️ **The service worker is plain JavaScript at the site's root on purpose**: a worker's
scope is the path it is served from, and the bundler would give it a hashed name under
`/assets/`, whose scope is `/assets/`. ❗ It is **network-first** — every request goes to the
network and the copy it keeps is used only when that fails — because a cache-first worker would
serve the previous deployment to everyone who already visited. `dev/stage-site.ts` writes
`Cache-Control: no-cache` for `sw.js` and the manifest for the same reason.

#### Every deploy is announced on Discord

❗ **A deploy is not finished until a Discord webhook has posted what changed.** The community
follows the tool in `#lbptracker-announcements`, and a new version nobody hears of is a version
the bug reports in `#lbptracker-help` will not be about. The owner's rule, 2026-09-24.

- **What it says**: the `CHANGELOG.md` sections of every version the deploy makes live, verbatim
  and newest first, under a line naming the version and linking <https://lbptracker.sgdc3.it>.
  The changelog is already written for that reader (no `--`, no em dash, no internals), so the
  post is copied, never rewritten; a deploy with no new section says it was a redeploy of the
  same version. ⚠️ Unwrap the file's hard-wrapped lines first: Discord keeps every newline, so a
  bullet copied as it is breaks mid-sentence at column 100. Each version is a `### 0.2.37 ·
  2026-09-23` heading, a `###` subheading inside a version becomes a bold line, and every message
  goes with `allowed_mentions: {parse: []}` and `flags: 4` (no link previews).
- The whole history up to **0.2.37** went out on 2026-09-24 as 18 messages, oldest first, so the
  channel starts complete; the first deploy after that announces from 0.2.38 on.
- **Which versions**: those newer than the one the site was running *before* the deploy. ⚠️ Read
  it off the live site, not out of memory: the entry bundle inlines the web package's manifest
  (see `src/version.ts`), so `curl -s https://lbptracker.sgdc3.it/` gives the `assets/index-*.js`
  name and that file contains `name:\`@lbptracker/web\`,version:\`0.2.37\`` (measured 2026-09-24).
  Read it before `npm run deploy`, since afterwards it is the new one.
- **How**: one `POST` of `{"content": …}` as JSON to the webhook URL. Discord caps `content` at
  2000 characters; a longer post is split at a section boundary into several, oldest version
  first so the channel reads in order.
- ❗ **The webhook URL is a secret and never enters the repository**: not in a file, a script, a
  commit message, steering or the changelog. Anyone holding it can post as the tool. It lives in
  `.discord-webhook` at the repository root (one line, the URL, gitignored), or in the
  `LBPTRACKER_DISCORD_WEBHOOK` environment variable, which wins. If neither is there, ask the
  owner for it; do not skip the post.
- The deploy itself still waits for the owner's go-ahead, and the post rides on that same
  go-ahead: it is part of the deploy, not a second publication.

## Vue, and where it is not allowed

The pages are Vue 3, and the first thing to know is the line it does not cross:

| | |
|---|---|
| ✔ Vue | panels, forms, lists, pickers — anything whose state is what the reader typed |
| ✘ not Vue | the audio graph, the note scheduler, the worklet and worker protocols, the keyboard, the canvas |

❗ **The real-time layer is called by components, never owned by them.** A note-on writes to a
`MessagePort`, not to a reactive object; the keyboard toggles a class on 88 elements at key-down
rate; the meters run at `requestAnimationFrame`. ⚠️ **The editor's two grids are canvases, not a
`v-for`** — a pattern editor scrolling thousands of cells at 60 fps is a canvas or a virtualised
list, and rendering it as reactive components is the predictable way to make an editor slow.
`src/editor/board.ts` and `src/editor/roll.ts` are those canvases, over a song that is a plain
object with a version counter the Vue panels read ([editor.md](editor.md)).

**`src/controls/`**: one spec per view (`bench.ts`, `engine.ts`, `render.ts`, `midi.ts`, `als.ts`) and `kit.ts`
turning each into a typed store, five components. The win is that **a control is declared once**.
Every fader used to be written twice — in the HTML with its `min`/`max`/`value`, and in the module
as a row carrying its formatter, joined by a string id, with `${id}Label` naming a third element —
and every way of getting it wrong was silent: a mistyped id read the neighbouring control; a
formatter dividing by 100 beside a reader dividing by 10 showed one number while playing another;
`setSlider('echoFb', seq.echoFeedback * 100)` had to be the exact inverse of `num('echoFb') / 100`
350 lines away. Now `Controls<FaderId, CheckId, ChoiceId>` carries the unions from the spec so a
wrong id will not compile; ❗ **`per` is one number, not two functions** (`value = raw / per`,
`raw = value * per`), so the inverse cannot disagree; `format` is handed the *engine's* number; the
watcher that rebuilds the output stage is generated from the `effects` flags. ⚠️ A store belongs to
one page — ids repeat with different ranges — so components take it through `provide`/`inject`.
The render view was converted least, on purpose: its options live in `.switch` cards beside prose,
so only the checks moved into a spec.

**`src/widgets/`**: what more than one page draws — `SeqPicker.vue`, `ArchivePanel.vue`,
`OpenLevel.vue` — each behind an imperative façade (`seqPicker`, `wireArchiveOpen`, `mountOpen`)
because the pages drive them from event handlers and none has a Vue root for props to flow down
from. Converting them found four bugs: the picker's detail column carried **a filename out of the
opened backup** through `innerHTML` with no escaper, and the archive button exists to download
other people's zips; the drop zone was written out three times and had drifted; only one page
cleared its file input, without which choosing the *same* file again fires no `change` at all;
and `defineExpose` unwraps refs, so `ui.busy.value = true` throws only when the zone is first used.

- ⚠️ **`open-level.ts` must not import Vue, and nothing says so but a crash.** `render-worker.ts`
  imports `openedTitle` from it; when the mounting lived in the same file the worker pulled in Vue
  and died with `ReferenceError: document is not defined`. The build is happy either way. The
  mounting half is `widgets/open-panel.ts`, and the rule is general: **a module a worker imports
  may not reach the DOM.**
- ⚠️ **`Symbol.for`, not `Symbol`, for the injection key.** Vite appends `?t=…` to a changed
  module's URL in dev, so a page can hold both `kit.ts` and `kit.ts?t=…` — two module instances,
  two distinct `Symbol()`s — and `inject` returns `undefined` in half the tree while the panel
  still renders correctly.

## Opening a backup, not a level

A creator's backup is a **pile**: the game writes each resource under its own SHA-1, so "open your
level" otherwise means "find the right extensionless file among forty and guess". The app's drop
zone takes a folder, a zip of one, a single file, one of this tracker's own `.json` song files,
**a root level hash out of the public archive, or a level off Bonsai** found by searching it or
by its number, and every route ends in the same `onOpen`
with the same `{ name, bytes }[]`, read by `readOpened` in `src/open-level.ts`; a level holding
several sequencers puts them in the picker, and picking one makes it the song.
The formats are in [cwlib's level-files.md](../../cwlib-ts/steering/level-files.md); this is the behaviour around them.

- `../cwlib-ts/src/sequencer/backup.ts` reads over `{ name, bytes }[]` and knows nothing about files,
  directories or archives, because the user's data is read client-side and never uploaded.
  `zip.ts` reads stored and deflated entries through an `InflateRaw` the platform supplies. ⚠️
  **`readEntries` returns a PAGE**, at most a hundred entries, and has to be called again until it
  returns none — a reader that calls it once opens the first hundred files and ignores the rest,
  which looks like a backup missing levels. ⚠️ **The local header's name and extra fields are its
  own length**, not the central directory's; `test/backup.test.ts` builds an archive with
  mismatched extra fields on purpose.
- ❗ **A level that will not open is reported, never swallowed.** One of forty failing is a bug in
  this parser and should look like one, not like a level that quietly is not in the list.
- ⚠️ **"56 levels" was a lie the moment plans opened.** `openedTitle` in `src/open-level.ts`
  composes the one line — "FJ's Music Gallery (30) by FJMusic — 1 level, 55 plans, 56
  sequencers" — and the level count appears only when there is something to tell it apart from.
- ⚠️ A resource is named after its SHA-1, so the picker shows the first eight hex digits and keys
  on `file#uid`, because a uid is unique inside a level and not across a backup: a picker keyed on
  the uid shows one row where there are two and plays the wrong song.
- ⚠️ **The drop zone takes drops and nothing else.** A click anywhere on it opening the picker was
  a bug: `input.click()` dispatches a click that bubbles back to the zone, so "open a folder"
  opened BOTH pickers. Two buttons, one job each.
- ❗ **The archive route needs no server — not even the dev one** — which is why it is a hash and
  not a search. For one commit the dev server proxied a level search to zaprit.fish (which sends no
  CORS headers), scraping its HTML; it worked and was removed the same day, deliberately: it only
  worked on a dev machine, so the tracker's most useful "I have no backup" path would have broken
  the moment anyone hosted it. **A file server should not also be a proxy**, and a feature that
  needs a Node process beside the page is the wrong shape for the one route that exists because
  the listener has nothing set up. The dev server makes no outbound requests at all: a level from
  the archive is fetched by the page straight from archive.org, which answers any origin.
- ❗ **Bonsai's route has a search, and it is the same rule, not an exception to it.** Bonsai
  answers any origin, so the page asks it for the search, the level and every resource itself,
  and nothing passes through a server of ours. The rule was never "no search", it was "no proxy";
  the header that zaprit.fish lacks is the whole difference. The measurements are in *Bonsai* in
  [level-sources.md](level-sources.md). The two panels share the dependency walk
  (`src/resource-walk.ts`) and nothing else, since what each store says on failure is its own.

## The live player — settings are applied, not re-planned

❗ **The player is `packages/lbp-tracker-web/src/player.ts`, one class with one instance in
`src/daw/session.ts`** since 2026-09-06 — the live page's scheduler, kept whole when the pages
became one app; the invariants below are its, and the shell owns only the transport around it. ⚠️ While the scheduler lived in `live.ts` its gain read `channelVolume` without the
board's height, so rows were re-banded by the modulo fallback on the way back in — the plan's gain
having been divided out under the bands — and every multi-channel song was mixed on the wrong
channels; `Player.mixerNow` carries `boardRows`.

⚠️ **Read before adding a control to the mixer view.** The session builds its
plan once — the render's whole voice pass, `renderSequencer` with `planOnly` — and a setting that
forces that again runs it on the thread that also feeds the audio (`Ascetic`: 1,150 tracks). A
listener heard the player stutter every time the tempo, the swing, `NumChannels` or a fader moved,
and a 450 ms debounce made it happen less often rather than fixing it.

**None of those four changes a voice.** They change where it starts, how long it lasts and how loud
it is, so the plan holds **musical positions** (`startStep`, `endStep`) and a gain with the channel
factor divided out, and `pump()` derives frames and gain as it posts each note. ✅
`packages/lbp-tracker-lib/dev/live-settings.ts` proves it: the plan at a song's own settings, new
ones applied the way the page does, against a render of a sequencer that had them all along —
**bit-identical**.

- ❗ **The in-note automation has to be rebuilt.** `automation` and `morph.points` carry frames from
  the voice's start, bent by tempo AND swing (`swungFrame(step + offset) − swungFrame(step)`), so
  the plan carries each control point's step offset (`pointSteps`) and `onClock` puts the frames
  back. Skipping this is **15.9 dB wrong**: the notes land in the right places and glide at the old
  tempo inside themselves.
- ⚠️ Tempo is only free of the voice because no shipped instrument sets `fitBpm` — 0 of 68,
  measured by `test/instrument.test.ts`. One that did would need the rebuild after all.
- The pool is live for the same reason: the plan carries no cuts and `LiveVoicePool` applies the
  size per note. Its score is not immune — `channelVolume * velocityGain` means a fader changes
  which voice is stolen — so the plan carries `baseScore` as it carries `baseGain`, and
  `baseWalks`, the score at each later walk, the same way (*The voice pool* in
  [synth-engine.md](synth-engine.md)).
- ❗ **The pass belongs to the section being gone round, and the section can change under the
  clock.** A loop is not a seek: the clock runs on unwrapped and voices are posted with `pass ×
  length` added. Switch the song's loop off during the second pass, clear or move a chip's region,
  or stop the transport (which stores the *folded* position), and `passFrame` and `rawPosition`
  disagree by that offset — every voice left in the plan lands at delay 0 in one burst, or nothing
  posts until the clock has run the offset out. `Player.foldPass` folds the position, brings the
  pass and the frontier to zero and replays the pool, and every path that can change
  `activeRegion()` calls it first (the `loop` setter, `setRegion`, `clearRegion`, `stop`).
  Shipped as "switching loop off explodes every sound at once", 2026-09-09.
- ❗ **`nextIndex` must never move backwards — a bug that shipped.** Re-pointing the playhead let it
  land before the end of the look-ahead window `pump` had already handed to the worklet, and every
  voice in it was posted again, thirty times a second while a slider was held ("the notes are
  played several times and the volume becomes very loud"). `nextIndex = Math.max(nextIndex, want)`;
  `rebuildPoolTo(nextIndex)` replays the pool **by index rather than by frame**; `pump` skips a
  plan entry already in `handed`, cleared only by `seek`. `handed` stores the note's **step**, not
  its frame, because the tempo can move after a voice was handed over. `live-settings.ts`
  reproduces a slider drag: 0 of 163 notes handed over twice with the fix, 159 of 163 without.

❗ **The engine's clock runs under the transport** (the default since 2026-10-12, *3 / 3b* in
[answered-questions.md](answered-questions.md)). The plan's voices come from the render with an
engine record and without its grid -- the render's is the whole song's chunk table, hundreds of
kilobytes a note -- and `pump` puts each one on a run of the clock as it posts it:

- **A run is the clock restarted at a step, at a transport frame** (`Player.startRun`): at `play`,
  at a tempo or swing change, and where the passes fold; a fader or an edit leaves it running so
  the notes after it keep the grid the ones before had. Every later time round a looped section
  runs on one more run, started at the section's first step at the pass's own frame. The clock is
  a pure function of tempo, swing and start, so a run made longer when the song grows has the
  shorter one's chunks to the frame.
- **`placeOnClock`** (`engine-place.ts`) derives the onset, the gate, the walks' frames and the
  window of chunks and splits the voice lives in from its musical positions, by the render's own
  arithmetic; `render.test.ts` holds a windowed placement bit for bit to the render's voice. A
  theft lands on the walk of the thief's step.
- **The plan is in the pool's order** (`planOrder`: the pool's start, its rank, the note), which is
  `allocateVoices`'s: on the engine's clock a step's notes take records at its walk, the last clip
  first. The look-ahead closes on a note's walk, not its onset, so a sub-step note never holds back
  one of a later rank.
- ❗ **Every voice names the context frame it starts at** (`play.at`, and `cutAt.at`/`began` for a
  theft), and the worklet counts the delay from its own `currentFrame`. Until 2026-10-12 a delay was
  counted from whichever block the message reached the worklet in, and the look-ahead bursts landed
  a whole render quantum apart: measured in the browser on `Ascetic`, the live output against an
  export of the same song was -5 dB median with the lag jumping 0, 128, 256 and 384 frames. Named,
  -141 dB over the first second and -117 dB median after it, -89 dB at worst of the loudest
  window: the double ladder (`EngineRecord.ladder64`), which the live plan asks for
  (`exactLadder: false`) because the audio thread cannot spare the float32 one.

`live-sim.ts` and `live-settings.ts` run on it: the scheduled and live-pool renders are bit for bit
the direct one at a pool of 8 (1,200 to 2,450 notes stolen on three songs), and tempo, swing,
channels and faders applied live are bit for bit a render that had them all along.

✔ **The live path steals exactly what the renderer steals.** `packages/lbp-tracker-lib/dev/live-sim.ts`
builds the plan as the page does and renders it three ways — all voices at once, in 128-frame
blocks, and handed over in look-ahead bursts with the pool applied live — and all three are
**bit-identical** to the direct render, with 1,318 of `C4K3 S0NG`'s 13,091 notes stolen either way.
⚠️ When that file and the renderer disagree, suspect the file first: its −57 dB was the simulator
rendering 4,800 frames per tick where the worklet renders 128 (*34* in answered-questions.md), and
before that it asked the pool once per stack *layer* where `live.ts` had been fixed to ask once per
note (−8.9 dB).

**What the audio thread costs.** `C4K3 S0NG` — 244 tracks, 13,091 notes, the 32-voice pool
saturated — runs at **23-60%** of one core with no dropouts; it was 11-26% before one record per
note (*17b*) put 2,108 more notes into play. ❗ The cost is the per-frame DSP and nothing else: driving the
mixer at 128 frames and at 4,096 costs the same to the millisecond, hoisting `this.*` into locals
made it 3% *slower*, and a sampling profiler's per-function attribution inside the hot loop was a
hint at best — stubbing a thing out and re-timing is what answered every question. ⚠️ Uncapping the
pool nearly doubles the load, and the browser used to restore that checkbox across a reload while
everything else reset; every control on the live page carries `autocomplete="off"` now. The meter
shows **notes** (a voice is one record with its layers inside since 2026-09-08; a one-shot outlives
its gate, a release rings on) and turns red at ⅞ of the pool — reading high by
design, because the pool gives a record back at the gate while the voice keeps its tag until it has
finished ringing. ⚠️ The 11-26% and 23-60% above were read off the meter as it was before
2026-10-04, below; at those loads its error was a few points, at light ones it was most of the
figure. And "no dropouts" was read off a detector that could not see one (below): it is
unmeasured.

**The "audio %" figure, and the clock it has to use.** It is `LoadMeter`
(`packages/lbp-tracker-lib/src/audio/load-meter.ts`), driven by the worklet; measured in Chrome on
2026-10-04:

- ⚠️ **The audio thread's only clock is `Date.now()`, one tick a millisecond.** In an
  AudioWorkletGlobalScope `performance` is undefined and `Event.timeStamp` is always 0; the page is
  not cross-origin isolated, so there is no `SharedArrayBuffer`; the context has neither
  `renderCapacity` nor `playoutStats`.
- ⚠️ **Chrome renders in bursts on a 10 ms beat**: three or four 128-frame quanta back to back per
  device callback (`baseLatency` 0.01), in a cycle of 4, 4, 4, 3, and 167 of 198 callback periods
  exactly 10 ms. So a burst starts at nearly the same point of the millisecond every time, and that
  point drifts over tens of seconds.
- ❌ **The meter until then summed `Date.now()` around each `process()`**, and read the phase rather
  than the work: a constant load measured in one context, 2 s at a time, read **0.3–1.15% for 30 s
  and then 2–3.4%**; the same load in eight fresh contexts, 2.3–3.95%. It also showed a smoothed
  average while its comment said "worst block".
- ✔ **Now about one callback in ten waits a random fraction of a millisecond before its start is
  read**, which makes that callback's reading an unbiased sample of its length; the samples' mean
  against the plain mean of the same bursts is the clock's bias per burst, taken out of the plain
  sum over five seconds (~0.5% of a core in waits, switched off above 60%, where the plain sum is
  good enough and a millisecond's wait would eat headroom). Chosen at random: a fixed "every
  16th" landed on the 3-quantum callback of the cycle every time and read 80% of the load.
  `test/load-meter.test.ts` simulates that geometry; across six phases and five seeds the bias is
  under 0.1 point and the worst error under 1. On `Rotary` the figure now follows the song,
  4.6–5.8% for 16 s rising to 10.4% at 30 s, where the old one sat near 8.5% throughout; the same
  30 s rendered hot in Node, every block timed to the microsecond, rise from 1.9% to 6.6% — the
  live thread runs at a lower clock than a busy one, so it costs more.
- The spans are whole callbacks, first quantum to last, so the rest of the graph between our quanta
  counts (0.2–0.6 points); voice creation in the message handler is 0.25% of realtime and does not.
- ❌ **Past 100% that meter read lower, not higher.** Tried by making the thread overload: a
  temporary message that spins a set number of `Date.now()` calls inside our own `process()`
  (2026-10-04, `Ascetic`, 0.5 to 3 ms a quantum). It counted a burst only when a gap closed it, and
  an overloaded thread never has a gap: **28% and then 8%** while 282 and then 688 ms of every 5 s
  were lost, in the plain colour, then 78% once the spin was gone. Its peak (the longest callback
  over the period) said 100% at a 57% average with nothing lost, two callbacks less than two ticks
  apart being one burst to this clock; there is no peak any more. Now each report takes the open
  burst's time so far, and the plain sum is the figure with the samples only correcting it: the
  same ramp reads 8, 35, 51, 59, 67, 76, 85, 90, 95% and falls back as the load goes.
  `test/load-meter.test.ts` pins both. ⚠️ A spin in a *separate* node does not test this: it
  splits our bursts at the gaps it makes and reads low for a reason the app never has.
- ❌ **`currentFrame` never jumps in Chrome, so the dropout count was always zero.** It counted a
  skip of more than one quantum between two `process()` calls; with 688 ms lost it counted none.
  Chrome renders every quantum, late, plays silence for what the device could not get, and from
  then on the context's audio comes out that much later. ✔ **`getOutputTimestamp()` sees exactly
  that**: `performanceTime − contextTime` held within about 1 ms per 5 s (the two clocks drift
  ~200 ppm) at every load up to 90%, and rose 19 ms where a sudden jump caught the CPU at a low
  clock (below) and 221–249 ms in the 4–5 s at 95–97%. So the page counts sound lost off it, one reading
  per load report (`DropoutCounter`, `packages/lbp-tracker-lib/src/audio/dropouts.ts`, run from
  `player.ts`). ❌ The worklet cannot: from inside, the lag of `currentFrame` behind `Date.now()`
  rose with the load when read at the end of each quantum, and with every callback late but still
  in time when read at each burst's start (39 ms "lost" after the same kind of jump, where the
  output lost 1) — it cannot see the device's buffer.
- ✔ **Checked against Windows' own count of the audio thread's CPU time** (per-thread
  `TotalProcessorTime` of the renderer, the thread told apart by playing and stopping): `Rotary`
  11.6% where the meter said 8.0%, `Ascetic`'s opening 3.9% where it said 1.8%, 3.1% with nothing
  playing. The difference, 2–3.6 points, is the browser's own audio work on the same thread —
  the rest of the graph after our last quantum, the hand-off to the device, messages — which
  nothing inside the worklet can time; the tooltip says so rather than adding a guessed constant.
- ❗ **What the footer shows is one number, like a DAW's CPU meter**: `17 notes · CPU 6%`, the
  average; yellow from 50%, red for 10 s after sound is lost, and the dropout count in the text
  only when there is one; the sound lost, in milliseconds, is in the tooltip (`showLoad` in
  `daw.ts`). ⚠️ It read `audio 6%, peak <30% · no dropouts` for a day — all true, and unreadable
  to the owner; a peak shown only from three ticks up had been worse still, coming and going with
  the odd slow callback. The 50% is a decision: on the machine measured, a steady load lost
  nothing up to a reading of 90%, but a jump from 8% straight to a spin that reads 76% when
  reached gradually lost 19 ms in its first moments, the CPU still at a low clock.

## Playback model

The sequencer is a fixed grid, so the natural clock is **steps, not seconds**, converted once at the
edge: `720000 / tempo` frames per step at 48 kHz — four steps to the beat, measured — with alternate
steps stretched and squeezed by `swing/2` and positions in thirds of a step (`swing.ts`,
[synth-engine.md](synth-engine.md)). A note is **not** `(pitch, start, length, velocity)`: it is a
chain of per-step records carrying their own pitch, volume and modulation, terminated by an `end`
flag, so glides and per-step automation are native to the format and modelled from the start. A
note occupies one of **32** pool records however many unison layers it plays, and the pool steals
the quietest (`polyphony.ts`).

## Build order, and what exists

1. ~~**Port `fsb.py`**~~ — done, byte-identical to the Python oracle; it serves the game's SFX, not
   the sequencer.
2. ~~**The voice engine**~~ — done: worklet, the engine's own interpolator and mipmaps, pitch
   formula, key splits, envelopes, ladder, LFOs, drive, pool.
3. ~~**`RInstrument` reading**~~ — done: all 68 of the game's instruments parse exactly and the bench
   plays them from the real `.smp` samples.
4. ~~**Level import**~~ — done, both halves: `../cwlib-ts/src/sequencer/project.ts` turns a level into
   sequencers, tracks and a scheduled event list; the whole corpus imports (19 files, 338
   sequencers, 129,696 tracks, 2,027,633 notes, zero records falling outside a note; tempos 30–240,
   cells 0–334, rows 0–24), and `dev/verify-levels.ts` matches cwlib's dump on 149 sequencers and
   62,158 placements byte for byte.
5. ~~**Echo, reverb, compressor**~~ — done and measured (`audio/effects.ts`, `audio/compressor.ts`).
6. **The editor.** Started 2026-09-06 — `index.html`, the front page: the board and the piano roll as canvases,
   an editable song model whose boundary is the game's own record encoder, undo, a project file,
   and playback of every edit through the shared player. [editor.md](editor.md) has it, including
   what is not there yet.
7. **Round-trip export** back into a game-loadable resource — the feature that makes the project
   matter to the LBP community. **Built**: `cwlib`'s `writer.ts` and `write-plan.ts` write a
   `PLNb` plan holding a Music Sequencer, self-contained because everything it names is a GUID.
   [cwlib's export-to-game.md](../../cwlib-ts/steering/export-to-game.md) has the measured Thing shape, the deviations, and what
   proves it; what is *not* proved is the only thing left — that the game opens it.

| where | what |
|---|---|
| `../cwlib-ts/src/` | `stream.ts` (big-endian reader, varints, `Revision` gates), `serializer.ts`, `resource.ts` (container, dependency table), `thing.ts` + `parts.ts` (the walk, 53 readers), `level.ts` (worlds, plans, chunks, `boardCell`), `project.ts` + `notes.ts` (the sequencer as data), `rinstrument.ts` (the sampler patch), `savearchive.ts`, `psf.ts`, `zip.ts`, `backup.ts`, `platform/` |
| `packages/lbp-tracker-lib/src/` | `render.ts` (the pipeline), `audio/mixer.ts` (voices, resampling, panning, looping, per-chunk re-derivation), `audio/interpolate.ts` + `mipmap.ts` (default `linear`; `sinc8` kept for A/B), `audio/moog.ts`, `audio/lfo.ts`, `audio/effects.ts` (echo, reverb, fold constants), `audio/compressor.ts`, `audio/master-stage.ts` (the master bus: the game's, with the AGC of `audio/agc.ts` or without, the fold's gain alone, or ours in `audio/master.ts`), `audio/mixer-worklet.ts`, `instrument.ts` + `voice.ts`, `envelope.ts`, `params.ts`, `polyphony.ts`, `scale.ts`, `swing.ts`, `fsb.ts` + `ima.ts` + `wav.ts`, `midi.ts` + `smf.ts`, `als.ts` + `als-xml.ts` + `als-sampler.ts` (the Ableton Live set and its Samplers), `song.ts` (the editable song and its boundary with the records) |
| `packages/lbp-tracker-web/` | `index.html` the app; `src/daw.ts` the shell (tabs, transport, files); `src/daw/session.ts` the one song, player and plan; `src/daw/arrange.ts`, `mixer.ts`, `render-view.ts`, `convert-view.ts` (with `als-export.ts` and `plan-export.ts`), `keyboard-view.ts` the views; `src/render-worker.ts`; `src/player.ts` the scheduler; `src/editor/` the board, the roll, the state and the panels; `src/controls/`, `src/widgets/`, `src/assets.ts`, `src/lbparchive.ts`, `src/footer.ts` |

## Testing against the corpus

The corpus tests read `LBP_LEVELS`, `LBP_RINST`, `LBP_SMP` and `LBP_FSB` and **skip** when they
are absent, so the suite passes on a machine without the game. Never commit a fixture derived from
game assets or from someone's level ([cwlib's level-files.md](../../cwlib-ts/steering/level-files.md) has the corpora).
**Golden-file tests from day one**: render short fixtures and diff the PCM, because fidelity
regressions are inaudible until they are not, and a diff catches them instantly. ⚠️ A test that
normalises cannot see a gain error, and several here normalise.

## Decided early

- **Our own project format is JSON, not an LBP resource.** Import/export to the game's format is a
  boundary, not the internal model.
- **No server.** Everything client-side: it keeps the asset-licensing story clean and makes the tool
  hostable as static files.
