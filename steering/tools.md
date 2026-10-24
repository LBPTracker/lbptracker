# Tools — reference implementations, RE helpers and harnesses

Read before reaching for anything in `tools/` or `packages/*/dev/`. Every script carries its own
command lines in its docstring; this file says what each is *for*, the trap it exists because of,
and the environment variables that steer it. Nothing here is a fact about the game — those live in
the descriptive files — but several of the traps below are why a fact took a session longer than
it should have.

`tools/` holds **twenty Python scripts and nine Java ones** (counted 2026-10-11), deliberately dependency-light, and
one PowerShell script that drives Ableton Live (below). Three
of the Python ones are the ground truth the TypeScript reproduces (`fsb.py`, `lbpres.py`,
`wavehammer.py`); the rest are instruments for reading the binaries.

- Python: `C:\Users\sgdc3\AppData\Local\Programs\Python\Python314\python.exe` (capstone 5.0.7
  installed).
- Java: ⚠️ `javac` here is JDK 25 and the first `java` on PATH is 1.8. Run the Java tools with the
  JDK's own binary — `"C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin\java"` — or
  they fail with `UnsupportedClassVersionError`. Each `.java` header has its build and run lines;
  they link against the toolkit jar
  (`C:\Users\sgdc3\Desktop\LBP\toolkit\tools\sequencerdump\target\sequencerdump-0.1.jar`, `$JAR`
  below) and compile into `out/`.

## Reference implementations

| tool | what it is | checked how |
|---|---|---|
| `fsb.py` | FSB4 bank reader, IMA ADPCM decoder, WAV writer | decodes the game's `piano_C3` to a clean tone at the expected pitch (game-assets.md); `packages/lbp-tracker-lib/src/fsb.ts` + `ima.ts` are byte-identical to it |
| `lbpres.py` | the `LVLb`/`PLNb` container: revision, branch, zlib chunk table | 18 real levels, every chunk inflating to its declared size and the last one ending exactly on `depsOffset` ([cwlib's level-files.md](../../cwlib-ts/steering/level-files.md)) |
| `wavehammer.py` | the WaveHammer's gain curve — a literal transcription of the PRX plus the two-line closed form its knee reduces to | `wavehammer.py check` agrees the two over five configurations × 3999 entries to 2.1e-14 dB; `runhammer.py sweep` agrees it with the module *running* to 1e-4 dB |
| `panmeasure.py` | the stereo width of a recording: the least-squares leak of one channel into the other, with the residual that says whether one number describes it at all | how the pan width was settled (*22* in answered-questions.md). Use it on any new capture of the game |

**`runhammer.py` loads the actual `fmodsmswavehammer.prx` into this process and runs it** — both
segments at their own vaddrs in one RWX allocation so rip-relative references need no fixing, the
five non-PLT relocations and ten GOT slots written by hand, `powf`/`_FLog` shimmed to the CRT, and a
System V ← Windows thunk saving the registers the two ABIs disagree about (`rsi`, `rdi`,
`xmm6`–`xmm15`). `runhammer.py state` dumps the state block the module computes for itself.

❗ **Reach for it when a field looks uninitialised.** Three readings of that DSP were written down
wrong and two committed; the last died the moment the module printed `[state+0xc0] = 64`. A superset
disassembly had proved there was no store to `[reg+0xc0]` — correctly — and the field was written
all along as `[rbx+0x3c]` through an interior pointer. **An absolute-offset search is only sound if
every access uses the same base.** The harness is reusable on `fmodsmsreverb.prx` and
`fmodextinput.prx`, which are the same shape. See *37* in answered-questions.md.

**`prxrun.py` is that harness made general** (2026-10-11): any of the PRXs `prxdis.MODULES` names,
relocated (`RELATIVE`, `64`, `GLOB_DAT`, `JUMP_SLOT`; TLS to 0) against **the game's own
`sce_module/libc.prx`** loaded beside them — so `exp2f`, `sinf`, `rand` are the console's, not the
CRT's — and the eboot itself (`load_eboot`, for the mip builder `v0x3fc2b0` and anything else a
module calls back into). `call(target, *ints, floats=(), stack=())` is the Windows → SysV thunk,
checked with capstone; `standard(rand_constant=…)` wires the stack guard and pins `rand()` to a
constant, so a run is deterministic and our side can be fed the same draw. `prxrun.py selftest`.

**The differential test against the synthesiser** runs on it, in three parts:

| part | what it does |
|---|---|
| `packages/lbp-tracker-lib/dev/prx-scene.ts <dir> synth <inst> [variant]` / `level <uid> [s]` | writes the scene as the eboot lays it out (`scene.json`) and our render of it, matched (`ours.f32`). `PARAMS="i=x,y;…"` overrides `Params` on both sides, `TRACKS=` keeps some tracks, `CLOCK=1` renders on the engine's clock |
| `tools/prxsynth.py <scene.json> <out.f32> …` or `<list.txt>` | runs `fmodextinput.prx` on it: the module's four lanes. `VOICES=a,b` and `POSV=a,b` print the live records and their sample positions over a frame range — comparing `+0x40 + 8i`, all five layers, chunk by chunk with our layers' positions is how a phase drift is told from a level error, and an error that grows 6 dB per doubling of time is a drift. The list file must end in `.txt` |
| `packages/lbp-tracker-lib/dev/prx-compare.ts <root>` | every scene under a root: the error overall, and the worst window against its own power and against the loudest window |

⚠️ **Three traps, each paid for** (*62* in answered-questions.md): read the worst window against
the **loudest** one, never its own — a −90 dB tail a block apart reports 0 dB; compare a song on
the engine's clock (`CLOCK=1`), or every onset off a block boundary is a difference by design; and
treat every field the scene invents as a claim about the engine — a clip length of `0x7fffffff`
held rows the game frees and silenced the module mid-song.

**The whole chain in series** (2026-10-11) extends it past the synthesiser — the result is *The
whole chain, run in series against the modules* in [lbp-audio-engine.md](lbp-audio-engine.md):

| part | what it does |
|---|---|
| `prx-scene.ts` with `CHAIN=1` | also renders `ours-reverb.f32` (the reverb's return in, `master: 'none'`, the fold's gain out) and `ours-game.f32` (the whole render, `master: 'game'`), and writes the scene's `reverb` setting |
| `tools/prxchain.py <scene.json> <dir>` or `<list.txt>` | `prxsynth.py`'s run with every block fed on through `fmodsmsreverb.prx` and `fmodsmswavehammer.prx` in the same image: `prx.f32`, `prx-reverb.f32`, `prx-hammer.f32`, four lanes each. Both DSPs are made, and the preset applied right before the song, by the eboot's own code. `WARM=n` runs the chain n frames on silence first (0, the default, is a session's first song); `REAPPLY=n` applies the preset again every n frames |
| `tools/prxrevswitch.py <dir> [A:B …]` or `<dir> reapply` | `fmodsmsreverb.prx` alone, made by the eboot's create, set to A before its first block, switched to B after 2,048 frames — or re-applying its own preset every 768 frames on noise — on a signal `reverb.test.ts` regenerates; writes the vectors and prints the per-window digest that test pins `Reverb.reconfigure` to |
| `packages/lbp-tracker-lib/dev/prx-chain.ts <root>` | each boundary **chained** (synth, + reverb, + WaveHammer against `ours-game.f32` with the fold taken back out, + fold) and each of our stages **local**, fed the module's own input (`Reverb`, `WaveHammer`, `FOLD_CENTRE`), so a mismatch names its stage; the send's level, the WaveHammer's deepest gain and its worst gain error, and lanes 2-3 checked zero. `WINDOW=a,b` |
| `tools/prxhammer.py` | the WaveHammer alone, made by `prxchain.py`'s `make_hammer` and run against the console's libc, on `compressor.test.ts`'s `signal()`: the gains at its `VECTORS` frames, where `[state+0xf0]` comes to rest after the signal and from reset, the first frame of a fresh module fed 1.0, and the state it computed. Every module number that test pins comes from here, or for `VECTORS` (taken with `runhammer.py`) is reproduced here to 5e-8. Unlike `runhammer.py`, its `powf` and `log10f` are the game's |

- ⚠️ **The WaveHammer `printf`s whenever it rebuilds its table** ("Writing back storage …",
  "DONE", `0xdd8`/`0xdf8`), and the game's `printf` and `puts` reach libkernel, which `prxrun`
  does not load: the module dies on an `int3` on its first block, which reads like a stack-guard
  failure. `prxchain.py` points both at `ret0`, as `runhammer.py` always had.
- ⚠️ **`WARM` is not neutral for the reverb.** The silence runs on the create's preset 2, and a
  preset applied after the module has run keeps preset 2's lengths (*SMS Reverb* in
  lbp-audio-engine.md), while `prx-chain.ts` scores a clean `Reverb` — so with `WARM` only a
  song on preset 2 is a clean comparison. Its counterpart is `new Reverb(rate, reverbPreset(5))`
  run on the same silence, then `reconfigure`, which `prx-chain.ts` does not do.
- A list file's paths are read by Windows Python: write them as `C:\…`, not `/c/…`, which it
  opens as `C:\c\…`.

## Getting the game's data out

| tool | what it does |
|---|---|
| `GuidLookup.java` | resolve a GUID (or a path substring) against the game's FileDB, `output/orbisguids.map` — GUID → path + SHA-1. This is how you find where any resource actually lives |
| `ExtractGuid.java` | GUID → FileDB → SHA-1 → FARC → bytes, plus a `manifest.json` the browser uses to resolve GUIDs without the 11 MB FileDB |
| `IconDump.java` | every `*instrument_*.plan`'s `InventoryItemDetails.icon`, decoded through `RTexture` into a 128 px PNG named after the `.rinst` it places |
| `trace-icons.py` | those PNGs into the SVG paths of `src/editor/icons.ts`: drop the frame, close the stripes down the y axis, marching squares, Douglas-Peucker. ⚠️ Both traps are in its header, and the second one bites anyone simplifying a closed loop. `EPS` is the one knob |
| `ReverbOrder.java` | a compiled `.ff` script through the LAMS table: every `LoadConstInstructionInt` operand in a function, translated. ⚠️ **The int is inline in the instruction word**, which is why searching a script's bytes for a LAMS id finds nothing. This is how the reverb list's order was read |
| `InstrumentNames.java` | every `*instrument_*.plan` → its inventory `titleKey` → the LAMS table → **the name the game shows for each sound**, joined to the `.rinst` GUID through the plan's dependencies. Feeds `src/editor/instrument-labels.ts` |
| `ModCheck.java` | **the check on `../cwlib-ts/src/archives/mod.ts`**: `read` opens a `.mod` with cwlib's own `Mod` and prints config and rows, with whether the archive holds each under its hash; `write` has `Mod.save` make one for our reader. cwlib is the format's only definition, so this is the only ground truth there is — *The toolkit's `.mod`* in cwlib's level-files.md |
| `InstrumentColours.java` | the same 68 plans read as **what a chip the game has just placed holds**: `PInstrument.Colour` (the family's tint), the plan GUID, the chip icon, and the mixer defaults. Feeds `../cwlib-ts/src/sequencer/chips.ts`, all 68 rows of it. ⚠️ It uses cwlib rather than our own reader on purpose — these plans are revision `0x397` and `../cwlib-ts` stops at `0x3b7` |

The sequencer's real samples and its `.rinst` instrument definitions come out of the game with:

```
java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/rinst .rinst
java -cp "$JAR;out" ExtractGuid <orbisguids.map> <gamedir> fixtures/smp  audio/music/samples
```

then `npm run serve` and open http://127.0.0.1:8173/ to play them.

⚠️ **Run these on JDK 21 or 25, not the `java` on PATH.** `javac` here is 25 and the JRE on PATH is
1.8, so `ExtractGuid` compiles and then dies with `UnsupportedClassVersionError: class file version
69.0`. Use `"C:/Program Files/Eclipse Adoptium/jdk-25.0.3.9-hotspot/bin/java.exe"`.

**The game's own words come out the same way.** `ExtractGuid ... "languages/english.trans"` pulls
the LAMS table (GUID 31131, 3.5 MB, out of `intro_001.farc`); its layout is `u32 count`, then
`count x (u32 key, u32 offset)`, then one UTF-16BE blob. ⚠️ **The offset is in BYTES and points at
the entry's own U+FEFF**, which is also the separator -- there are no NULs, and reading it as
characters or splitting on NUL gives strings that start mid-word and look almost right. The keys
are hashes: `cwlib.resources.RTranslationTable.makeLamsKeyID(String)` computes them, so the way to
read a name is to *propose* the key and look it up (`translate("REVERB_SETTING_CAVE")` → `Cave`).
That is how the reverb names were found ([lbp-audio-engine.md](lbp-audio-engine.md)). The eboot
holds none of these keys, as strings or as ids; the UI builds them in script.

**A `.ff` script decompresses with `lbpres.py --raw`**, and its string table then shows the class's
fields and method names -- `gamedata/scripts/tweaksequencer.ff` is the Music Sequencer's tweak
menu, `AddReverbs__` and `TranslatedReverbNames` and all. The bytecode's operands need a
disassembler nobody has written; the strings alone still say which script owns a piece of UI.

- ⚠️ `<gamedir>` is the folder holding `base_001.farc` — `D:\PS4Games\CUSA00063`, **not** the
  `-patch` folder, which holds only `patch_001.farc` and makes every row come back `MISSING`.
- ⚠️ **Two GUIDs can share a basename**, and the extractor once let the second overwrite the first
  (`a_kit_1/kick.smp` and `baiyon_drums/kick.smp`): one kit played the other's kick in every render
  for days. A name already claimed by a different GUID in the same run now gets the GUID prefixed
  (`148304-kick.smp`) and the clash is printed. **A manifest with more rows than files is a
  collision, and it is worth asserting** — `fixtures/rinst` had 68 rows and 68 files;
  `fixtures/smp` had 216 rows and 215 files and nobody counted. The cost is in game-assets.md.

## The level corpus

The reader's harnesses — `trace-level`, `walk-levels`, `verify-levels`, `fetch-plan`,
`dump-fields`, `chip-table`, `verify-export`, `archive-sample` — and the two Java oracles beside
them, `PartCensus.java` and `CwlibTrace.java`, are
[cwlib's tools.md](../../cwlib-ts/steering/tools.md). What stays here is the page's own:

| tool | what it does |
|---|---|
| `packages/lbp-tracker-web/dev/check-demos.ts` | **the check on `src/demo-songs.ts`**: fetches each demo's level from archive.org as the page does and requires its uid to be a sequencer in it, printing name, author and chip count. With hashes as arguments it lists every sequencer of those levels instead, which is how a new row's uid is found. ⚠️ Network and other people's levels, so a dev tool and never a test |

## The eboot and the PRXs

`ebconf.py` is **not a command; it is where every eboot tool gets its binary**, and three
environment variables override its defaults: `LBP_EBOOT` (the dump, default
`shadPS4\lbp3-ebins\eboot-v128.bin`), `LBP_BINDINGS` (the script-binding table) and `LBP_DELTA`
(the file↔vaddr delta, `0x4000`). Point these at another version rather than editing a tool. The
address conventions themselves — and the delta trap that costs hours — are in eboot-re.md.

| tool | what it does |
|---|---|
| `lbpdis.py <vaddr> [n]` | capstone disassembly by vaddr, resolving rip-relative targets to strings, tagging binding names and marking call targets that land inside FMOD |
| `callgraph.py <vaddr> [depth]` | BFS the direct-call graph from a seed and report the shortest paths that reach FMOD. ⚠️ It sees direct calls only, so *"does not reach FMOD"* is weak evidence and *"reaches it"* is solid |
| `fmodapi.py` | every game→FMOD call edge, attributed to the FMOD `.cpp` the callee lives in — the map of how much of FMOD the game drives, and by omission what it ignores |
| `ebvtable.py <name> [n]` | **name a C++ class's vtable through RTTI** and dump its slots; `slot <off> <name>` compares one slot across classes; `who <vaddr>` says which vtable slot holds a function |
| `ebxref.py refs\|calls <vaddr>` | **who references an address**: `refs` every rip-relative reference, `calls` every direct call, clustered by caller and marked game-side or FMOD-internal. All in vaddr space |
| `ebdyn.py modules \| <nid>` | the eboot's dynamic imports: the modules a NID's `#L#M` suffix indexes, or one NID resolved to its module, GOT slot and every reference to it |
| `prxnid.py <module> imports\|<n>\|guess\|export`, `prxnid.py hash <name>` | **a PRX's imports and exports, by NID** — `<module>` is `reverb`, `input`, `hammer` or `libc` |
| `prxdis.py <module> <vaddr> [n]`, `prxdis.py <module> map` | disassembly of a PRX by vaddr, resolving rip-relative operands to the float/double there; `map` prints the segment table |

The traps, each of which cost at least a session:

- ⚠️ **Reach for `ebvtable.py` before any structural vtable search.** Question 22 spent a session
  enumerating vtables by shape and produced five wrong candidates plus a near miss convincing
  enough to write up; the binary has 204 mangled `N4FMOD…E` names and 322 vtables that can simply
  be named. The trap that hides them: the slots are **zero on disk** and the pointers live in
  `R_X86_64_RELATIVE` addends, so searching the data finds nothing and it reads as "there is no
  RTTI".
- ⚠️ **Run `ebxref.py calls` before writing down that the game never does something.** Question 37
  spent a session on "no `DSP::setParameter` call on the WaveHammer handle has been found" — true,
  and doing the work of a false sentence, because *not found* had not been separated from *not
  there*. Its docstring has the trap in the tool itself: the displacement is assumed to be the
  instruction's last field.
- ⚠️ **Run `ebdyn.py` before building anything on a NID.** Matching a NID against the string table
  alone once turned libc into "the sequencer plugin's only export"; the module suffix settles it in
  one query.
- ⚠️ **`ebdyn.py` cannot do a PRX; `prxnid.py` can.** A PRX's `PT_DYNAMIC` has no data segment of
  its own — it lives inside `SCE_DYNLIBDATA` — and half the SELF segment entries are 32-byte digests
  rather than data. Both traps are in the docstring with the addresses. `prxnid.py input 0x140` is
  how the unison stack's `rand` was settled rather than assumed, and ✔ it reads shadPS4's
  `aerolib.inl` when that checkout is present — 171,520 lines carrying **94,276** `STUB("nid", name)`
  entries — so every import resolves; Sony's own table agrees with the hash on `rand`.
- ❗ **`libc` is a module in both PRX tools because the game ships its own** at
  `sce_module/libc.prx`. The libc a plugin links against is a file on this disk, not a fact about
  the console: that is how `RAND_MAX` was settled as `2^30 − 1` (`rand` is a 37-byte LCG at vaddr
  `0x17000`). **When a question turns on what a system function does, check `sce_module/` before
  reasoning about the platform.**
- ⚠️ **`prxdis.py`: disassemble from a function start, never from an arbitrary address.** A
  mid-function start desynchronises the stream and prints convincing nonsense. Its file deltas were
  both 0x40 too small until 2026-09-02, so every PRX address in a note older than that is 0x40 too
  high — the readings are fine, the labels are not (eboot-re.md has why).
- ⚠️ **`prxdis.py` prints an `f32`/`u32`/`f64` triple beside every rip-relative operand, and two of
  the three are usually wrong.** Take the one the instruction's operand size asks for. The
  WaveHammer's `a1` coefficient was read as the qword-as-double (0.96715) instead of the float
  (0.86679) that way.

### Outside the repository

`C:\Users\sgdc3\Desktop\shadPS4\lbp3-re\` holds an older set that predates the delta being fixed:
`ebrela.py` (recovers the script-binding table by finding the RELA array by shape), `ebseg.py`
(program headers — **run this first on any new binary**), `ebschema.py` (recover a serialised
struct's field names and offsets; ⚠️ it assumes the member `lea` comes first and the name second —
pairing them the other way shifts every field by one and still looks plausible), `ebstr.py` (string
scan; ⚠️ its `v=` column uses a stale delta, ignore it). ⚠️ **It also has an `ebxref.py`, and that
one works in file-offset space.** The one you want is this repository's.

The shadPS4 workspace also has an uncommitted guest breakpoint tracer,
`src/core/guest_trace.{h,cpp}`, driven by `SHADPS4_TRACE=<addr,addr>` and `SHADPS4_TRACE_OUT=<path>`.
Every hit logs the address, the return address read from `[rsp]` (which names the caller even for
indirect calls) and the argument registers; every script→native call funnels through **one**
indirect call at file `0x3d9e72` with the callee in `rbx`, so a breakpoint there crossed against the
binding table is a complete script call trace. ⚠️ Three traps that all look like "the code is never
called": the trap arrives with RIP **on** the address rather than after it; never call `LOG_*` from
inside the handler (deadlock); the handler must be registered with
`AddVectoredExceptionHandler(1, …)`. Always arm the eboot entry point as a positive control before
believing a zero.

## Ableton Live as the reader — `tools/open-in-live.ps1`

`powershell -File tools/open-in-live.ps1 -file song.als [-shot live.png]` starts Live with the set,
waits for `Loading command-line document: done` in Live's `Log.txt`, prints the load's lines
(`Loading document`, any `Exception`), captures Live's window if asked, and closes Live. It is how
the `.als` export was checked; [ableton-interchange.md](ableton-interchange.md) has which members
of a debug copy make Live show the Arrangement, a track's devices, a clip's notes and their MPE.

- It asks Live to close and kills it only if it is still there 20 s later — which it usually is,
  since the closing dialog waits for an answer. A killed Live greets its next start with a crash
  report in the side panel; the capture is unaffected, and nothing goes to Ableton unless someone
  sends it.

- ⚠️ **A clean log is not a loaded set**: Live 11 opens a set with members missing and fills them
  with defaults without a word. Look at the capture.
- ❗ It refuses to start while Live is running, because it may kill Live at the end.
- ❗ It captures Live's **window** through `PrintWindow`, never the screen, which would take
  whatever else is open on the desktop.
- It sends no input. Keys and clicks from the script never reached Live, and a synthetic click on a
  desktop in use lands in whatever is on top.

## The sound harnesses — `packages/lbp-tracker-lib/dev/`

All run as `node <file>` — Node 24 strips the types unaided, and `engines` in the root
`package.json` says so. None is in the pipeline; each exists so that a
question can be answered in seconds instead of by ear.

| harness | what it proves |
|---|---|
| `render-level.ts [seqIndex] [seconds]` | one sequencer from a real level to a WAV, through the whole pipeline in `src/render.ts`. The Node half of the wrapper whose browser half is `packages/lbp-tracker-web/src/render-worker.ts`; the two produced the same 70,704,044-byte file on 2026-09-02 |
| `verify-midi.ts` | the MIDI round trip over the corpus: every sequencer exported and read back, records compared byte for byte, the chip tints checked (they have no MIDI message and no patch behind them), the loose (no-patch) numbers with `LBP_MIDI_LOOSE=1`, and the byte budget in [midi-interchange.md](midi-interchange.md) with `LBP_MIDI_BUDGET=1` |
| `live-sim.ts` | the live scheduler under Node: the plan built as `Player.load` builds it, in the pool's order and handed over on each note's walk, fed to a `Mixer` in look-ahead bursts, compared against the plain render. All three variants are bit-identical to the direct render, on the engine's clock too (a pool of 8, 1,200 to 2,450 notes stolen on three songs); ⚠️ **when this file and the renderer disagree, suspect this file first** — it has to imitate two cadences at once, and *34* in answered-questions.md is what that cost |
| `live-settings.ts` | that tempo, swing and the channel mixer can be applied live without re-planning: each voice placed on a clock run at the new settings (`placeOnClock`), bit-identical against a render that had those settings all along, and 0 of 163 notes handed over twice |
| `export-als.ts` | the Ableton export over the corpus: every sequencer to a set, the XML checked well-formed and its ids one space, and the counters summed (the numbers in [ableton-interchange.md](ableton-interchange.md)). With `LBP_ALS_OUT=<file>` it writes one set instead — `LBP_UID`'s, or the largest — gzipped, for `tools/open-in-live.ps1`. ⚠️ Nothing in Node can say whether Live *shows* what the file says |
| `probe-als-level.ts` | how loud the export's Sampler plays in Live: a Live project, written to `LBP_ALS_OUT` (default `fixtures/out/level-probe`), of fourteen tracks each holding one sustained sine at a known pressure (and one at velocity 64), the master at −inf, opening on the Session view. It prints what each track's peak box should read. ❗ **Someone has to press Play in Live**: neither a posted key nor a Max for Live device got it to play by itself ([ableton-interchange.md](ableton-interchange.md), *How it was checked*). It found the 22.8 dB `VolumeVelScale` added |
| `probe-als-filter.ts` | where the export's Sampler filter sits in Live, on the same frame as the level probe (`als-probe.ts` holds what the two share): a 1 kHz sine under cutoffs from 500 Hz to 4 kHz, the resonance at 0.53, and key tracking on keys 36 to 84. ❗ Someone presses Play here too. It found that Live tracks from key 60 ([ableton-interchange.md](ableton-interchange.md), *The instruments*) |
| `probe-als-slide.ts` | how Live's Sampler moves its cutoff with the per-note slide, on the same frame: the slide row to Filter Freq at 100, slides 0 to 127 under a 125 Hz dial, read against plain cutoffs. ❗ Someone presses Play. It found the law `als.ts` writes the slide with: 72 semitones × slide/127 ([ableton-interchange.md](ableton-interchange.md), *The instruments*) |
| `probe-als-envelope.ts` | how Live's Sampler filter envelope moves the cutoff, on the same frame: the envelope held at 1 with amounts 12 to 48, the envelope with the slide, and `pulse_wave`'s own setting. ❗ Someone presses Play. It found the amount is semitones at level 1 and adds to the slide ([ableton-interchange.md](ableton-interchange.md), *The instruments*); a sustain under 1 cannot be read on a peak box |
| `probe-als-cutoff.ts` | Live's Sampler low-pass around its dial at 250 Hz, 1, 4 and 8 kHz, on the same frame. ❗ Someone presses Play. It found the dial is Live's −8 dB point at every frequency ([ableton-interchange.md](ableton-interchange.md), *The instruments*) |
| `ladder-knee.ts` | prints `LADDER_KNEE` for `als-sampler.ts`: where `MoogLadder` attenuates a sine by Live's −8.0 dB, for nominal cutoffs from 20 Hz up. Run it again if `audio/moog.ts` changes; `test/als-sampler.test.ts` re-derives three points off the grid |
| `als-device-tree.ts <preset.adv>` | a Live device preset to the `DeviceNode` tree `als-xml.ts` emits, printed as TypeScript to paste. It refuses unless the tree rebuilds the file's elements in the file's order, which is the "derived, not typed" rule as a script. The master bus's Compressor and Limiter came out of it ([ableton-interchange.md](ableton-interchange.md)) |
| `export-plan.ts` | **the command line into the game**: a level, a plan or a `.lbptracker.json` song in, a `.plan` out, with the revision and the whole dependency table printed. `export-plan.ts <in> [out] [--ps4] [--seq <uid>]`; a level with several sequencers lists the others |
| `sequencer-memory.ts [dir ...]` | **the sequencer's thermometer over a corpus**: the game's own sum (distinct samples, FileDB sizes) for every sequencer in the toolkit's corpus, `fixtures/archive` and `fixtures/plans`, against `MaxSequencerMemory`; and what each instrument costs alone. It is the check on the reading in [sequencer-engine-inputs.md](sequencer-engine-inputs.md) — nothing may come out over the limit. ⚠️ A sample missing from the manifest counts as 0 and is reported |
| `pitch-probe.ts` | that `Notes.y`, `basenote` and `Splitnotes` share one numbering: zones against their own base notes, and the corpus's notes against the samples they resolve to |

⚠️ **A render that normalises cannot see a gain error.** `render-level.ts` normalises its WAV, and a
half-applied stereo fold sat unnoticed for two days until a listener played the live page, which
does not. Several tests normalise too; check the level with something that does not before ruling
a gain question out.

## Environment variables

| variable | read by | meaning |
|---|---|---|
| `LBP_LEVELS` | the corpus tests, `render-level.ts`, `verify-midi.ts`, `live-sim.ts`, `live-settings.ts` | a directory of level resources; default the toolkit checkout's `tools/sequencerdump/data`. The tests **skip** without it |
| `LBP_RINST`, `LBP_SMP` | `instrument.test.ts`, `envelope.test.ts`, `fsb.test.ts` (and cwlib-ts's `test/instrument.test.ts`) | the extracted instruments and samples; default `fixtures/rinst`, `fixtures/smp` |
| `LBP_FSB`, `LBP_PYTHON` | `fsb.test.ts` | a bank to decode against the Python oracle, and the interpreter to run `tools/` with |
| `LBP_EBOOT`, `LBP_BINDINGS`, `LBP_DELTA` | `tools/ebconf.py` | the eboot dump, the binding table, the file↔vaddr delta |
| `LBP_UID` | `render-level.ts`, `live-sim.ts`, `live-settings.ts` | which sequencer, by uid |
| `LBP_FROM`, `LBP_SECONDS` | `render-level.ts`; `live-sim.ts`, `live-settings.ts` | the window to render, in seconds |
| `LBP_ONLY`, `LBP_SKIP` | `render-level.ts` | comma-separated instrument GUIDs to keep, or to drop |
| `LBP_SEED` | `render-level.ts` | the PRNG seed. ❗ **Reseeding is the null hypothesis**: a difference smaller than a reseed is a difference a reshuffle could have produced (*15*) |
| `LBP_VOICES=<n\|off>` | `render-level.ts` | the pool size; `off` is `VOICES_UNLIMITED` |
| `LBP_RELEASE_TAIL=1` | `render-level.ts` | switch on the measured release tail, off by default (*29* in open-questions.md) |
| `LBP_MASTER=<0..10>\|game\|agc\|none` | `render-level.ts` | the master bus: ours at glue 4 by default, as the page plays it, another number for another glue (`-masterours<n>` in the file name; *42* in open-questions.md); `game` for the game's (`-mastergame`), `agc` for the game's with the AGC (`-masteragc`, *63*), `none` for the fold's gain alone (the chain before 0.2.43, `-masternone`) |
| `LBP_ONESHOT=full\|natural\|gate` | `render-level.ts` | the one-shot rule; `gate` is the engine's (*10*) |
| `LBP_NO_REVERB=1`, `LBP_NO_ECHO=1`, `LBP_NO_CLIP=1` | `render-level.ts` | drop a stage, for A/B |
| `LBP_NO_KEYTRACK=1` | `render-level.ts` | force the filter's key tracking to 0 |
| `LBP_PITCH=<guid>:<semitones>[,…]`, `LBP_UNPITCHED=<guids>`, `LBP_UNPITCHED_PERCUSSION=1` | `render-level.ts` | A/B switches on one instrument's playback rate — they answer *"is a sample mapped to the wrong octave?"* and nothing else |
| `LBP_LOOKAHEAD`, `LBP_TICK` | `live-sim.ts` | the page's look-ahead (0.35 s) and tick (0.1 s) |
| `LBP_POOL`, `LBP_LIVEPOOL=1` | `live-sim.ts` | the pool size for the live-pool variant, and whether to run it |
| `LBP_BLOCK`, `LBP_DIFF=<index>`, `LBP_DIFF_BLOCK`, `LBP_SCAN=1`, `LBP_SCAN_VOICES`, `LBP_SCAN_BLOCK` | `live-sim.ts` | render block size; bisect one voice's two renders frame by frame; scan every voice for a divergence. ⚠️ 128 is the one block size that hides the cadence bug of *34* |
| `LBP_STRIP=envelope,filter,…` | `live-sim.ts` | fields to delete from every voice spec before it is played, to bisect a divergence by feature |
| `LBP_TEMPO`, `LBP_SWING`, `LBP_CHANNELS` | `live-settings.ts` | the settings to turn to, as a listener would |
| `LBP_MIDI_LOOSE=1` | `verify-midi.ts` | export without the verbatim record patch, so MIDI alone is measured |
| `LBP_MIDI_BUDGET=1` | `verify-midi.ts` | print which carrier every byte of the corpus's export goes to — the table in [midi-interchange.md](midi-interchange.md) |
| `LBP_ALS_OUT`, `LBP_BAKE_SWING=1` | `export-als.ts` | write one set to that path instead of measuring the corpus, and bake the swing into it; `LBP_UID` picks the sequencer |
| `LBP_ALS_INSTRUMENTS=1` | `export-als.ts` | a Sampler per track from `fixtures/rinst` and `fixtures/smp`: over the corpus it adds the instrument counts, and with `LBP_ALS_OUT` it writes a project folder (set, samples, `Ableton Project Info`) instead of a lone `.als` |
| `LBP_ALS_MASTER=<0..10>` | `export-als.ts` | the tracker's master bus on the master track at that glue (*The master bus* in [ableton-interchange.md](ableton-interchange.md)); over the corpus it checks the sets with the two devices in |
| `LBP_LIVE_EXE`, `LBP_LIVE_LOG` | `tools/open-in-live.ps1` | Live's program and its `Log.txt`; default this machine's Live 11.3.43 |
 