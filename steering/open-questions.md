# Open questions — decisions, residues, and what would settle each

Read before planning a work session. Nothing here is a guess dressed up as a fact, and **nothing
here blocks the build**: the note format, the containers, the level walk, the asset chain and the
whole signal path are measured, and import, playback and export are built. What is left is three
*decisions* where the project knowingly departs from the measured engine — a master bus of our own
in the game's place among them — an AGC beside it, one question about what reaches the game's
compressor, a short list of measured
residues nothing models yet, whether the Ableton set opens in Live 12, how its Samplers sound, where its
swing groove puts the notes and whether Live's Delay is the engine's echo, and three
questions that are not about fidelity at all.
When one gets resolved, move the answer into the descriptive file it belongs to and delete the
entry. The questions about the files — the chip tint (*49*), the plan the game called too big
(*51*), and what still will not open (*28*) — are cwlib's, in
[cwlib's open-questions.md](../../cwlib-ts/steering/open-questions.md).

## The decisions — deliberate deviations from the measured engine

Each is a listening judgement by the project's owner that outranks a static reading, kept one
switch away so a capture can settle it. The evidence rule for captures is in
[project-brief.md](project-brief.md): a shadPS4 capture is trustworthy for *structure* — how many
voices sound, whether a note is gated — and not for absolute level or spectrum, so every experiment
below is framed as a structural one.

## 29. The release tail — `RenderOptions.releaseTail`, default **off**

The engine frees a voice record when the sound ends, not when the note does — measured six ways in
`fmodextinput.prx` (the free predicate at `0x20de`–`0x20f1` → `0x3093`, the sample-end free at
`0x3035`–`0x3069`, the score factors, the gate, a released voice skipping the score update; *29* in
[answered-questions.md](answered-questions.md)). The tracker frees it at the note's written end,
because with the tail on a listener rejects `C4K3 S0NG` at **25.85 s** — the choir starts a
five-note chord and four of the five are stolen the instant they start — and with it off accepts
the same passage.

What is measured about how wrong the decision can be, on that song's uncapped demand:

| | median | p95 | p99 | peak | over 32 |
|---|---|---|---|---|---|
| tail off | 21 | 42 | 51 | 61 | **16.0% of the song** |
| tail on | 25 | 48 | 56 | 75 | **28.7% of the song** |

The song writes more notes than the hardware can play whichever model is used — counted straight
off the records, 21% of it wants more than 32 — so the engine steals constantly and the ear does
not hear it; the tail roughly doubles the time over the cap, and in the 12.7% of the song that is
over the cap only because of it, more than half is one to four records over. A pool of 36, or a
tail 15% shorter, would erase most of the difference; neither is justified by anything measured.

⚠️ **Be ready for the answer to be uncomfortable.** With the tail the game plays at most 32 notes
at once; without it this renderer routinely runs 35 to 50. If the tail is right our render is
*denser* than the game's, which is exactly why it sounds less truncated. The version that sounds
better may be the wrong one.

**What would settle it**: capture `C4K3 S0NG` from the game around 25.85 s and listen for whether
the choir chord enters with five voices or one. Two seconds, no counting, and a shadPS4 capture is
admissible because the voice pool is the game's own plugin executing. `LBP_RELEASE_TAIL=1`.

**The plugin itself on that bar** (2026-10-11): `fmodextinput.prx` executing the song from step 0
with its pool empty, as a first pass starts (`prx-scene.ts … backup <save dir> 28` with `CLOCK=1`,
then `prxsynth.py` with `READ=256 VOICES=…`; the module and ours agree at −62 dB over the 25.8 s
before the chord, which is what says the scene is the song). Structure only:

- At the walk of step 224 the pool holds 18 records. 12 of them are the previous choir and string
  chords, whose notes end on that step and which keep their records through the release (the
  module frees them at steps 224.72 and 226.16). The walk spawns 18 notes into 14 free records,
  so it steals four.
- The chord (clip 81, written pitches 65, 62, 58, 53, 46 in clip order) claims records 26–30.
  `mime_artist`'s five notes come after it in the same walk. They take the last free record, then
  steal the four lowest scores: a fading `mime_artist` note on record 16 (written 115 → 9, scoring
  0.0266 at that walk where its claim scored 0.3396) and the chord's first three claims (0.0331
  each).
- **Two of the five sound, 53 and 46.** The other three are overwritten inside the walk and never
  render a frame: deleted from `scene.json`, the module's output stays the same to 1.2e-7.
- Ours, tail off, plays all five. After 25.8 s its whole difference from the module is those three
  notes: −12.8 dB of the module's level over 25.8–28 s, −62 dB once they are subtracted.
- Ours, tail on, plays the same two since the pool scores a held note at every walk (2026-10-11,
  the numbers in *The voice pool* in [synth-engine.md](synth-engine.md)). Scored at its opening
  velocity the fading note was dearer than the chord, so the fourth steal landed on the chord as
  well and ours played one.

So a capture of the game should hear two voices enter, not five and not one, and the render with
the tail on now plays two. ⚠️ The listening judgement at the top of this question was made on the
render that played one. The plugin says nothing about which render a listener should prefer; that
remains the decision above.

## 38. The compressor's input — is the crest factor reaching it the game's?

`SMS WaveHammer` is read end to end, checked against the module executing, implemented and pinned
to better than 2e-5 against vectors from that run ([lbp-audio-engine.md](lbp-audio-engine.md)).
**It runs by default since 0.2.43**, as the first half of the game's master bus. From 2026-09-06 it
was off, because the listener judged it wrong the first time it ran; on 2026-10-11 the owner asked
for the game's master bus by default instead, so the DSP is no longer the decision. What it is fed
still is: it costs `level-seq723339` 6.94 dB of RMS and 6.93 dB of peak.

❌ The first diagnosis — "our RMS sits 3.5 dB above its knee, so our level into the chain is too
hot" — was generalised from one song. Over four corpus sequencers against the knee bottom at
−21 dBFS:

| sequencer | notes | RMS dBFS | vs knee | peak dBFS | vs knee |
|---|---|---|---|---|---|
| 723339 | 821 | −16.4 | **+4.6** | −0.3 | +20.7 |
| 737099 | 280 | −29.3 | −8.3 | −13.8 | +7.2 |
| 732985 | 566 | −22.6 | −1.6 | +0.4 | +21.4 |
| 730116 | 765 | −22.4 | −1.4 | −2.0 | +19.0 |

Three of the four sit at or below the knee in RMS; **every song's peaks sit 7 to 21 dB above it**,
and the detector's window is 64 samples (1.33 ms) — far too short to follow an RMS. So the
compressor is riding peaks, and the question is **crest factor**, not loudness: either the game's
own mixes are as peaky as ours and its WaveHammer takes the same 7 dB off the dense songs, or ours
are peakier — through the pool, the envelope, the onset grid or the missing release tail — and the
compressor is fed transients the game never sends it. ❌ The `FOLD_GAIN` lead is retired: the gain
now runs after the compressor, where FMOD applies it (*39*), so the compressor sees the same signal
the game's does, and the one song it had "explained" was a coincidence (the other three land 6 to
13 dB below the knee).

**What would settle it**: a capture with a known reference beside it, so the *ratio* is admissible;
and, cheaper and needing no console, our own render at −0, −6 and −12 dB fed through the real DSP
with `tools/runhammer.py`, to see how much gain reduction each trim provokes. `LBP_MASTER=none` (or
`master: 'none'`) renders the chain without it, for the A/B.

## 42. Our master bus — the page's default since 2026-10-12

The master bus is a choice between four (`audio/master-stage.ts`): **ours**, the page's default,
**the game's** — `SMS WaveHammer` and the 7.1 fold, gain and narrowing
([lbp-audio-engine.md](lbp-audio-engine.md), *The game's master bus*) — **the game's with an AGC
after it** (*63*, below), and **`'none'`**, the fold's gain alone. The engine card's `master` choice
under Song/Mixer picks it live, the Render view's own choice offline, `RenderOptions.master`
and `LBP_MASTER` in the library; the library's own default stays the game's, because the
differential checks compare levels with the modules.

❗ **Ours and the AGC are the only DSP in this project that is not the game's.** `audio/master.ts` is a glue
compressor (2.5:1, soft knee, threshold moved by one knob from -6 to -22 dBFS) followed by a
lookahead peak limiter with a -0.3 dBFS ceiling. It takes the game's bus's place: the fold's gain
alone, the file's own pans and no WaveHammer, then the glue and the limiter, past where the game's
chain ends. Nothing in LBP does this. It exists because the project's owner asked for a mix that
holds together. The Ableton export can carry it too, as Live's Compressor and Limiter on the master,
off by default ([ableton-interchange.md](ableton-interchange.md), *The master bus*).

Measured live on `Ascetic` at the default setting (glue 4), against `'none'` — the fold's gain
alone, which was the chain without it then: peaks 0.35/0.52 without, 0.56/0.85 with, a lift of
about 4.2 dB, and the limiter holding everything under the ceiling.

⚠️ **Two traps, both of them cost a test.** The limiter's gain has to be the *smallest the
lookahead window asks for*, not the newest: taking the newest and releasing upwards lets the peak
out of the delay line at +0.19 dB over the ceiling. And the window must include the frame leaving
the delay this very sample, or the one peak it never sees is its own. Both are pinned in
`test/master.test.ts`.

⚠️ **The makeup is referenced to -6 dBFS, not to 0.** Taking back what the ratio removes at full
scale assumes the mix already peaks there; ours does not, and the makeup then adds more than the
compressor took -- +7.4 dB at the default, against +4.2 dB now.

**Why it is the default**: a taste question, answered by the owner on 2026-10-12, the opposite way
from 2026-10-11. The game's bus had been the default for a day; heard beside ours it was much
quieter (*63*) and, to the owner's ear, worse. Before it was set aside it was checked against the
bytes once more: the WaveHammer's 68-byte template re-read, and FMOD's `createDSP` and `addDSP`
read for anything that would put the declared defaults back — nothing does (*SMS WaveHammer* in
[lbp-audio-engine.md](lbp-audio-engine.md)). So the game's bus is the game's as read, and the
deviation is a choice of sound, not a doubt about the reading. What is still open is whether our
level into the WaveHammer is the game's, which decides how hard it compresses (*38*): a capture of
a corpus song would say whether the game really sounds this squeezed. The faithful buses are one
choice away, under Song/Mixer.

## 63. The game's bus and an AGC — a choice beside ours

One of the four master buses is the game's **and then an automatic gain control** (`'agc'` in
`audio/master-stage.ts`, the AGC in `audio/agc.ts`): BS.1770's K-weighted loudness,
followed slowly, a gain towards −16 LUFS between −12 and +18 dB, and our limiter at −0.3 dBFS
(`Limiter` in `audio/master.ts`). Ours, not the game's: the game's shape is kept only as far as a
slow gain keeps it. Built on 2026-10-12 after the owner heard the game's bus far quieter than ours,
and the page's default for part of that day, until ours took the place (*42*). Normalising by the
song's peak — one gain, the shape untouched — was built first the same day and replaced at the
owner's request: live it needed a render of the whole song after every edit, 11.5 s for the 5:33
of `Ascetic`.

How quiet the game's bus is, and what the AGC does to it, measured 2026-10-12 on four whole corpus
songs through `renderSequencer`: integrated loudness by BS.1770 (400 ms blocks, both gates), the
loudness range as EBU Tech 3342 takes it (3 s blocks every second, a −20 LU relative gate, the 10th
to the 95th percentile), the sample peak, from a scratch script not kept:

| song | the game's | the game's + AGC | ours, glue 4 |
|---|---|---|---|
| `Ascetic` 723339 | −21.7 LUFS, LRA 4.1 LU, −5.6 dBFS | −16.5, 3.9, −0.3 | −14.5, 4.5, −0.3 |
| `This Is Halloween` 737099 | −20.3, 10.4, −1.7 | −16.1, 5.0, −0.3 | −13.6, 10.8, −0.3 |
| `Blackfire` 732985 | −21.4, 7.0, −1.0 | −16.3, 6.0, −0.3 | −14.6, 7.1, −0.3 |
| `Terra` 730116 | −22.3, 5.5, −4.6 | −16.3, 4.5, −0.3 | −15.8, 5.8, −0.3 |

The game's sits 5 to 7 LU under ours. The WaveHammer takes a constant 1.84 dB (its automatic
make-up times the template's −18 dB output gain, *SMS WaveHammer* in
[lbp-audio-engine.md](lbp-audio-engine.md)) and compresses 10:1 above −21 dBFS with nothing given
back; the fold's narrowing costs nothing on a centred voice and 1.7 dB of energy on a hard-panned
one. Ours goes the other way, make-up and a limiter at −0.3 dBFS. ⚠️ Nothing read after the
WaveHammer would make the game louder: the channel is at unity and the driver at 0 dB (*The
sequencer's chain*, *The output stage*). The master channel group's volume and the game's music
volume option are **not read**; FMOD Ex documents a channel group's volume as 0 to 1, so either
could only take level away.

⚠️ **An AGC fast enough to sound responsive is a compressor.** With the follower at 1.5 s up and
6 s down, `This Is Halloween`'s loudness range went from 10.4 LU to 2.9; at the shipped 10 s and
40 s the four keep 3.9 to 6.0 LU of their 4.1 to 10.4 and land within 0.5 LU of the target. What a
causal AGC cannot keep is a song whose sections differ a lot, `This Is Halloween`'s quiet opening
among them: it is set on what it has heard. Three things keep it from pumping, each found by a test
in `test/agc.test.ts` failing first: the level follows only within 1 LU freely and below that only
after 1 s (after 4 s more than 10 LU below, BS.1770's relative gate), so a song that stops does
not drag the gain up through its own tail — +3.9 dB before the band, 0.01 dB after; silence is
detected on a 50 ms follower, not the 400 ms one, which takes some 4 s to fall from a loud song;
and after 3 s of silence the next sound warms up again, fast and with no holds, as a new song.

Measured in the browser on `Ascetic`, 2026-10-12: the AGC's gain, reported by the worklet with the
voice counts and shown in the engine card, settles near +5.4 dB; the live output and the export
both peak at −0.300 dBFS; 0 dropouts. Live against export it is −66 to −72 dB from 6 s on, where the
game's bus alone reads −110 to −121: the page was hidden, Chrome fires a hidden page's first timer
about a second late, and the first second's voices sounded a chunk late; the AGC's slow memory carries
that as a 0.005 dB gain difference, 0.003 dB by 14 s. An AGC carries any difference at the start,
such as the song before, for tens of seconds; the WaveHammer forgets in seconds.

**What would settle it**: nothing measurable — it is a listening level. A real PS4's output into a
TV would say how loud the game is heard, not how loud this page should play.

## 61. The end of a voice — `RenderOptions.declick`, default **on**

Two ways a note's natural end clicks in the engine as read, both on *Rhombitruncated*
(`?level=91ab1a669d65557216a37d38717b90c68409d4dc&seq=44112`): a release shorter than a chunk is
ramped across one chunk (*The gate and the ramps* in [synth-engine.md](synth-engine.md)), and on
`triangle_wave`'s 0.8 ms release under the intro's octaves, ≈120–175 Hz, that is less than a cycle;
and a freed record's ladder stops in one frame whatever it holds (*The voice pool*, same file), which
on `e_perc_1`'s bongo at full modulation is 96 of the kit's 181 transients over the song, always
1,281 frames after a gate. The project's owner heard both on 2026-10-05, heard the triangle's go
when its release was forced to 20 ms, and asked for them gone.

What ships: `declick` holds the amplitude release to at least 20 ms (`DECLICK_SECONDS`) and, after
the sound ends — the release or the note's volume reaching zero, or an unlooped sample running out
— fades the ladder's output over the same 20 ms instead of stopping it (`Voice.beginTail` in
`mixer.ts`). A steal is untouched: the engine takes a stolen record mid-sample, and so does this.
Measured on the song: the kit's voice-end transients 96 → 0, and the triangle alone within −51 dB
of the render the owner approved by ear. `LBP_DECLICK=0` and `RenderOptions.declick: false` render
the engine as read.

`declick` also closes the **first-wrap gap** (since 0.2.47): a loop that ends on its sample's last
frame reads one frame of silence on its first trip round (*The sampler* in
[synth-engine.md](synth-engine.md)), and with `declick` it reads the frame the loader patched
there, the loop's first (`readMipped`'s `gapless`). The owner heard it as clicks on Indigo's
opening harp (4451115, `harp_fsharp4`, every note from 49 to 64), took it for an accident of the
engine's rather than a design, and asked for it gone. Measured on those four clips: the fifteen
first wraps go from +20 … +21 dB of high-frequency energy over the median to −1.8 … −8.6 dB, and
with `declick` off the render still matches the module to −105.8 dB.

`declick` also plays the **harp's loops smoothed** (since 0.2.48). The three harp samples pass from
a plucked string that still beats — `harp_fsharp4`'s level swings 0.17–0.22 every ~1,300 frames,
period by period off the file — into a loop of 9, 9 and 4 periods whose level is flat to a
thousandth; the owner heard the passage as a jump on every note of Indigo's opening arpeggio. The
loader keeps the game's sample and builds a second one beside it (`LOOP_SMOOTHING`, `smoothLoop`
and `engineSample` in `wav.ts`; `SampleBuffer.smoothed`), which a voice reads only with `declick`:
inside the loop every period is the average of its periods, and over the two loop lengths before
it the recording crossfades on a smoothstep into the loop's own continuation. The attack and the
loop's place are the game's. Chosen by ear against the shipped sample on Indigo's harp, dry; the
tracker's render of it equals the approved prototype to the bit, and with `declick` off the harp
still matches the module to −105.8 dB. ⚠️ **Two other ways were judged worse by the owner, and
should not come back**: a longer loop taken from the sustained part and crossfaded (it keeps the
beating, now repeated every 55 ms), and a plucked-string tail grown from the last period
(Karplus–Strong; the loop is nearly a sine by then, so it only fades).

⚠️ **Not every engine click is a candidate.** The owner's line, 2026-10-13: an accident of the
engine's goes (this gap); a behaviour a composer can work with stays. A clip's `sine_wave` notes
thump at each join because the engine starts each note from rest, ladders and all, beside the old
one still ringing for a chunk (the module does it to the sample: Vitriol, 731173, row 4). A
hand-over of the old voice's state removed it and was reverted at the owner's request: joining
notes so they do not break is the composer's job.

⚠️ **The bytes say the game clicks too** — `0x1750` squares the release, `0x1f65` reads the gate
once per chunk, `0x3093` frees with the ladder's states untouched — so this is a deviation that
removes something the game very likely has. **What would settle it**: capture the first five
seconds of *Rhombitruncated* from the game. A bongo hit every 0.461 s from 0.257 s with a click
27 ms after each note's end, and triangle notes ending in 5 ms, mean the engine is as read and
`declick` stays a choice; clean ends mean something past `0x3093` is unread.

## Residues — measured, not modelled, not audible so far

- **The WaveHammer's state when a song starts.** The chain is built on a session's first song and
  runs between songs from then on (*The sequencer's chain* in
  [lbp-audio-engine.md](lbp-audio-engine.md); `v0x3e6e00`'s FMOD calls are `Channel::setPaused`
  around a write to `[state+0x1a44]`). So the first song meets the WaveHammer at its reset state (unity, the
  smoother at ½), which is what an offline render does — `tools/prxchain.py` agrees with it to
  3e-5 dB of gain from the first frame — and every later song meets it settled on silence at rest
  (*And it was run* in [lbp-audio-engine.md](lbp-audio-engine.md)), which is what the live
  worklet does. The render gets there in about 700 frames (in float32 it stops moving at frame
  732); measured on `Ascetic` on 2026-10-11 with a recorder worklet, before the stage went float32,
  after those 14 ms the live output and the offline render agree to 1e-6. Against a later song the
  render is up to +1.8 dB hot over its first 14 ms; nobody has heard it.
- **The WaveHammer's table.** The console's `log10f` and `powf` put 542 of the 4000 entries the
  module builds up to 4 ulps from `Math.fround` of the double result, which leaves `compressor.ts`,
  otherwise bit-exact against the module, 3e-5 dB of gain off at most on six songs (*And it was
  run* in [lbp-audio-engine.md](lbp-audio-engine.md)). Porting those two functions would close it.
- **A preset change on a running reverb — modelled, and wired as the game does.** The
  module builds its lengths once and every later preset changes only its coefficients, and
  `Reverb.reconfigure` does the same to −106 dB (*SMS Reverb* in
  [lbp-audio-engine.md](lbp-audio-engine.md)). `render.ts` renders one song from a new `Reverb`,
  which is a session's first song and right. The live worklet (`mixer-worklet.ts`) gets an
  `effects` message from `player.ts` on every whole-plan load, every `setSettings` (tempo, swing,
  channels, faders, board rows) and every change of an effect. Since 2026-10-11 it keeps its
  `Reverb` across them while the setting is the same, and calls `reconfigure` on it, the game's
  re-apply through `v0x1c6250`. ✔ Checked in the browser (2026-10-11): one 62.5 ms note with a
  full send into setting 5, a recorder worklet on the player's output, and a tempo change 0.7 s
  into the tail. The tail goes through it at −40 dB and is at −74 dB 1.7 s on. A new `Reverb` at
  the same frame, which is what the worklet did on every message until then, is exact digital
  silence from that frame on. `mixer-worklet.test.ts` holds the kept instance to a `Reverb`
  reconfigured at the same frame. ✔ **A changed setting is re-applied too, since 2026-10-12, the
  owner's choice**: the tail carries on, and the reverb keeps the lengths of the setting it was
  built with (the page load, or switching it on in the Engine card) through every later change,
  as the game's editor session does. Whoever changes the reverb mid-song hears part of the old
  room; a fresh one is a page reload or the reverb switched off and on.
- **The keyboard bench, off the engine's clock.** Since 2026-10-12 the render and the live player
  both run the engine's clock and its float32 record (*3 / 3b* in
  [answered-questions.md](answered-questions.md)); the Keyboard view does not. Its notes have no
  song clock, a key being held for as long as it is held, and it builds its voices at modulation 0
  with the bench's own overrides of the envelope, the filter and the LFOs, which the engine record
  would ignore. So it keeps the double voice: its grid from the note's first frame (*60*), a rate
  formed in double (a drift of 0.0056 frames in four seconds on a held stacked note), a sub-step
  record's ramp anchored at its own position, and the filter in double. The tracker's clock
  (`RenderOptions.engineClock: false`) is the same voice, kept as an A/B. Moving the bench means an
  engine record per key and a clock that starts with it.
- **Envelope A in double.** The filter runs float32 on the engine's clock: envelope B, the two
  ends, the ramp, and in an export the ladder (*The filter* in [synth-engine.md](synth-engine.md)).
  Envelope A still runs `advance` in double there, not measured against the module. The live
  player plays the ladder itself in double (`EngineRecord.ladder64`), because the audio thread
  cannot spare +60% for at most 11.6 dB below -107 dB; its output against an export of the same
  song measured -117 dB median and -89 dB at worst of the loudest window, in the browser on
  2026-10-12 (*The live player* in [tracker-architecture.md](tracker-architecture.md)).
- **A one-shot's last block.** ✔ **Settled**: the module renders the chunk a one-shot runs out in
  whole — the other layers and the ladder run on past layer 0's last frame — and frees the record
  after it. The reading and the numbers are in *The voice pool* in
  [synth-engine.md](synth-engine.md); `Voice` does it on both clocks, and on the tracker's clock the
  nine scenes it settled sit at −82 … −110 dB of their loudest window, where that clock's double
  arithmetic holds the whole battery's median at −92 (*Float32 in the rate, off the engine's
  clock*, above). Left: the pool's `freedBy` takes the sample's length over the
  note's rate without layer 0's detune, which the render draws from the seeded stream after the
  pool has run. The 20 renders measured make the same decisions with the chunk or without it, so
  nothing has shown the detune yet; making it exact means drawing the stack before the pool without
  changing the stream. `woodpecker`, the tenth scene, was the filter's float32 (above).
- **A chain stored out of order.** The walk takes a note's records in the clip's array order
  (`0x3a0a`'s cursor) and `makeNote` sorts them by position, so the ~81 corpus notes whose last
  record precedes the first ([cwlib's sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md)) play differently
  here, the glide and the gate taken in another order. None plays in the first 20 s of the 16
  songs measured, so it is read and not measured.
- **The fader under a held note, live.** `0x3930` re-reads the channel's volume into `[+0x04]` at
  every walk; the live player scales a note's walk scores by the fader as it stands when the note
  is handed over (`Player.walksOf`), so a fader moved while a note holds its record changes that
  note's score in the engine and not here. The render's channel volumes do not move.
- **Whether `q` should reach 3.** ✔ **Settled: it does, in the module too.** With the correct
  filter reading `musicbox` at full modulation has resonance 0.856 at `freq ≈ 0.019`, and the
  Stilson/Smith compensation grows as the cutoff falls, so `q ≈ 3.1`. The saturation is read
  operation by operation now, `b4 − (b4·(b4·b4))·0.166667f`, and `woodpecker`'s full-modulation note,
  at `q ≈ 3.1` the same way, agrees with the module running (*The filter* in
  [synth-engine.md](synth-engine.md)).
- **The piano's loop contour.** A 5.75% flutter at F5's wrap rate was measured before the
  amplitude envelope existed ([game-assets.md](game-assets.md)); the piano's sustain is 0.070, and
  whether the flutter survives the envelope has not been re-measured. A sustained F5 captured from
  the game, run through the same modulation measurement, settles it: if the game flutters too the
  artefact is in the asset.
- **`PInstrument + 0x60`.** Copied into the engine's clip and its header as the length in steps.
  ✔ **Its writer is read** (2026-10-13): the instrument walk `v0x1c49e0` computes it from the
  chip's drawn width at every playback start, `16·(max(round(scaleX / scaleY), 1) + 1)` — the
  arithmetic is in *Which clips spawn* in [synth-engine.md](synth-engine.md). The editor derives
  32, 48 … 128 from the notes instead (`clipStepsFor` in [editor.md](editor.md)), and `render.ts`
  takes that, because on all 3,724 measured components `scaleX` is the multiple of `scaleY` that
  the highest record implies (`CHIP_WIDTHS` in `write-plan.ts`). What is left is the case that
  measurement cannot reach: a chip whose width disagrees with its notes — stretched past them in
  the game, or whose last notes were deleted — would keep its row for its drawn length in the game
  and for its notes' here. ⚠️ It reaches the sound: the walk's row scan keeps a clip on its row
  until the length runs out, so it decides when a finished clip lets its row go and, through the
  scan's stop at eight rows, whether a clip on row 8 or below spawns at all. **What would settle
  it**: carry `scaleX / scaleY` out of the placement into `Track` and count the corpus chips where
  it disagrees with the notes; none means the rule is exact on the data there is.

## 40. What a new SEQUENCER starts at — the editor's defaults are the corpus's modes

✔ **The instrument half of this is answered.** All 68 of the game's `instrument_*.plan` popit
items carry the same `PInstrument` — level 1, pan 0.5, both sends 0, key 0, scale 0, `Loops` 1, no
name, no notes, and the family's colour — so a chip the game has just placed holds exactly
`NEW_CLIP_DEFAULTS`, which used to be a reading of cwlib's field initialisers.
`tools/InstrumentColours.java` prints them beside the colour.

What is left is the **sequencer**: nothing has been read out of the game about the values a freshly
placed Music Sequencer holds. `NEW_SONG_DEFAULTS` in `packages/lbp-tracker-lib/src/song.ts` uses the corpus's
corpus medians for the echo (2.00 beats, feedback 0.45,
mix 0.5), on the reasoning that a mode that strong across 338 user sequencers is most likely the
value the editor starts at. A decision, not a measurement.

⚠️ **The tempo is no longer one of them.** The corpus's mode is 240 (ahead of 125, the *engine's*
default in `fmodextinput.prx` — the two are not the same thing), but since neither is a reading of
the editor, a new song starts at **120**: a blank song's tempo is a usability choice, 240 read as a
bug to every listener who opened one, and a loaded sequencer always carries its own tempo, so
nothing about fidelity turns on it. **What would settle it**: place a new
sequencer in the game, save, and read its `PSequencer`; the toolkit's field initialisers are the
other source, and they are a reading of the same kind as this one.

## 24. The last 54 clips that need a verbatim record patch

⚠️ **Nothing here is audible and nothing here is broken.** The MIDI round trip is exact — 0 records
different in 1,448,224 — *because* the exporter carries these clips' records verbatim in the
`LBP-TRK` meta's `fix` ([midi-interchange.md](midi-interchange.md)). The question is only whether
the patch can be made smaller, which matters because every clip in it goes stale the moment a DAW
edits its notes.

**54 of 62,158 clips (0.09%), and they are one family**: a part's clips overlap — a cell is 16 steps
and a clip may hold 128 — and a note that two of them could hold went to the other one.
`5aa77945` seq 745160 cells 31 and 107 are the same story from both ends, one clip short of its
last sixteen notes and its neighbour long by them. Bucketed by which record field differs
(`LBP_MIDI_LOOSE=1`, forty lines against `decodeRecords` on both sides): 44 clips have more or
fewer records than the file, 10 the same count with different notes.

**Ruled out — do not repeat:**

- **Six clip-assignment tie-break rules** (nearest, earliest, tightest, loosest, busiest,
  same-start) measured against each other moved the total by 6 at best; on the current baseline
  `busiest` gives 52 against `first-empty`'s 54, and the rule as it stands was chosen to stop clips
  being emptied. The cell ambiguity is not worth another rule.
- **A fourth record-order key does not exist**: among the 254 clips tied on all three, nothing
  beats 98.8%.
- **The flat-run markers are carrying their weight**: turning them off took the patch from 109
  clips to 277.
- ❌ Three anchors this entry once carried were all wrong in the same way — a taxonomy that
  bucketed by a guess rather than by diffing the records ("73 clips are a ramp re-cut", "31 clips
  mix the resting bit, look for runs", "five are not diagnosed"). **Print the diff first; the
  theorising is what produced the buckets.**

## 50. Should the instrument picker use the game's colours?

`FAMILY_COLOURS` in `src/editor/instruments.ts` is ours: eleven families, softened for a dark UI,
and it is what the picker and the inspector's glyph paint. The board no longer uses it — a chip
has its own colour now — so the two palettes sit side by side, close but not equal (the game has
seven families, saturated). Adopting the measured colours would make the picker match the board
exactly and lose some of the separation eleven families give. **A taste decision, and the owner's**;
it costs one table either way.

## 52. The Ableton set in Live 12

The `.als` export opens in Live 11.3.43 with its tracks, tempo, devices, clips, notes and their MPE
all seen there ([ableton-interchange.md](ableton-interchange.md)). What is not measured is
**Live 12.** The set is Live 11.3's schema, and Live 12 upgrades an 11 set on open, which is the
whole argument for the target — but no Live 12 is installed here, and Live 12 is the reader that
refuses a missing member. What would settle it: open an export in Live 12 and read its `Log.txt`
(`tools/open-in-live.ps1` with `LBP_LIVE_EXE` and `LBP_LIVE_LOG` pointed at it); if it names a
member, the empty-set reference was not complete.

## 53. The Ableton Samplers — what the mapping assumes and nobody has heard

The instruments option puts a Live Sampler on every track, and every member of it is checked to be
what the file says ([ableton-interchange.md](ableton-interchange.md), *The instruments*). What is
**not** measured is how each Live value sounds against the engine's, because the Live here is a
Trial that cannot export. Its meters can be read, though, and they settled the level: the pressure
law is linear like the engine's, and `VolumeVelScale` had added 22.8 dB (*The instruments*, same
file). Each item below is a decision where a measurement is still missing:

- **The filter**: Live's Clean 24 dB low-pass for the Stilson/Smith ladder, the cutoff as a fraction
  of 24 kHz, resonance written straight into Live's 0..1.25. Measured on Live's meters, so no longer
  open: the curve, the key tracking's reference, and the passband and peak at a resonance of 0.53
  (*The instruments*, same file). Still open:
  - The envelope meets the engine at the peak and the sustain, so a note's attack starts from a
    rest that is not the engine's.
  - Key tracking between 0 and 1. The engine is linear in the playback rate,
    `1 + (rate − 1)·amount`; Live's is taken as exponential, `amount` octaves per octave. The two
    agree at 0 and 1, which is where 58 of the 68 instruments sit.
  - An instrument whose slots have different roots. The engine tracks each note from its own
    slot's root, so the cutoff steps at a zone boundary; one Sampler filter tracks from the
    commonest one.
  - The resonance anywhere but 0.53. The ladder only oscillates near `q = 4` (`saw_wave`'s 0.76 is
    `q = 0.87` there), so at other values Live may ring far harder than the game.
  - The two filters' shapes. The dial now matches the ladder where Live attenuates 8 dB
    (`liveDialHz`), but the ladder is flatter under its knee and steeper over it. Whether the
    ear wants the match at −8 dB or elsewhere is a listening question, and so is whether a pulse
    sweep in Live now sounds like the game's (*The instruments*, same file).
  - A track whose modulation never moves keeps the envelope fit at its own corners, but its key
    tracking goes through the knee at the slot's root and then moves exponentially. The engine
    puts each note's own cutoff through the ladder, so away from the root the two part by up to a
    semitone (`ghost` at key 55).
- **The release** is written from the sustain level; the engine releases from wherever the level
  is, so a note let go during its decay releases for less in the game.
- **The master at 0 dB**, so the set is the engine's own sum: what reaches the game's master bus,
  before `SMS WaveHammer` and before the fold's +4.645 dB on the sum
  ([lbp-audio-engine.md](lbp-audio-engine.md), *The game's master bus*). Live has no WaveHammer,
  so nothing in the set does what the tracker's default bus does, and a dense passage that the
  tracker compresses plays uncompressed there. Chosen for headroom: `Ascetic` renders to a 0.934
  peak with the fold's gain and no compressor, and a Live mix at that level has nothing to catch
  it. Raising the master by the fold's +4.645 dB matches the tracker on `'none'`, not on the
  game's bus.
- **Not carried at all**: the unison stack (`Numstack` layers, `Params[0..2]`), the three LFOs
  (`Params[15..23]`). Per note, the modulation now moves the level (pressure) and the cutoff (the
  slide's first destination, measured). The slide's second destination is free. The resonance,
  `Params[4]`, is the likeliest use for it, and Live's slide-to-Res law is unmeasured.

What would settle them: a machine with a licensed Live that can export audio, the same song rendered
from the tracker and from the set, and the comparison `render-level.ts` already makes against a
capture of the game.

## 58. The Ableton swing groove — what Live does where the manual says nothing

Unbaked, the export swings through a groove every clip follows ([ableton-interchange.md](ableton-interchange.md),
*The swing*). That Live reads it is checked; what Live plays is not, because the Trial renders
nothing. The groove and the engine agree exactly where the manual is explicit, a note starting on a
sixteenth, and the manual says nothing about the rest. Counted on 2026-10-04 by a throwaway walk of
`schedule()` over the 13 swung sequencers in the toolkit checkout's `data*` folders, 40,897 notes:

- **8,418 (20.6 %) start on an odd sixteenth**: the notes the groove exists to move, and the case
  the manual covers.
- **1,200 (2.9 %) start between sixteenths**, on a third of a step. The engine scales the fraction
  by that step's own length; Live measures each note against its nearest sixteenth, and whether it
  shifts it by that groove note's offset, interpolates, or leaves it alone is not written down.
- **17,307 (42.3 %) end where the engine shifts the end by a different amount than the start**: a
  note from an even step to the odd one lasts `L(1 + swing/2)` in the game, not `L`. If Live keeps a
  note's length when it moves it, these come out `swing/2` of a step long or short. If Live moves
  ends on their own, they may be right.
- Whether Live moves a note's per-note expression with it is not written down either; the engine
  swings each control point. And a merged track's mixer automation steps at the straight time of
  the note it waits for, up to `swing/2` of a step early, which lands on a release tail like any
  switch (*Measured over the corpus*, same file).

Baking has none of this: every time goes through `swungFrame`. What would settle it: a Live that
renders or records its own master, the same swung song played with the groove and baked, and the
onsets and ends compared.

Those 13 are every swung sequencer on this machine: a walk of every corpus through `readBackup`
on 2026-10-04 (the `data*` folders and their saves, `lbp-download/backups`, `fixtures/archive`,
`fixtures/bonsai`, 221 levels and 658 sequencers) found no others. All 13 are by Velvet--Audio,
in `data2`. Two of them isolate the cases above:
- `Unfinished 37` (uid 111984, file `9efab55d…`) is the clean case: swing 60, 8 bars, 177 notes on
  odd sixteenths and none off the grid.
- `Unfinished 33` (uid 110511, the same file) is the off-grid case: swing 75, the corpus's
  highest, with 944 of its 1,436 notes on thirds of a step.

## 59. The Ableton echo — Live's Delay taken to work as the engine's does

The Echo return is Live's Delay at the engine's time and feedback, its fader at `EchoMix`, and each
part sends into it at the engine's own send ([ableton-interchange.md](ableton-interchange.md),
*The returns*). The numbers are the engine's, checked over 150 sequencers. How Live uses them is
taken, not read:

- **The feedback law.** The engine's `n`-th repeat is at `fb^(n−1)` (`0x07c0`,
  [synth-engine.md](synth-engine.md)); Live's `Feedback` is taken to be the same linear gain in the
  loop.
- **The wet level.** Dry/Wet at 100 % is taken to put the delayed signal out at unity. The
  `DryWetMode` 1 that Live's own empty set carries is not decoded.
- **The time.** The synced menu was read off the device (4 lit for index 3), not timed.

What would settle all three: Live's meters, as for the Sampler's level (*How it was checked*, same
file). A sustained sine whose period divides the delay goes into the Echo return at send 1, with
its fader at 0 dB. If both laws hold, the return's peak box climbs to `1/(1 − fb)` of the input.
Two or three sets at different feedbacks would separate the two laws.
