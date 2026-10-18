# Answered questions — where each answer lives, and the wrong turns on the way

Questions that are **settled and implemented**. The measurement behind each now lives in the
descriptive file named at the top of its entry; what stays here is the answer in a line, the
evidence that is not restated elsewhere, and **the wrong turns** — which are the useful part.
Several of these were got wrong once, twice in one case, and every wrong reading below was arrived
at by a plausible-looking argument that could be arrived at again.

Numbers are the question's historical label; code and other files refer to them (*37*, *39*, …).
Entries are grouped by topic, not by number. The questions about the files themselves — the board
cell, plans, streaming, dependency types, the writer the game accepts, the chip table and its
tint, the zlib window, the PS3 backup, the LBP1 readers, the wormhole (*16*, *25*, *26*, *28*,
*35*, *36*, *46*–*49*, *54*) — are cwlib's, in
[cwlib's answered-questions.md](../../cwlib-ts/steering/answered-questions.md); the numbering is one
sequence across both.

The recurring lessons, each with the entry that taught it: a fix that removes a symptom is not
evidence (*6b*, *10*); a negative result from a pattern scan is only as strong as the pattern
(*11*, *21*); a disassembly that contradicts a million-note corpus is a misread disassembly (*19*,
*12*); an absolute-offset search is only sound if every access uses the same base (*37*); "not
found" is not "not there" (*37*); a claim added to a steering file must be checked against what
the file already says (*12*); when a note quotes an address range, disassemble past its end
(*12*); a partial fix that improves the number is the most misleading result there is (*34*); a
render that normalises cannot see a gain error (*22*); a quantised clock read at a fixed point of a periodic process is
not dithered by anything (*55*); a meter that looks wrong may be right about the wrong thing, so
measure the whole process from outside first (*56*); an alarm is tested by making happen what it
alarms about (*57*); a harness is a model too, and every field it invents is a claim (*62*);
zeroing a gain inside a loop hides every error that feeds the loop (*62*).

---

# The synthesiser

## 5. `finetune` units — semitones

**Answer**: `0x1c60` adds the slot's f32 into the same sum as the note and the root note before the
one division by 12 — [synth-engine.md](synth-engine.md). `FINETUNE_PER_SEMITONE = 1`; it was 100
(cents) on a coin flip. The corpus's 23 distinct non-zero values (−0.17 … +0.56) read as an ordinary
fine-tune range in semitones and as five-thousandths of a semitone in cents.

## 7. The sampler and the pan law — linear, over octave mipmaps

**Answer**: the sequencer's sampler is `0x3780` in `fmodextinput.prx` — two taps on int16 scaled
by `1/32768`, the source switched to a ÷2 or ÷4 copy at ratio 2.0 and 4.0 — and its pan law is
`left = 1 − p`, `right = p`. Not `fmod_dsp_resampler.cpp`, not equal-power —
[synth-engine.md](synth-engine.md).

❌ **`sinc8` was the default for four sessions on the reasoning that it "added least of its own
character while the question was open".** The reasoning was right and its conclusion wrong: "adds
least character" is a tiebreaker, not evidence, and it survived because nobody went and read the
sampler. Clean was never the goal. The SNR table that promoted the question (linear 19.0 dB at
4 kHz against `sinc8`'s 72.0, at rate 0.5) is now a statement of how much the mipmapping has to do.
❌ `panGains` had assumed equal-power since early on; five tests depended on the old `sqrt(1/2)`
centre factor, which is a fair measure of how much a pan law touches.

## 5b. The ÷2 and ÷4 copies — an int16 pair average

**Answer**: `0x12e0` averages adjacent frames of the same channel in int16, rounding toward zero —
[synth-engine.md](synth-engine.md). Found by aligning a disassembly on a known instruction and
stepping the start offset until it decoded, because the function has no frame pointer and prologue
scans walked past it.

❌ This entry once said `[rdi + 0x78]` was "a running maximum of sample lengths, not one sample's
length". Both halves were wrong (*12b*), and the wrong reading corrected question 12 *away* from "a
per-slot length", which is what it is.

## 41. Which reverb name goes with which preset — read out of the script's bytecode

**Answer**: the Music Sequencer's list is six, in this order, and `ReverbSetting` indexes it:
**Small Room, Room, Bright Plate, Hall, Big Hall, Cathedral**. The measurement lives in
[lbp-audio-engine.md](lbp-audio-engine.md), *The six the sequencer offers*, and the table is
`REVERB_NAMES` in `packages/lbp-tracker-lib/src/audio/effects.ts`.

**How**: the toolkit parses a `.ff` into an `RScript`, and `AddReverbs__` in
`gamedata/scripts/tweaksequencer.ff` is six `ARRAY_APPEND`s over six `Translate` calls.
❗ **The operand of a `LoadConstInstructionInt` is inline in the instruction word**, not an
index into `constantTableS64` — which is empty in these scripts. That is the whole reason a
session spent an hour searching the script's bytes for those ids as u32 (both endiannesses)
and as LEB128 varints and concluded they were not there. They were, packed.
`tools/ReverbOrder.java` is the walk, reusable on any tweak script.

⚠️ **The wrong turn this question exists to have prevented**: naming preset 11 the Cathedral.
It rings for 5.0 s, longer than every other preset, and the guess is irresistible. It is the
**Big Hall**; the Cathedral is preset 2, which rings 3.0 s and has the longest pre-delay at
70 ms. Two independent checks say the join is right — `Bright Plate` is the one preset whose
damping filter is off, and `Small Room` is the shortest — and neither of them is a name.

⚠️ A second thing the corpus got wrong on its own: settings 1..5 are the only ones any of the
338 sequencers hold, which read as "the list is five". The list is six. **0 is Small Room, and
nobody picked it.** An unused option is not an absent one.

## 12b. `[slot + 0x78]` — the playable length, with the loop beside it

**Answer**: `+0x78` the playable length in frames, `+0x7c` the loop start, `+0x80` the loop length;
the mip builder only clamps `+0x78` down to what decoded (`jle` skips the store otherwise) and
nothing in the PRX initialises it — the records arrive filled from the eboot —
[synth-engine.md](synth-engine.md). `0x3780` wraps the position with them and `0x3035` stops a
loopless voice past `+0x78`, which is "a loopless sample plays to the end of the sample" written in
the engine.

⚠️ Four searches went looking for who writes `+0x78` in the eboot — no `imul …, 0x98`, no per-field
stores, no `setParameterData` — before the discovery that the eboot owns all 6,992 bytes and hands
them over by pointer. All correct, all irrelevant: the field was never the problem (*12*).

## 11. `Splitnotes` — the zone count and the strict bound

**Answer**: the zone count is the number of leading non-zero bounds, and the comparison is strict
(`bound > note` continues), so a note on a bound takes the zone above it —
[sequencer-engine-inputs.md](sequencer-engine-inputs.md), [synth-engine.md](synth-engine.md). 215,449 of
968,829 corpus notes on multi-slot instruments sit exactly on a bound, across 47 of 68 instruments.

❌ **"The synth PRX never reads `Splitnotes`."** The first scan looked only for `[reg + disp]`; the
walk uses `[rdx + rax*4 + 0x4c4]`, indexed addressing, so it was invisible. **A negative result
from a pattern scan is only as strong as the pattern.** Before the walk was found, two
engine-independent checks were run — unreachable zones with the count fixed (1 either way, the
ukulele) and corpus tracks reaching more distinct samples (5,657 for `<` against 3,900 for `<=`) —
and neither was decisive; `<` stayed because it was what was already there, with a base-in-zone
justification that this same file warns against. It was right by luck.

## 19. The key-zone walk — `+0x4c4` is `Splitnotes[1]`

**Answer**: the engine's walk indexes from `Splitnotes[1]`, `resolveSlot` already did, and
`test/instrument.test.ts` runs the two against each other over 68 × 128 notes —
[synth-engine.md](synth-engine.md).

❌ **The literal-from-`[0]` reading was implemented, measured and reverted inside an hour.** It was
posed as "the engine's walk contradicts the corpus": over 953,221 notes the median of (note played
− base note of its slot) moved from 0 to 7, `woodpecker` to +35, `marimba` to +20, and
`e_guitar_distorted` (bounds `[87,60,1,0,…]`, samples D5 base 62 and E4 base 52) sent note 65 to the
*lower* sample. **A disassembly that contradicts a million-note corpus is a misread disassembly.**
`instrument.ts`'s own comment — `MAX_SPLITS = 9; // 8 zones; [0] is a constant, [1..8] are the
bounds` — had said so all along.

## 18. `Notes.y`, `Key` and `Splitnotes` — one numbering, and `Key` really transposes

**Answer**: `y`, `basenote` and `Splitnotes` share one numbering (`pitch-probe.ts`: 188 of 249
zones contain their own base note against 48 with the toolkit's 20-semitone shift; the corpus
median of note − base is 0 with per-instrument medians scattering −18 … +28). `Key` transposes by
`key mod 12`, C at 12, 0 the untouched default, applied *after* the scale snap —
[synth-engine.md](synth-engine.md).

**What it cost while unread**: 2,461 of 129,696 placements (1.90%) and 75,073 of 3,199,788 notes
(2.35%) played in the wrong key, up to 11 semitones out, most commonly +3. ⚠️ `blockRoot` sat in
steering for a session as a named unknown: the quantiser takes exactly `edi` = note and `esi` =
scale, so **no key reaches it**, and the answer was two instructions away in the *other* binary
(`v0x160806`). When a formula has a term supplied from outside the module you are reading, the
module cannot tell you what that term means. ⚠️ `0x250` in older notes is inside the quantiser,
which starts at `0x240` — wrong by 0x10, not the usual 0x40.

## 20. The `x`/`y` interpolation — `x + f·(y − x)`, on all 27

**Answer**: every one of the 60 reads into the `Params` array is followed by `y − x` —
[synth-engine.md](synth-engine.md). It had been measured on the sends alone (`0x3b64`) and
*assumed* for the other twenty-six, and getting it backwards inverts every range in the game at
once on the 19% of corpus notes that carry a non-zero modulation.

⚠️ The four filter parameters are why a naive scan reports 23 of 27 (batched into `xmm8`…`xmm14`
and combined much later). Two things came free: the cutoff is squared *after* interpolation
(`0x29ff`), corroborating `filterAtInto`; and the filter block evaluates every parameter twice at
two different `f`s (`0x2a54` with `xmm15`) — a *Residue* in [open-questions.md](open-questions.md).

## 6b. The filter's four controls — settled, and got wrong twice on the way

**Answer**: `Params[3..6]` = cutoff, resonance, key tracking, envelope amount; the resonance takes
the envelope factor, not the pitch; the clamps and the 0.99 bypass are the engine's —
[synth-engine.md](synth-engine.md).

❌ **Two wrong turns, and the second was a consequence of the first.** "The resonance follows the
key tracking" was asserted from `0x2a50` alone, on the assumption that `xmm4` was the keytrack (it
is the envFactor). Then "`Params[5]` and `[6]` are swapped": with the resonance wrongly taking the
pitch, `musicbox.rinst` (key tracking 1) self-oscillated on high notes, and swapping the indices
made the symptom go away — by moving the error, not removing it, silently trading every
instrument's filter-envelope depth for its key tracking, which a listener heard immediately as
broken envelopes. **A fix that removes a symptom is not evidence.** What settled it: the two terms
have the same `1 + (X − 1)·p` shape, so only the identity of `X` distinguishes them — `[rbp-0xa90]`
is set to 1.0 at `0x1de5` and multiplied at `0x1e0a` by a frequency over the slot's base frequency
(the pitch ratio); `[rbp-0xb70]` receives the envelope evaluator's result at `0x21ed` (envelope B).
Two short traces, cheaper than either wrong turn.

## 6c. The unison stack — measured, documented, and not wired up for a session

**Answer**: `Numstack` layers per note with per-layer detune, pan spread and start offset, gain
`sqrt(1/Numstack)`, LFO phases fanned by `spread · 2π/Numstack · layer` —
[synth-engine.md](synth-engine.md).

⚠️ `STACK_PARAMS` carried all three fields with their formulas and `OUTPUT_PARAMS.level`
documented the `sqrt(1/Numstack)` beside it, and **nothing read any of them**: the renderer played
one voice per note regardless. `ghost` — `Numstack` 3, LFO 3 spread 1.0 with depth 0.27, an
auto-pan fanned a third of a cycle apart — cannot be produced by one layer at all. Wiring it up
moved the rendered mix's peak from 1.749 to 1.491, the `sqrt(1/N)` correction arriving.

## 6d. Per-note modulation — ramped by the engine, re-read every block

**Answer**: the note word's bits 24..27 (`× 1/15`) pick a point inside every `Params` range; the
engine sets a slide rate for it beside the ones for volume and pitch and re-derives every
parameter once per block — [synth-engine.md](synth-engine.md). `VoiceSpec.morph` carries the ramp
and `Voice.render` re-derives per chunk from the *interpolated modulation*.

❌ **This entry said the opposite for two days, and the reason it gave was a reason and not a
measurement**: "modulation is not interpolated, because it feeds things read once when the voice
starts". The renderer had also been passing a hard-coded `0` for a day after the field was
correctly named, so every note used every parameter's `x` endpoint. ⚠️ **The send's weight was
measured wrong**: `Params[25]` swings up to 0.210 across the affected notes, and that number was
quoted — but the *effective* echo send swings at most 0.045, on 68 notes in 5 sequencers, because a
placement with `echoSend == 0` mutes the instrument's send before the modulation gets a say. The
whole audible weight of the modulation is in the filter, the level, the LFOs and the drive.
Verified from both ends: 25 s of `Indestructible` (no moving note) renders to the same md5 with and
without the change; 25 s of `Ascetic` (519 moving notes) differs on 30.3% of frames with the
difference only 22 dB below the signal.

## 12. `Params[2]` — the engine throws layer 0's random start away

**Answer**: the stack loop computes a random start for every layer and `0x1bda`, the instruction
after the loop, clears layer 0's; `Params[0]` and `[1]` are *not* cleared —
[synth-engine.md](synth-engine.md). A listener's repair by ear — confining all three
randomisations to layers 1+, worth 11.6 dB of drum kit — was half the engine's behaviour and half
wrong: it silently dropped a per-note detune from 19 unstacked instruments and a per-note pan
scatter from 4.

❗❗ **The answer was already written down, on 2026-09-01, and nobody joined it up.** The stack-loop
pseudocode in steering carried `voice.position[0] = 0 ; layer 0 always starts at the beginning`
from the day the loop was first read, and two lines below it a summary table said `Params[2]`
starts *each layer* at a random point. The file contradicted itself in one screen; the question was
opened beside it, re-attacked three times over four days, and repaired by ear while the
measurement sat there. **A prose table restating a transcript is exactly where the two drift
apart, and the drift is invisible because both halves look measured.** Before adding a summary row
next to a transcript, read the transcript.

⚠️ **Every re-read stopped at the `jl`.** The range steering named was `0x1a70`–`0x1bd5`, and
`0x1bd5` is the byte after the loop's backward jump — three sessions disassembled exactly up to the
answer and no further. ⚠️ "1.000 is a default nobody changed" was killed by the corpus (10
instruments at exactly `1.000/1.000` against 41 at `0.000/0.000`) and taken as evidence the field
must *do* something; it does, just not on those ten. A parameter can be deliberately set and still
be inert. And `RAND_MAX` was settled by reading the game's own `libc.prx` rather than reasoning
about FreeBSD, which would have got it wrong.

## 8. The remaining `Params` — LFO 3 pans, read end to end

**Answer**: LFO 3's folded value is written to one of two `{value, increment}` stack arrays
(`rbp-0x170`) and the per-sample loop spends it as the pan; LFO 2's goes to the other (`rbp-0xd0`)
and is spent as a gain — [synth-engine.md](synth-engine.md). Three layers of pan compose and
`lfo.ts` + `mixer.ts` already did exactly that.

⚠️ **Telling the two buffers apart is the whole trick**: reading either store without following
its pointer to the sample loop names the wrong destination. The oscillator at stub `0x130` is
`_FSin`, named from the import table by `tools/prxnid.py` rather than inferred; which of `edi = 0`
and `1` is the sine was not pinned and measurably does not matter — all six calls pass 0 and the
phases are randomised, so sine versus cosine is a constant offset on an already-random phase.

❌ **The fold was right and its call site was wrong for a week** (2026-09-01 to 2026-09-08): the
mixer fed it `2 × pan`, on no reading, and the fold being the identity on `[0, 1]` that put every
centred voice on the right wall — RMS 0.087 left against 0.422 right — and folded the sweep
through 1 at twice the rate, on the seven shipped instruments with a pan LFO. `lfo.test.ts` pinned
`panFold` and never what was passed to it. ⚠️ A test of a pure function proves nothing about its
call site; the test that catches this renders a centred voice with the LFO on and checks the
balance, and it is there now.

## 21. `Params[26]` — a soft-clip drive on the sampler's output

**Answer**: `f(x) = (1 + k)·x / (1 + k·|x|)` with `k = 2d/(1 − d)`, per layer, on the sample read,
before the gain and the pan — [synth-engine.md](synth-engine.md).

❌ **It was hiding behind a "settled" statement that was wrong twice over.** The reverb entry
recorded `voice+0x20` as "the instrument's own reverb send … and then nothing reads it — a grep of
the whole PRX finds the store and no read." `+0x5b8` is `Params[26]`, not the send (`Params[25]` is
at `+0x5b0`), and it **is** read — by a **`vbroadcastss`**, which is how a grep for `vmovss` missed
it. ⚠️ And the pairing that hid it: `e_guitar_power` and `e_guitar_distorted` carry the lowest
output levels in the game (0.088, 0.161), which is what you would expect if the drive adds level
that has to be taken back out. Implementing the level without the drive made them quiet *and*
clean — two errors partly cancelling, so nothing sounded obviously broken.

## 27. The LFO cadence — twice per layer per chunk, not per sample

**Answer**: the six `call 0x130` sit in the per-layer loop — **two per LFO**, at the phase and at
the phase plus the chunk's increment — the phases advance once after it, and each pair becomes a
`{value, step}` the sample loop ramps — [synth-engine.md](synth-engine.md). `Voice.startSegment`.
❌ The 2026-09-05 reading of this entry took the double at `[r14-8]` for a constant rate and did
not ask what the second double at `[r14]` was; *44*.

**What it was worth** on `C4K3 S0NG` (244 tracks, 13,091 notes, 3,634 stolen at the time): the
live path's 30 busiest seconds 4,183 → 3,235 ms, the whole song offline 35.8 → 20.2 s, audio-thread
load 16–36% → 11–26%. Half of that was 1.19 `Math.sin` calls per voice-frame; the other half was
**a delay bug it uncovered**: a chunked voice counted its start delay one chunk at a time, so a
voice starting three minutes into an offline render did 78,000 empty iterations before its first
sample (the full-song render went from 35.8 s to 63.2 s the moment LFO voices started chunking,
which is how it was found). ⚠️ The chunk grid must not be counted from the caller's slices:
`delay + 128k` boundaries make an offline and a live render disagree, and `audio.test.ts`'s
"same audio whatever the block size" caught it within a minute. A grid counted in the voice's
own rendered frames is a different thing and passes it — *60*.

**Four things measured that were not worth doing**: per-quantum overhead does not exist (128 and
4,096 frames cost the same to the millisecond); hoisting `this.*` into locals made it 3% *slower*;
micro-fixing `readMipped` changed nothing despite the profiler attributing 13% to it — a sampling
profiler's per-function attribution inside a hot inlined loop is a hint, not a measurement;
extending the fixed-filter path to `keyTrack === 0` would reach 7% of voice-frames against 3%.
The engine's cost, for the next time: 50.3 M voice-frames per 30 s at 80 ns each, and nothing is
idling.

## 44. The ramp inside a chunk — read as a staircase for four days

**Answer**: everything the renderer derives, it derives at both ends of the chunk and ramps per
sample between them — rate, gain and pan as `{value, step}` pairs, the filter's cutoff and
resonance re-derived per sample from their own ramp, the envelopes from two calls; only the drive
and the two sends are chunk constants — [synth-engine.md](synth-engine.md).
`Voice.startSegment` / `renderSegment` in `mixer.ts`.

❌ **A measured cadence was taken for a measured value.** *27* read the six sine calls as one per
LFO and the layer's rate as "a double the sample loop reads as a constant", and the mixer held
each value flat for 256 frames. Both halves of the answer were in the same disassembly — six calls
for three oscillators, and two `f64` per layer at `[r14-8]`/`[r14]`, which the commit that first
traced them on 2026-09-01 had already called "a start value and the step to walk it to the end of
the block". A later, narrower reading replaced a broader earlier one because it was newer. ⚠️
Count the calls before naming the cadence; when a stack slot holds two of something, ask what the
second one is; and when a reading contradicts an older commit message, read the older one first.

## 60. One-step `triangle_wave` notes click at both ends — the ramp after an event is a whole chunk

**Answer**: the engine starts a note and reads a closed gate only at the top of a chunk, so a
stage shorter than a chunk is ramped across the whole chunk after its event — *The gate and the
ramps* in [synth-engine.md](synth-engine.md). `Voice` starts its segment grid at the note's first
frame and again at the gate (`gridOrigin` in `mixer.ts`, 2026-10-05); `audio.test.ts` pins it at
nine onset and gate positions, and fails on the old grid.

Measured on sixteen one-step `triangle_wave` notes at 120 bpm, modulation 0 (attack 12 frames,
release 38): with the mixer's running clock as the grid, the fade after the gate lasted anything from 38
to 293 frames depending on where in a block the note ended (48 to 272 on these sixteen), and the energy above 8 kHz in a 256-frame
window over the end rose to **+16.0 dB** over the sustained note's own (mean +2.1); at the onset,
up to +0.2 dB. On the voice's grid every end measures −2.3 dB and every onset −8.8 dB.

❌ **A residue was called inaudible because both sides were "the same curve with different
knots".** The mixer's grid was the global block clock on the argument that a voice in the engine
always starts at a block's first frame — which is exactly why its grid is *the voice's*: with
onsets placed to the frame (*3*), the global grid put a knot anywhere in a note's first and last
block, and for a stage shorter than a block the knot *is* the stage's length. ⚠️ Piecewise-linear
ramps with different knots are the same sound only while each stage spans several knots.

## 62. The synthesiser against its own module — what running `fmodextinput.prx` found

**Answer**: the game's synthesiser, loaded with the game's `libc.prx` and run on the eboot's own
scene layout (`tools/prxsynth.py` beside `packages/lbp-tracker-lib/dev/prx-scene.ts` and
`prx-compare.ts`), against our render of the same scene. On the tracker's clock 203 of 204
one-instrument scenes sit below −60 dB of their loudest window, median −92 dB overall. On the
engine's clock, since the record's own float32 arithmetic (`VoiceSpec.engine`), every one of the
199 that sound does, median −107 dB, and 16 corpus songs, 20 s each, agree to −102 … −127 dB where
they were at −61 … −91:

| song | before | after | | song | before | after |
|---|---|---|---|---|---|---|
| `Vision` 15853 | −62.9 / −54.2 | −126.7 / −125.7 | | 36305 | −76.4 / −75.4 | −117.8 / −99.9 |
| `Avian` 281831 | −61.2 / −57.8 | −120.3 / −118.1 | | 68746 | −74.8 / −75.5 | −110.4 / −113.4 |
| 24870 | −79.7 / −69.5 | −107.2 / −103.3 | | 271798 | −72.2 / −75.5 | −118.6 / −122.1 |
| 170680 | −79.6 / −75.3 | −123.1 / −118.5 | | 15855 | −82.0 / −78.8 | −116.1 / −107.1 |
| 743527 | −82.3 / −81.1 | −110.6 / −108.3 | | 64531 | −87.3 / −81.1 | −104.2 / −104.4 |
| 744399 | −86.2 / −81.9 | −117.5 / −114.1 | | 179190 | −84.5 / −83.4 | −102.3 / −100.8 |
| 4404710 | −83.2 / −86.8 | −112.1 / −116.6 | | 74639 | −89.5 / −87.0 | −109.7 / −107.1 |
| 731173 | −83.7 / −87.8 | −110.1 / −111.6 | | 15843 | −91.1 / −91.7 | −105.6 / −103.8 |

(whole render / worst window against the loudest, dB). Longer: 281831 over 175 s −59.7 → −89.9,
731173 over 100 s −59.8 → −100.8, 743527 over 180 s −64.6 → −115.2, `C4K3 S0NG` over 28 s with the
tail on −63.0 → −101.1. Each fix lives where its fact does — the start/end table and the walk in
[synth-engine.md](synth-engine.md), the open ends in [open-questions.md](open-questions.md). The
wrong turns:

- **"Evaluated at both ends" read as "every parameter at both ends".** It was true of the pitch, the
  level, the LFO depths and the filter; the ADSRs and the key tracking take the start for both. The
  phrase came from the first loads read; only reading every load of `[rbp-0xaa4]` and `[rbp-0x9f0]`
  separated them. −19.5 dB and −42 dB were hiding behind it.
- **A guard that guessed an A/B from a value.** `keyTrack === 0 ? 0 : …` meant "the caller zeroed
  it"; on `robot`, whose key tracking is 0 at modulation 0 and 1 at full, it froze the term for the
  whole glide. An A/B travels as a flag (`morph.noKeyTrack`).
- **A harness that is wrong the same way the engine can be.** The scene builder set every clip's
  length to `0x7fffffff`, so a finished clip held its row for the whole song and the module went
  silent at `Vision`'s step 48 — which read as our renderer playing notes the game drops. A
  harness is a model of the engine too; every field it invents is a claim.
- **A harness's order is a claim too, and agreement cannot test it.** The scene builder laid the
  clip headers out in the file's order, the render's row scan used the same order, and on 179190
  the two agreed to −84.5 dB that row 8 drops from step 128 — so the drop went into
  [synth-engine.md](synth-engine.md) as measured. The eboot sorts the headers by column and row
  before the module sees them (*Which clips spawn* there); sorted, 179190's row 8 plays, and so do
  726268's rows 9 and 10 from bar 109, which a listener reported missing. ⚠️ A differential test
  only checks what differs between its sides; whatever the harness hands **both**, it confirms.
- **A window error measured against its own power.** It put a −90 dB tail that ends a block apart
  at the top of the list as "−0.2 dB". The comparison reads the worst window against the loudest.
- **Song comparisons on the tracker's clock.** With onsets on their own frame every song differed
  from the module by more than its own level, and nothing past the first off-grid note could be
  judged; the engine's clock (*3 / 3b*, above) is what makes a song comparable at all.
- **Rounding the control points' frames looked like the glide's −27 dB.** It was 0.45 of a frame
  and real, but the cause was the walk-anchored slide; comparing the voice's positions chunk by
  chunk against the record's `+0x40` is what told the two apart.
- **The two worst songs were blamed on the clock's split chunks and on sub-steps.** 281831 is at
  240 bpm and `Vision` has sub-step records, so both looked like timing. The error's shape said
  otherwise: 281831's grew 6 dB per doubling of time from the first frame, which is a rate held
  slightly wrong, not a moment misplaced. Every layer's `+0x40 + 8i` against ours, chunk by chunk
  (`POSV=` prints all five), found the held notes 0.0056 frames ahead after four seconds and
  `Vision`'s glides 0.05 frames ahead after one step — float32 against double, both.
- **Rounding the double rate to float32 at the end looked like the float32 rate.** It moved
  `pulse_wave` 10 dB and `mosquito` not at all: the module rounds `exp2f`'s result and the detune
  before their product, and its rate sits one ulp below the float32 nearest ours. Only the whole
  chain in the module's order lands on its positions.
- **A slide's `t` taken from frames looked exact.** It is linear in the playhead and the playhead
  is linear in frames inside a chunk — but the module's playhead is a float32 that advances by
  `f(p + N/L)`, not by `N/L`, and `t` is its fraction. 2e-6 steps apart, on a 24-semitone glide.
- **A clamp that changes nothing inside 0..1.** `Voice` clamped the cutoff before squaring it, the
  module only after; no test could tell while the modulation stayed in range. Reproducing the
  walk's overshoot past modulation 1 is what made it audible: −11.7 dB on `saw_wave`.
- **"What the player stops at" read as a stop.** The slot table said it of `+0x78`, and `Voice`
  stopped every layer and the ladder at layer 0's last frame. `0x3035` is a test run once the
  chunk is out, and the chunk plays whole: a filtered kit's ladder rang on past our end, −63 dB of
  the loudest window, and nine of the battery's ten worst scenes, kits and one-shots, sat at
  −61 … −78 dB for it. The numbers since are in *The voice pool* in
  [synth-engine.md](synth-engine.md); 24870 and 271798 above moved with them.
- **A residue that rode on the resonance was blamed on the ladder.** `woodpecker` at −77.9 dB,
  the `gover` scenes at −57 … −72, all of them −104 … −106 with `Params[4]` zeroed on both sides —
  and the ladder ran in double where the module's runs in float32. Transcribed in float32, the
  ladder moved them; put back in double one part at a time, it changed nothing above −107 dB. The
  ramp's float32 add was the whole of `woodpecker`, and envelope B and the chunk's two ends most of
  the rest (*The filter* in [synth-engine.md](synth-engine.md)): a resonant ladder turns a cutoff
  wrong by a part in 10⁵ into a phase drift of its ringing, so zeroing the resonance silenced every
  error upstream of the cutoff along with the ladder's own. ⚠️ Zeroing a gain inside a loop
  removes everything that feeds the loop; take the inputs back to double one at a time before
  naming the loop. 24870 and 15855 above moved with it.

## 45. Where the ladder sits — one pair per record, after the sum and a clip

**Answer**: the per-sample loop accumulates every layer, post-gain and post-pan, into one
interleaved L/R buffer; `0x2e00`–`0x2e2d` clamps it to ±1; the two ladders run on its L and R —
[synth-engine.md](synth-engine.md). `Voice.renderSegment`.

❌ **The answer was in the record layout for a week.** The ten state floats at `+0xa4`..`+0xc8`
had been named "two ladders, one per channel" since the filter was read, and the mixer still ran a
ladder pair per *layer*, before the gain and the pan, because each layer was its own voice. For a
linear filter that is the same thing; for one with a cube in its loop it is not, on the 13 shipped
instruments that are both stacked and filtered (`choir`, `brass`, `synth_strings`, `ghost`,
`e_guitar_power`, `space_piano`, `mime_artist`, `mosquito`, `noise`, `electric_piano`, `ray_gun`,
`record_static`, `woodpecker`). The clip before it was never seen because nobody read past the pan
law to where the layer loop ends. ⚠️ When a state count and an implementation's count disagree,
the implementation is wrong, not the count — and "one per channel" means *after* the pan.

## 43. The 44.1 kHz samples, and the loop the loader really plays

**Answer**: the eboot's sample loader `v0xb3e520` reads `nChannels` out of `fmt ` and nothing
else, never resamples, fills the slot's loop from `smpl` as written (`[dwStart, dwEnd + 1)`), and
copies the loop's first 16 frames past its end — *The loader* in [synth-engine.md](synth-engine.md).
So the 42 shipped `.smp` at 44.1 kHz play +1.47 semitones in the game, and every loop joins
literally. `render.ts` dropped its `sampleRate / RATE`, `loopRegion()` returns the loader's
region and `engineSample()` applies the patch (2026-09-08).

❌ **A measurement of the files was taken for a measurement of the engine.** `loopRegion()`'s
`[dwStart − 1, dwEnd + 1)` came from asking which join was smoothest across the corpus, and it
was smoothest — 0.59× an adjacent step against 3.28× for the literal reading — and steering
recorded "the engine agrees from the other direction" because the plugin's region is half-open
too. Half-open said nothing about where the start is; the loader did, and it was three
`RIFF`/`smpl` immediates away from being found (`grep` the eboot for the tag bytes; the string
copies at `v0xefbd1e` are FMOD's codecs and lead nowhere). ⚠️ Smoothness is a property of the
file; fidelity is a property of the loader. The two agreed only by luck, and here they did not.
⚠️ The same loader was the answer to the sample-rate question that sat as *43* in
open-questions for a day: "the slot has no rate field" was already the whole argument, and the
reading only confirmed it.

## 3 / 3b. Grid resolution, swing, triplets and the block clock

**Answer**: `gridX = floor(2x/105 − 0.5)`, 16 steps per cell (measured twice), `720000/tempo`
frames per step (four to the beat), swing `±swing/2` on alternate steps, positions in thirds, the
engine's block a fixed 256 frames, and note onsets on that block —
[synth-engine.md](synth-engine.md), [cwlib's sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md).

⚠️ **`MORPH_FRAMES` was 128 — the AudioWorklet's render quantum, not the engine's block.** Moving it
to 256 was worth −50.6 dB of difference over 30 s of `Zero` at an unchanged RMS, and forced the grid
from "the offset within this call" to a mixer-wide frame clock, because 256 no longer divides a
live render's call. Advancing the oscillators per call stepped them twice as often as an offline
render and broke the equality outright — the first thing to fail. ⚠️ **The `frac(4·position)`
bound is not a musical boundary and reading it as one wastes an hour.** ✔ The `1/3` sub-step and
the swing interact exactly as `swungFrame` assumed: `floor(position)` cannot change inside a step,
so a triplet inside a stretched step stretches with it.

✔ **And the onsets on the block are reproduced, by default, since 2026-10-12.** The reading was
confirmed by running the module (*The clock* in [synth-engine.md](synth-engine.md)) and the owner
chose the engine's clock over onsets on their own frame, for the render and the live player
alike; the tracker's clock stays one switch away (`RenderOptions.engineClock: false`). It was a
deviation (*3*) from 2026-09-08: decided against the block grid while the grid's song alignment
was an inference, and kept once it no longer was, until the owner chose.

## 30. `durationSteps` — verified against the engine's gate

**Answer**: the gate closes at `lastStep + 1 + endSubStep/3`, exactly `endPosition − startPosition
+ 1` with sub-steps as thirds — [synth-engine.md](synth-engine.md). And `subStep = bit7 << bit30`
is confirmed from the playback side (`0x3aa5`–`0x3ab0`), not just the editor's write path.

❌ **The other candidate must not be implemented as it stands.** The engine skips allocating a
record when a volume is not positive (`0x04d4`); read as "the note's opening volume" that would
delete `C4K3 S0NG`'s 701 fade-in notes — real music this project already rendered as silence
once. It tests `channelVolume × clip Level` (*31*), and never fires on real data.

## 31. The note word's bits 28..29 — the game throws them away

**Answer**: the eboot's clip filler clears them (`0xcfffffff`), so the plugin's `clip + 0x420 +
20·sel` always reads row 0, which is `PInstrument`'s `Level`, `Pan`, `EchoSend` and `ReverbSend`
field for field — [sequencer-engine-inputs.md](sequencer-engine-inputs.md). The corpus sets those bits
on 52% of records in sticky runs across 94% of clips, which looked like four instruments per clip
and a hole in the one-instrument `Track`. It is editor state, the same shape as bit 30's resting
value: **two of the note word's fields are written by the editor and ignored by the engine, and
both were nearly read as meaningful.**

⚠️ The function also has an inverting branch (`(95 − y) & 0x7f`) for a caller-supplied note array.
Its single caller passes `rdx = 0`, so the file's `y` reaches the plugin unchanged; a reading that
took the inverting loop for *the* note copy would have called the stored field a y-coordinate the
engine flips, and pitch-probe's median-0 corpus says it is not.

## 32. The release ramp — identical to ours

**Answer**: `level −= dt / release²`, linear, clamped at zero, with the level mirrored around 1 —
`Envelope.advance` with `evaluateAdsr` squaring and `ENVELOPE_SECONDS_PER_UNIT = 4` absorbing the
engine's `dt` unit — [synth-engine.md](synth-engine.md). So the moment a voice falls silent is the
same in both, and there is no shorter tail hiding in the envelope.

⚠️ The first measurement of that tail got one thing wrong: the time to zero is `release × (the
level the envelope had reached)`, not `release`. Recomputed with the level at gate close, the tail
takes `C4K3 S0NG`'s stealing to 22.3%, not the 29.5% first reported — the size of the gap, not its
existence.

## 13. The voice pool — 32 voices, steal the quietest

**Answer**: `0x1600`–`0x1692`: the first free record wins immediately, else the lowest
`[+0x04] × [+0x0c]`, with the running best starting at **1.0** and the best index at **0** —
[synth-engine.md](synth-engine.md). `polyphony.ts` reproduces the 1.0 rather than tidying it, and a
test pins it.

⚠️ **It fixed nothing audible, and that is the point of recording it.** The cap went in while
chasing "the aggressive synth with long notes is too loud at 1:30": on that window it cuts 248 of
1,684 notes and moves overall RMS 0.1324 → 0.1304, and **a listener compared the two renders and
heard no difference**. The cap stays because it is the engine's, not because it solved anything;
the report itself was a listener's impression of one passage, never reproduced, and was retired.

⚠️ **A near-miss that nearly cost a whole file.** Writing this entry truncated `open-questions.md`
to zero bytes, and the truncation was committed: `io.open(path, 'w')` empties the file before
anything is written, and a `UnicodeEncodeError` part-way through the string — an unpaired
surrogate — left nothing behind. Recovered with `git show <commit>^:steering/open-questions.md`.
**Write to a temporary file and move it into place, or write the text with the Write tool.**

## 17 / 17b. What a voice occupies in the pool — the sound, and one record per note

**Answer**: a one-shot holds its record for `sampleFrames / playbackRate` output frames, not for
its written note; a stolen voice has to actually stop (`VoiceSpec.cutFrame` is the allocator's,
separate from the gate's `endFrame`); and **a stacked note takes ONE record however many layers it
plays** — the per-layer loop is inside the per-record renderer — [synth-engine.md](synth-engine.md).

The accounting bug, measured on `Ascetic` (1,150 tracks, 14,499 notes): 352 notes in the first 24
seconds meant **1,760 simultaneous voices** in a 32-voice pool with the allocator reporting nothing
stolen, because `mime_artist` — five layers, loopless, 68 semitones below its base note — was
declared as "two steps" and was really five voices for 9.5 seconds. Render cost per second of
audio went 0.155, 0.408, 0.620 before (rising with the square of the length, "estremamente lento")
and 0.080, 0.123, 0.124 after. **When a cap exists to reproduce the engine's behaviour, check that
it is being told the truth before concluding the engine is generous**: "0 of 934 notes cut short"
on a passage with 1,760 sounding voices was an accusation against the accounting.

❌ **"`Numstack` layers are `Numstack` voices" was asserted with no address.** One record per note
takes `C4K3 S0NG` from 3,634 notes cut short (28%) to 1,526 (12%); a listener had heard it first
("molte voci vengono troncate, nell'originale non sento così tante note troncate"), with both of
their guesses the right shape. ⚠️ **It costs CPU to be right**: the live load went from 11–26%
back to 23–60% of a core, and the LFO fix paid for it and no more. ❌ The page used to turn the
"voices sounding" number red past the pool size, captioned "something is not respecting it";
nothing was — a stacked note plays up to five sampler voices from one record, a one-shot outlives
its gate, a release rings on — and dressing a right number as a fault teaches a listener to
distrust it. The meter shows **notes** now, red at ⅞ of the pool, and reads high on purpose:
measured over `C4K3 S0NG`'s first 60 s the warning lights with slots to spare in 12.8% of blocks,
because the pool gives a record back at the gate while the voice keeps its tag until it has
finished ringing.

## 33. Is the pool really 32, and really per sequencer? — yes to both

**Answer**: `(0x1a28 − 0x28) / 0xd0 = 32` is an immediate in the PS4 binary; one state block is one
whole sequencer; the allocator has no sub-pools — [synth-engine.md](synth-engine.md). Asked after a
listener heard too much stealing: *"are we sure the PS4 limit is not higher, or that it is not
applied to something narrower than the whole sequencer?"* Whether the eboot keeps more than one
state block does not matter: the game walks every `MusicSequencer` Thing when one begins, and even
if two could sound, neither would get more than 32.

## 29. Does a releasing voice still hold its record? — yes, and what ships is a decision

**Answer**: the engine frees a record when the envelope reaches zero at both ends of the block, or
an unlooped sample runs out, or a score factor is zero — every link re-derived from the binary and
holding — and `RenderOptions.releaseTail` defaults **off** anyway, for the reason and with the
measurements in *29* in [open-questions.md](open-questions.md).

The wrong turns are the useful part:

- ❌ **`[+0x14]` looked like the reconciliation and is dead code.** The allocator's fast path takes
  a record whose `+0x14 > 0` before asking whether it is free, but both callers pass `dil = 0`. The
  field is a plain marker written as 10000 when the record is claimed; ⚠️ "nothing reads it again"
  was then also wrong — `0x394d` tests it to release a record whose `+0x14` is zero when a state
  flag is clear, which changes no number on a claimed record but would have made the next reader
  wonder what else the note had missed.
- ❌ **"The steal sounds different in the game" — refuted.** `0x19e0` zeroes the whole record on
  takeover; the stolen voice stops instantly. A fade would be an invention.
- ❌ **"We schedule notes the engine would not."** The skip at `0x04d4` tests `channelVolume × clip
  Level`, not velocity (*31*); it never fires on real data.
- ❗ **The score follows the note's volume automation, walk by walk** — `[+0x0c]` is rewritten at
  every step from the current control point — and a note fading out becomes the cheapest thing in
  the pool. `allocateVoices` scored a note once, at its opening velocity, until 2026-10-11, and
  with the tail on stole the wrong notes on the `C4K3 S0NG` bar of *29* in
  [open-questions.md](open-questions.md); the reading, and what the per-walk score measures against
  the module there and on three more songs, are in *The voice pool* in
  [synth-engine.md](synth-engine.md).
- ❌ **"The score decides WHICH notes are stolen, never HOW MANY."** Written here before the
  per-walk score existed, from a proxy (every note scored by the quietest point it ever reaches:
  1,494 steals against 1,411) and the inference that occupancy alone sets the count. It does not:
  a steal takes back only what the victim had left, so stealing a note about to end leaves the
  pool fuller afterwards than stealing a long one. The per-walk score moves `C4K3 S0NG`'s count on
  the tracker's clock from 701 to 805 with the tail off and from 1,672 to 1,957 with it on. The
  clip's `Level` is in the score for correctness all the same.
- ✔ **The baseline is not ours — it is the song.** Counted straight off the records, `C4K3 S0NG`
  wants more than 32 records 21.0% of the time; the renderer asks for 16.0%. Three ways it could
  have been our fault were checked and all are clean: all 244 tracks are distinct; 0 of 13,091
  notes are one-shots, so the overhang is 0; and `duration` disagreeing with `endPosition −
  startPosition + 1` on 1,057 notes is the triplet population (whole steps versus thirds).
- ✔ **One thing came out unconditional**: a voice whose unlooped sample runs out gives its record
  back (`0x3035`–`0x3065`), and it was missing. A drum whose sample lasts 0.2 s no longer holds a
  record for its 1 s release: 1,411 cuts → 1,318.
- ⚠️ **Our own two halves disagree**: the mixer keeps a voice alive through its release
  (`env.finished` ends it); the pool frees the record at the note's written end. The pool is the
  optimistic one, and it is the half that matches the ear.

## 10. One-shots — the engine gates every voice

**Answer**: the envelope's gate argument is `voice[+0x10] == 0` with no branch on the loop or the
slot (`0x1f65`–`0x203f`), and `0x3035` is an *additional* stop for a loopless voice, not an
exemption — [synth-engine.md](synth-engine.md). Settled against a recording of `Ascetic`'s two
kits: envelope correlation with the game in eight two-second blocks favours `gate` over `full` and
`natural` in **eight of eight** (0.8368 vs 0.8237 in the first), and the per-hit decay error is
34.1 ms against 39.2. ✔ The capture was shadPS4's and the conclusion survives it: it rests on a
shape and on the code.

⚠️ **The old evidence was not wrong; it was about a different bug.** A listener reported the drums
as clipped and far too quiet, and the arithmetic backed them (`baiyon_drums_1`'s release is three
milliseconds) — but those renders were playing `baiyon_drums_1` with `a_kit_1`'s kick, because two
sample GUIDs had collided on one filename ([game-assets.md](game-assets.md)). With the right kick
the drums stopped sounding wrong and the rule invented to compensate stopped being needed. **A fix
that compensates for a symptom will survive the symptom's real cause being found, and go on
quietly making everything else wrong.** `options.oneShot` still offers `full` and `natural`
(`LBP_ONESHOT`), because the difference is small enough that only a measurement separates them.

## 15. `robot` sounds thin — withdrawn by the listener, and NOT attributed

**Answer**: on 2026-09-05 the listener says the lead synth in `This Is Halloween` now sounds right.
Nothing here claims to know why, and the refusal is measured rather than modest.

Exactly one systematic change of that session reaches `robot` (`Numstack` 1, modulation 0, key
tracking 0): the block clock, 128 → 256, credible on its face because `robot` takes 98% of its
cutoff from a filter envelope re-derived per block. ⚠️ **And the control says that is not enough to
conclude anything**: everything random in a voice comes from one seeded stream, and the session
reordered the draws. On `robot` alone over 25 s of `Ascetic`, the block clock is worth **−33.0 dB**
of difference and a reseed **−4.6 dB** — a reseed is 28 dB *larger*. **A difference smaller than a
reseed is a difference a reshuffle could have produced**; `LBP_SEED` exists for exactly this, and
the original reference was shadPS4, which the same day's evidence rule disqualified for spectrum.
Ruled out on the way, off the file rather than off a capture: the octave (49,447 notes from −12 to
+30 semitones with a fat middle at +26 — composers use it as a lead), `Key` (0 on 49,270 of them),
a hidden per-note flag (byte 3 only ever holds `0x00`, `0x40` or a low nibble), the interpolation
direction (*20*), and the resonance (every one of its records carries timbre 0).

## 2 / 2b. The echo — a stereo delay, `EchoTime` in beats, and a hard clip

**Answer**: inside `fmodextinput.prx`, a 192,000-float interleaved ring, delay `EchoTime` beats
exactly, feedback clamped to 0.95, wet added to all four lanes (so the echo feeds the reverb),
output hard-clipped to ±1 — [synth-engine.md](synth-engine.md).

❌ **Three wrong readings, each of which looked settled.** First `EchoTime × 0.5` **seconds** —
tempo-independent, which cannot be right in a tempo-locked sequencer. Then **beats**, argued from
the corpus's detents (2.00 on 189 of 338 sequencers, 1.00 on 95, 1.50 on 47 — but two beats, two
bars and half a bar are all musical detents), which was the right answer for the wrong reason and
was then "corrected" away. Then **eight steps per unit**, read off `stored * 16` at `0x0f74`, a
factor of two out. The decisive number was the clamp: 192,000 is the ring's *float* count, not its
frame count. `stored * 16` is a length, and a length means nothing until you know what it counts.
⚠️ The damping and ping-pong in the kernel are unreachable — nothing in the eboot writes the two
fields — so do not "find" a filter in that loop later and wire it up.

## 9. Board row → mixer channel — bands

**Answer**: the board is cut into `NumChannels` horizontal bands and a placement's channel is the
band its row falls in; `circuitBoardSizeY` is the datum, and it was being read and thrown away —
[cwlib's sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md).

❌ **Two wrong readings, both reasonable.** `gridY` as a direct index — killed by the corpus, 88% of
tracks have a `gridY` outside `0..NumChannels−1`. Then `gridY % NumChannels` — it put every row in
range by construction, a listener had already corrected an earlier `% 8`, and it shipped for two
months; it wraps where the game bands, re-routing 667 of 1,821 tracks on the ten multi-channel
sequencers. ⚠️ **No amount of corpus work could have settled it** (308 of 338 sequencers run one
channel, where every rule agrees); it took the writer, found with the method this question had
carried for three days — byte-scan for `E8` displacements landing on a known callee, search
backwards for the caller's `55 48 89 e5`, disassemble from **there**.

---

# The chain

## 6 / 14. The reverb — the whole of `fmodsmsreverb.prx`

**Answer**: a mono downmix into a damped one-pole and a notch, `tapCount − 2` mono combs plus two
stereo comb pairs summed raw, an output delay, three panned early taps, 100% wet; slots, flow,
kernels and write-back in [lbp-audio-engine.md](lbp-audio-engine.md). Neither of the two
candidates the project spent four sessions choosing between — FMOD's `SFXREVERB` and Sony's
`aSfxDsp` — was the answer; the plugin was in a file next to the eboot that nobody had opened.

**The wrong readings, and what produced each** — every one looked reasonable:

| the claim | why it was believed | what it actually is |
|---|---|---|
| a Schroeder **allpass cascade** after the combs, 0.5 coefficient | the kernel at `0x0960` subtracts its own output from the signal, the shape of an allpass | with `a = 2r·cos(w)` and `c = −r²` the recursion is a **resonator**, so `x − y` is a **notch** — on the **input**, not the output |
| slot 8 is a **pre-delay in samples** | it is small, and reverbs have pre-delays | the **notch frequency in hertz**; the real delay is slot 6, in ms, and it sits **after** the combs |
| slot 1 the early level, slot 2 the late | both are millibel levels | slot 1 is **late**, slot 2 **early**; getting it backwards also moved the `/100` onto the tail, which silenced it |
| the early rows' columns 6-8 are gains, 3-5 "are not levels" | 46, −60 and 21 are absurd as gains | 3-5 **are** the gains — they multiply an early level of order 0.003 because of the `/100`; 6-8 are pan positions |
| each comb needs a `1 − gain` normalisation | eight feedback combs summed are ~9× unity at DC | the kernel sums the raw delay outputs with **nothing** between; the level is `lateLevel`, read off the wrong slot |
| `reverbSend` multiplies `Params[25]` | a `vmulss` sits next to the send's clamp | that multiply is on the **echo** path, the negative branch of the bipolar offset; the reverb send is the placement's field alone |
| a configure costs the next block of late field | run, an impulse in the block after a configure lost its comb arrivals and kept its early ones | that configure was the **first**: a comb reads silence until its ring has been written once round, a count only the geometry build zeroes (`[rec+0x14]`, `0x0f19`); a later configure touches no ring and zeroes only the input one-pole's and the notch's state. Feed a module's first block before reading anything as per-configure |

And two process errors: the renderer called `process()` twice per frame, once per channel, through
one instance, so every delay line ran at twice the frame rate with both channels sharing one state
(`Reverb.process` is stereo now); and a scan for the level fields was run against the **wrong PRX**
(`fmodextinput`) and concluded "the PRX never reads them", sending the search after an imaginary
output matrix in the eboot. ✔ The last unknown — what gain the eboot puts on the connection into
the reverb and back to the master — closed with *22*: there is no connection and no gain, the two
DSPs share one 4-channel buffer.

## 37. The WaveHammer — answered by RUNNING it, after three wrong readings

**Answer**: a compressor at −18 dB / 10:1 over a 64-sample sliding mean square, limiter bypassed,
configured by a static template; −17.2 dB of gain at −0.9 dBFS, −7.2 at −12, a floor of −1.84 dB
below −21 dBFS — [lbp-audio-engine.md](lbp-audio-engine.md), `tools/wavehammer.py` and
`tools/runhammer.py` agreeing to 1e-4 dB.

❗ **The value of this entry is the three wrong readings, two of them committed:**

| # | the claim | why it was believed | what was true |
|---|---|---|---|
| 1 | "It is a limiter." | the product is called Wave Hammer | it ships with `LimitBypass = 1`; the **compressor** section runs |
| 2 | "The game never configures it." | `DSP::setParameter` is never called on the handle — all fifteen call sites enumerated | true, and irrelevant: `create` `rep movsd`s a static template over the parameter block |
| 3 | "It collapses to a constant −18.04 dB." | a **superset disassembly** of all 7,632 bytes found no store to `[reg + 0xc0]`, so the window length looked uninitialised | `[state+0xc0] = 64`; `0x380` writes it as `mov qword ptr [rbx + 0x3c], rax` through an interior pointer to `state+0x84`, two fields in one store |

Reading 3 is the one to remember: the technique was **sound and exhaustive** and the conclusion
still false. Decoding from every byte proves "no instruction stores to `[reg+0xc0]`"; it does not
prove "this field is never written". One wrong field produced **four** self-consistent
conclusions — the constant, a `NaN` at table entry 0, a downward expander below the knee, and "the
compressor never compresses" — none of which looked wrong from inside the disassembler, and all
of which died the moment the module printed its own state. What survived every correction was
everything derived from the *arithmetic* rather than the state: the struct layout, the units, the
knee's closed form. Two more things only the running module's vectors caught: the second
smoother's seed and the `f32`-versus-`f64` misprint of `a1`.

❌ **And a fourth, run in series (2026-10-11): float32 is all or nothing.** The model rested
0.001 dB off the module for good because the module is float32 throughout; with the envelope alone
in float32 it was closer, and plugging in the module's own dumped table on top made it *worse*,
because the constants beside it were still the double formulas rounded — each one ulp off. Only
with every stage and every constant in float32 did the table close it to bit-exact. Half a fix is
not evidence against the other half (*And it was run* in [lbp-audio-engine.md](lbp-audio-engine.md)).

## 22. The stereo width — the game narrows every pan to `2 − √2`

**Answer**: predicted from two interior points, measured at both extremes to six figures, and then
*derived* from three read constants — the plugin's linear pan, FMOD's `k = 0.5` centre feed at
`v0xa2599f`, BS.775's `1/√2` — [lbp-audio-engine.md](lbp-audio-engine.md). Open since a listener
said *"sembra che lbp non abbia mai un hard panning"*.

⚠️ **Within the affine family every form predicts the same ratio everywhere**, so no amount of
listening at interior pans separates width from mono-add from cross-bleed; only the extremes
separate the family from constant power (0.2612 against 0.198). ⚠️ The asymmetric alternative —
FMOD mapping the four channels straight into FL, FR, FC, LFE, which would give 0.2612 at pan 0
and **0** at pan 1 — is refuted by the captures themselves.

❌ **A session was spent enumerating vtables by shape** — runs of consecutive relocation slots
holding code addresses, filtered on plausibility — and produced five wrong candidates plus a near
miss (`v0xa287b0`, `DSP::setDefaults`) convincing enough to write up. The binary has RTTI and 322
vtables can be named in a third of a second ([eboot-re.md](eboot-re.md), `tools/ebvtable.py`).

❌ **"Width, not gain" for two days — half of a linear operator.** The captures are level-matched
and say nothing about absolute level, which was the right reason to be careful; but the fold is
read, and it fixes the level whether or not a capture can confirm it: narrowing without the
`(1 + 2kd)` gain is a uniform **−4.645 dB** at every pan. ❗ **And the first attempt made the gain
`1 / panWidth` instead of a constant** — defensible physics, and it turned the live page's width
slider into a volume control, +20 dB at 0.1. **A parameter that is a diagnostic must vary one
thing.** ⚠️ **A normalising renderer hid the missing gain for two days**: every offline check came
out at full scale, and it took a listener on the live page, which does not normalise, to say "the
whole sequencer is quiet". ⚠️ And `panWidth` existed for a day as "a DIAGNOSTIC, not a setting"
with a note that 0.58 reproduced the recording but must not be promoted until a mechanism was
found: a transfer function measured on the game's own output at four operating points **is**
evidence in its own right, and the renderer hard-panned a day longer than the evidence justified.

## 39. The stereo fold — the gain moved to where the game applies it

**Answer**: the fold runs after the plugin's clip, the reverb and the compressor, where FMOD's
speaker matrix applies it, and since 0.2.43 the game's master bus runs all of it, gain and
narrowing — [lbp-audio-engine.md](lbp-audio-engine.md), *The game's master bus*. From 2026-09-06
to 2026-10-11 the narrowing was left out on a listening judgement, the gain alone kept; that chain
is `'none'` now, and ours keeps the same image (*42* in [open-questions.md](open-questions.md)).

⚠️ **Narrow the bus, not the voice.** The note this entry once left — "the other half is one line
at the `pan:` field" — would have put the narrowed image in front of the plugin's clip and the
WaveHammer's detector, which in the game see the internal one. The fold is a matrix on the sum
after both (`FOLD_CENTRE`, `master-stage.ts`).

❗ **The old placement was a real bug, not a tidiness point.** Folded into each voice, the gain put
`clipToUnit` 4.645 dB hotter than the game's clip ever sees, so it engaged on material the game
passes untouched: on `level-seq732985` (20 s) the clip touched 0.05% of frames before and 0.00%
after, with the peak 1.046 (clipped) → 1.385. The echo, inside the same plugin, was equally
over-driven. ⚠️ And the count under-reported: the plugin clips all four lanes and `clippedFrames`
watched only the dry two. This also retired the biggest lead on *38*.

## 23. The ~1 dB deficit above 315 Hz — withdrawn, and NOT attributed

**Answer**: raised from a dry capture, parked when the listener said the reference was shadPS4,
withdrawn on 2026-09-06. Nothing replaced it: its evidence was never admissible — a per-band
decibel table is the kind of finding an emulator's output path manufactures — not because it was
explained.

The numbers as taken, kept so a capture from real hardware has something to compare against:

| band | ours − game |
|---|---|
| 20-40 Hz | −0.39 dB |
| 40-80 | −0.54 |
| 80-160 | **+0.27** |
| 160-315 | **+0.07** |
| 315-630 | **−1.43** |
| 630-1250 | −0.99 |
| 1250-2500 | −0.89 |
| 2500-5000 | −0.75 |
| 5000-10000 | −0.79 |
| 10000-20000 | −1.41 |

The bass was exact and everything from 315 Hz up quiet by roughly a decibel — suspiciously *flat*
for a filter, which always argued for something gain-like; the largest gain-like thing in the
renderer was `FOLD_GAIN`, now *39*'s.

---

# The page and the live player

## 55. "The audio % looks too low" — it read the clock's phase, not the work

**Answer**: the meter summed `Date.now()` around each `process()`, a 1 ms clock against
sub-millisecond bursts that Chrome starts on an exact 10 ms beat, so the reading followed where the
callback fell inside the millisecond — five times under the truth for half a minute, measured.
`LoadMeter` dithers one callback in ten with a random wait and averages those samples; the
measurements and the design are in *The "audio %" figure* in
[tracker-architecture.md](tracker-architecture.md).

The wrong turns:

- ❌ **"Summed over ~37 blocks it comes out right on average, because a block's start has no
  relationship to the millisecond tick."** That was the comment on the old meter, and the premise
  is false: the device callback is periodic at a whole number of milliseconds. Averaging cancels
  quantisation error only when the phase is random, and "random" has to be checked, not assumed.
- ❌ **"~0.3% on the Arrange view against 6-8% idle is the CPU clocking up."** Recorded 2026-09-07
  as honest physics. Clocking explains a factor of two or three (`Rotary`: 4.5% hot in Node,
  about 10% live); a factor of twenty was mostly the phase.
- ❌ **"Every 16th callback"** for the dither: Chrome's callbacks cycle 4, 4, 4, 3 quanta, so the
  stride hit the short one every time and read 80% of the load. Sample at random.

⚠️ **The trap to keep**: before averaging a quantised measurement, look at when it is taken. A
clock read at a fixed point of a periodic process is not dithered by anything.

## 56. "The audio % is still low" — it was right, and the CPU was the board

**Answer**: after *55* the meter read 5–10% on `Rotary` and Windows' own count of the audio
thread said 11.6%: the engine is light, and the gap is the browser's share of that thread
(*The "audio %" figure* in [tracker-architecture.md](tracker-architecture.md)). What made the
machine work was the **main** thread, 45–64% of a core while playing, nearly all of it the board
redrawing every chip every frame, even behind another view — fixed in `board.ts`, measured in
*The two canvases* in [editor.md](editor.md).

⚠️ **The trap to keep**: a meter that looks too low may be right about what it measures. Before
changing it, measure the whole process from outside — per-thread CPU times cost a minute and
named the thread that was actually busy.

## 57. "Is the load readout right now?" — it was blind exactly where it mattered

**Answer**: not until it was tried at the one condition it exists to report. With the thread
overloaded on purpose — a spin in our own `process()` — the figure fell to 8% in the plain colour
while 688 ms of every 5 s went missing, and the dropout count stayed at zero. Both were rebuilt and
are now checked against `getOutputTimestamp()`, which is the device's own word on what it played:
*The "audio %" figure* in [tracker-architecture.md](tracker-architecture.md).

The wrong turns:

- ❌ **"`currentFrame` jumps when blocks are skipped; this is the metric that is exact here."**
  That was the comment, and nothing had ever made it fire. Chrome skips nothing: it renders late,
  plays silence, and the audio comes out later from then on.
- ❌ **Counting a burst when it closes, and taking the samples' mean as the load.** An overloaded
  thread never closes a burst and produces no samples, so the reading decayed towards zero.
- ❌ **Measuring sound lost from inside the worklet**, as the lag of `currentFrame` behind
  `Date.now()` — at the end of each quantum it rose with the load, at the start of each burst with
  callbacks late but in time. Both counted losses the output never had.
- ❌ **"5 ms from one reading to the next"** as a loss: a thread just past 100% loses less than that
  per reading, and most of it went uncounted.
- ❌ **A spin in a separate node as the overload test.** It split our bursts at its own gaps and
  read low for a reason the app cannot have; the spin had to be inside our `process()`.

⚠️ **The trap to keep**: test an alarm by making happen what it alarms about. Every number in the
readout had been checked at the loads where nothing goes wrong, and none at the load where it does.

## 34. The live scheduler's −57 dB — it was the simulator

**Answer**: the scheduled path is bit-identical to the direct render; the −56.8 dB on `C4K3 S0NG`
and −59.1 dB on `Ascetic` were `live-sim.ts` rendering `TICK × RATE` = 4,800 frames per call where
the worklet renders 128 — 37.5 modulation chunks, so every other burst cut a chunk in half. Proved
before it was fixed: `LBP_TICK=0.08` (3,840 frames, exactly 30 chunks) went to −Infinity dB with
nothing else changed.

⚠️ **Rendering 128 frames at a time was not by itself the fix, and that cost the extra hour**:
quanta restarted at each tick boundary are every one of them 64 frames off the grid (`4800 % 128 =
64`), and the figure did not move. The quanta have to run on the **stream's** grid with the posting
inside that loop — which is what the player does. ❌ **Two fixes to the mixer were made and
reverted**: the chunk grid as the stream's with the mixer counting frames rendered (−56.8 → −63.8
dB, `Ascetic` −59.1 → −89.7 — an improvement that was a different wrong answer), and refreshing the
morph once per grid chunk. **The mixer was never wrong**, and either could have been committed as
"the fix" with a 7 dB improvement to show for it. 128 is the one block size that hides this;
`LBP_SCAN_BLOCK` and `LBP_DIFF_BLOCK` take the size for that reason.
