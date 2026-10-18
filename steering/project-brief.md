# Project brief — what we are building and what "faithful" means

## The thing

LittleBigPlanet 3 ships a **Music Sequencer**: a Create Mode gadget with a grid of steps, onto
which you place **Instruments**, each of which owns its own note grid. It has a tempo, a swing
amount, up to 6 mixable channels, and per-instrument echo and reverb sends. Composers in the LBP
community used it as a real DAW for a decade; the levels are full of original music that only
exists inside `.plan`/level files.

We are building a **standalone tracker** that reads that music, plays it back exactly as the game
does, lets you compose in it, and — ideally — writes it back out in a form the game can load.

Target platform is the **browser**. This is a real constraint, not a preference: the audience is
the LBP creator community, and asking them to install a native binary loses most of it. It is also
achievable — see [tracker-architecture.md](tracker-architecture.md).

## What "faithful" means, and how far each part has got

Ranked by how audible a mismatch would be. Every row was measured out of the game's own binaries;
the file named is where the measurement lives.

| # | aspect | fidelity | how it is known |
|---|---|---|---|
| 1 | sample data | **bit-exact** | the sequencer's samples are 16-bit PCM RIFF `.smp` files in the FARC archives, with the sound designer's loop points in their `smpl` chunks — [game-assets.md](game-assets.md) |
| 2 | pitch | **exact** | `exp2f((pitch + fineTune − rootNote)/12)`, `fineTune` in semitones, read out of `fmodextinput.prx` — [synth-engine.md](synth-engine.md). No sample-rate term in it and none in the loader (`v0xb3e520`): the 42 `.smp` at 44.1 kHz play +1.47 semitones in the game, and here (*43*) |
| 3 | timing: tempo, swing, triplets, loop, start point | **exact** | `720000/tempo` frames per step, alternate steps stretched and squeezed by `swing/2`, positions in thirds of a step, onsets and gates on the engine's 256-frame chunks since 2026-10-12, in the render and the live player — [synth-engine.md](synth-engine.md) |
| 4 | the synth block: unison stack, ladder filter, two envelopes, three LFOs, drive, level | **exact, and checked running** | all 27 `Params` named and read instruction by instruction; since 2026-09-08 one ladder pair per record on the ±1-clipped sum of its layers, and every ramp per sample between the chunk's two evaluations — [synth-engine.md](synth-engine.md). Since 2026-10-11 checked against `fmodextinput.prx` *running*: 203 of 204 one-instrument scenes below −60 dB of their loudest window, median −92 dB; on the engine's clock, with the record's float32 arithmetic, all of them, median −107 dB (*62*) |
| 5 | resampling | **exact in arithmetic** | two-tap linear interpolation over ÷2/÷4 mip copies built the engine's way (an int16 pair average). The one operation JavaScript cannot reproduce is the drive shaper's `vrcpps` reciprocal, which lands within an ulp |
| 6 | volume, pan, mixer channels, sends | **exact** | a linear pan law, rows banded into `NumChannels` channels, both sends read — [synth-engine.md](synth-engine.md) |
| 7 | echo | **exact** | not an FMOD DSP but a delay inside `fmodextinput.prx`; `EchoTime` is a delay in **beats** — [synth-engine.md](synth-engine.md) |
| 8 | reverb | **exact, and checked running** | `fmodsmsreverb.prx`, read end to end and run, a preset applied after it has run included (`Reverb.reconfigure`) — [lbp-audio-engine.md](lbp-audio-engine.md). The live player re-applies the same setting as the game does, and builds a new one on a changed setting; that is a residue in [open-questions.md](open-questions.md) |
| 9 | voice pool, and which clips play | **exact in mechanism** | 32 records, steal the quietest; one clip per board row, and the walk's scan, over headers sorted by column and row, stops once rows 0..7 are taken (*Which clips spawn* in [synth-engine.md](synth-engine.md)); the engine holds a record through the release and this project frees it at the note's end — a decision, below. On the engine's clock 16 corpus songs agree with the module to better than −100 dB (*62*) |
| 10 | compressor | **exact, one choice away** | `SMS WaveHammer`, last on the sequencer's channel, checked against the module *running*, its template re-read and FMOD's creation path read for anything that would change it; the first half of the game's master bus — [lbp-audio-engine.md](lbp-audio-engine.md). The page plays ours by default since 2026-10-12, below |
| 11 | output stage | **exact; its gain on, its narrowing one choice away** | the game renders 7.1 and a stereo listener hears a fold; the game's master bus runs it whole, gain and narrowing, after the WaveHammer, with the channel at the unity `setDefaults` gives it — [lbp-audio-engine.md](lbp-audio-engine.md). Ours keeps the fold's gain and the file's own image |

**Nothing in the signal path is unread.** What is left is three decisions, one question about the
compressor's input, and a handful of measured residues nothing models yet, all in
[open-questions.md](open-questions.md). Our own master bus — a glue and a limiter, nothing the game
does — is the page's default since 2026-10-12, with the game's one choice away (*42*).

### The deliberate deviations

Each is a listening judgement by the project's owner that outranks a static reading, and each is
kept one switch away from the measured behaviour so a capture can settle it.

| what | the engine | this project | why | where |
|---|---|---|---|---|
| release tail | a voice holds its pool record until its envelope reaches zero | the record is freed at the note's written end (`releaseTail` off) | with the tail on, a listener rejects the render at a named timestamp; with it off, accepts it | *29* in open-questions.md |
| a note's end | a release shorter than a chunk lasts one chunk, 5.3 ms, and a freed record's ladder stops in one frame | a release of at least 20 ms and a 20 ms fade on the ladder's tail (`declick` on) | the listener heard both click on *Rhombitruncated*, and heard them go | *61* |
| master bus | `SMS WaveHammer` at 10:1 from −21 dBFS, then the fold's gain and narrowing: −20 to −22 LUFS over four whole songs | ours by default: the fold's gain and the file's own image, a 2.5:1 glue and a limiter at −0.3 dBFS, −14 to −16 LUFS; the game's, with or without an AGC after it (*63*), and `'none'` one choice away | heard side by side, the owner found the game's far quieter and worse, after it had been re-read and found as read | *42* |

⚠️ **The compressor and the stereo narrowing were on this table from 2026-09-06 to 2026-10-11**,
off by the same kind of listening judgement. The owner then asked for a master bus faithful to the
game, by default, with ours beside it, and on 2026-10-12, having heard both, for ours again: the
master bus row above. So were the note onsets until 2026-10-12, sample-accurate against the engine's chunk grid while the
grid's song alignment was an inference; running the module settled it, the owner chose the
engine's clock, and the tracker's is one switch away (*3 / 3b* in answered-questions.md).

### The lesson the reverb left behind

This file used to say the reverb was the project's one genuine risk: the eboot links both FMOD's
`FMOD_DSP_TYPE_SFXREVERB` and Sony's proprietary `aSfxDsp.cpp`, and which one `ReverbSetting`
selected was unknown, so the plan was "close, not identical". **Neither was the answer.** The
reverb is `fmodsmsreverb.prx`, a 16 KB plugin the game ships in `gamedata_orbis/spu/` and loads at
runtime, and it has been read end to end. ⚠️ The risk was declared on the strength of *what the
eboot links*, and the answer was in a file next to it that nobody had opened; "which of these
two?" was the wrong question for four sessions. The same shape recurs: the synthesiser itself is a
23 KB plugin in the same directory, found after eight searches of the 18 MB eboot for it.

## Scope

**In scope**
- Read the game's instrument definitions and sample banks from the user's own game files.
- Play back sequences with the game's synthesis model.
- Compose: a tracker-style grid editor.
- Export audio (offline render).
- Import existing LBP sequences, and export back to a game-loadable form — [cwlib's export-to-game.md](../../cwlib-ts/steering/export-to-game.md).

**Out of scope, at least for v1**
- The "Interactive Music" object (stems + sliders). Different system, different data — see
  [lbp-audio-engine.md](lbp-audio-engine.md). Worth doing later; do not conflate it with the
  sequencer.
- Anything to do with the game's SFX, dialogue, or ambience.
- Emulating the game. We read its data files, we do not run its code — ⚠️ with one deliberate
  exception: `tools/runhammer.py` and `tools/prxrun.py` load the game's DSP plugins (with its own
  `libc.prx`) into a Windows process as *oracles* for the model, never as a playback path.

## Assets and licensing

The instrument samples are copyrighted Sony / Media Molecule material, and every level in the
public archive is its creator's work. **Nothing of either is in this repository**, and nothing is
baked into a build: `fixtures/` is gitignored, and the pages read a level from a file the user
opens, a folder, a zip, or the public archive, entirely client-side, with no upload.

Where a *deployment* gets the samples from is the deployment's decision, and the plan of record is
that the hosted copy serves them from the same bucket as the site. The code's constraint is only
that assets arrive at runtime; the app claims nothing either way, and `LICENSE` says only that the
repository contains no game data, which stays true. See [game-assets.md](game-assets.md).

## What counts as evidence here

- A fact enters steering **with how it was measured** — an address, a corpus count, a script —
  so the next session can re-check it. Anything else is a hypothesis and lives in
  [open-questions.md](open-questions.md).
- **The game's own bytes outrank every other source.** ennuo's toolkit is a decade of community
  reading and it is still a reading: it enters as a hypothesis until an address or a file diff
  confirms it — [cwlib's lbp-modding-toolchain.md](../../cwlib-ts/steering/lbp-modding-toolchain.md).
- **A capture of "the game" is a capture of shadPS4.** Every recording this project has settled
  against was made under the emulator, which runs the game's own plugins. A capture is therefore
  trustworthy for *structure* — how many voices sound, whether a note is gated, the ratio between
  two channels — and **not** for absolute level or spectrum, because the emulator's mixer, its
  7.1→stereo downmix, SDL's resampler and the host device sit between the plugin and the file. Say
  which kind a finding is when you record it. Question 23 was withdrawn for being the second kind;
  the one-shot gate (*10*) and the pan width (*22*) stand because they are the first. Point shadPS4
  at an audio device with more than two channels and no downmix happens at all.
- **A disassembly that contradicts a million-note corpus is a misread disassembly.** The corpus
  caught two readings before they shipped (*19*, *12* in answered-questions.md).
- **A fix that removes a symptom is not evidence** (*6b*, *10*). **A negative result from a pattern
  scan is only as strong as the pattern** (*11*, *21*). **An absolute-offset search is only sound
  if every access uses the same base** (*37*). **"Not found" is not "not there"** until the
  population has been enumerated (*37*).
- **The game's plugin, run, outranks a reading of it** — and the harness around it is a model of
  the engine too. `tools/prxsynth.py` runs `fmodextinput.prx` on a scene laid out as the eboot
  lays it; every field that scene invents is a claim, and one invented clip length once made the
  module look silent mid-song (*62*). The difference is measured against the loudest window, not
  each window's own.
- A listening report from the project's owner outranks a static reading where the two disagree,
  and the reading is kept one switch away — that is what the deviations table above is.

## Where the knowledge came from

Everything in this workspace was recovered from LBP3 1.28 (`CUSA00063`) between 2026-09-01 and
2026-09-06: the eboot's serialisers, call graph, dynamic imports and RTTI; the three audio plugins
in `gamedata_orbis/spu/` (`fmodextinput`, `fmodsmsreverb`, `fmodsmswavehammer`) and the game's own
`sce_module/libc.prx`; the shipped banks and FARC archives; a corpus of real levels; and captures
of the game under shadPS4. The methods and the anchors are in [eboot-re.md](eboot-re.md) so that
the next session can extend the map instead of re-deriving it.
