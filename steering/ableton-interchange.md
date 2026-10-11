# What our Ableton Live set carries — and how Live was made to say so

Read before touching `packages/lbp-tracker-lib/src/als.ts` or
`packages/lbp-tracker-web/src/daw/als-export.ts`. The module's header has the mapping table (part →
track, placement → clip, glide → per-note pitch, and the rest); this file has what that mapping
rests on, measured out of Live's own files, Live's own manual and Live itself, and what nobody has
looked at yet.

The MIDI export is the other way out of the tracker and shares three things with this one on
purpose: `partKey` (what a part is), `partLabel` (`row 4 - saw_wave`) and `rowGroups` (which parts
share a track), all in `midi.ts`, so the two files list the same song as the same tracks.
Everything about *why* is in [midi-interchange.md](midi-interchange.md).

## Why the target is Live 11.3's schema, member for member

Measured 2026-09-24 on this machine, whose only Live program is **11.3.43**
(`C:\ProgramData\Ableton\Live 11 Trial\Program`; Live 12.4.3 left its preferences behind and its
program is gone). Every line below is from Live's own `Log.txt`, read by
`tools/open-in-live.ps1`:

| the file | what Live 11 did |
|---|---|
| `sequencerdump`'s set, as written (`MinorVersion="12.0_12049"`) | refused: `Unsupported MinorVersion (12.0_12049)` |
| the same set with only the version rewritten to `11.0_11300` | **opened with no exception** — tracks named, tempo 130 — and **every clip slot empty** |
| ours | opens; tracks, tempo, returns, devices, clips, notes and their MPE all there (below) |

⚠️ **Live 11 fills a missing member with its default and says nothing.** That is how the second
row loses its music with a clean log, and it is why "no exception" is necessary and never
sufficient here. Live 12 is the stricter reader: on 2026-07-19 Live 12.4.3 refused the owner's own
set-from-scratch by naming what was missing — `Member "FollowActionEnabled" of Class FollowAction
is missing, path: LiveDocument/Scenes/0/FollowAction` — and another with `Set has no player
tracks`.

So the writer carries **every member Live itself writes**, from references Live saved:

- an **empty set saved by the owner's Live 11.3.43** (`MinorVersion 11.0_11300`,
  `SchemaChangeCount 7`): the `MidiTrack`, `ReturnTrack`, `MasterTrack`, `PreHearTrack`, scenes,
  transport, the `LiveSet` tail, and the **Reverb and Delay** its two returns hold;
- the Core Library's **`Ninajirachi - In The Rain (Live 11 Suite Demo).als`** (`11.0_11300`,
  Live 11.3d1): the only arrangement `MidiClip` with MPE on this disk that Live itself wrote.

⚠️ **Not a clip written by another tool.** `La Mosca e il Toro BACKUPPATO …als` in the owner's
Downloads says `Creator="dawtools (Ableton Live 11.3.43)"` and its clips lack eight members the demo
has (`ScaleInformation`, `ExpressionGrid`, the fold-scale pair and more); Live 11 opens it, which is
the silent-default behaviour above, not evidence that the members are optional.

The two devices were **derived, not transcribed**: a script read each out of the empty set, reduced
every member to one of four shapes (a float dial with its range, an on/off switch, an enum, a plain
value) — which is `DeviceMember` in `als.ts` — and the XML rebuilt from the reduction has the same
elements in the same order as Live's: 430 for the Reverb, 329 for the Delay. A device with nested
members goes through `DeviceNode` instead (`als-xml.ts`), and `packages/lbp-tracker-lib/dev/als-device-tree.ts`
is the script that reduces it. It reads a preset Live saved, prints the tree, and refuses unless
`emitDevice` gives back the file's elements in the file's order. The Compressor and Limiter of
*The master bus* come from it; the Sampler's default rebuilds through it too (904 elements).

Live 12 opens an 11 set and upgrades it; nothing opens the other way round. That is the whole reason
the target is 11. **Live 12 itself is unchecked** — *52* in [open-questions.md](open-questions.md).

`Creator` is free text — the `dawtools` set above opened in Live 11.3.43 on 2026-09-18 — so ours says
`LBP Tracker`. `MinorVersion` is what Live checks.

## The units, read off Live's own files

| what | unit | read from |
|---|---|---|
| every time | beats; a step is a quarter of one | the demo |
| an arrangement clip | `Time` = `CurrentStart`, `CurrentEnd`, both absolute; `LoopStart`/`LoopEnd` in the clip's own content; notes relative to that content | the demo's clip at `Time="32"`: `CurrentEnd 160`, `LoopStart 4`, first note at `Time="4"` |
| per-note pitch, `CC="-2"` | **8192/48 = 170.67 per semitone**, ±48 | the demo's values: `341.3125` (a tone), `511.97` (3), `853.28` (5), `1194.59` (7), `1706.56` (10) — drawn by hand, so each within 0.1 of the multiple, and no other unit fits all five |
| per-note `TimeOffset` | beats from the **note's** start | the demo's note at `Time="32"` whose list opens at `TimeOffset="4"` |
| between two per-note events | a straight line: `CurveControl1/2` at `0.5` | the demo writes 0.5 on every event it has |
| pressure `CC="-1"`, slide `CC="74"` | 0..127 | Live's MPE ranges |
| track `Volume`, a send | linear gain; `0.0003162277571` (−70 dB, shown as −inf) to `1.99526238` (+6 dB); a send tops at 1 | the empty set's `MidiControllerRange` |
| `Pan` | −1..1, constant power (below) | the same; the law from the manual |
| `TimeSignature` 4/4 | `201` = `denominator index × 99 + numerator − 1` | the owner's `cubase_to_ableton.py`, checked in Live there (`3/4 = 200`, `4/2 = 102`) |
| `AutomationTarget`, `ModulationTarget`, `Pointee`, `ControllerTargets.N` | **one id space**, and `NextPointeeId` past all of it | the empty set; an envelope finds its parameter by that number |
| a track's automation | `AutomationEnvelope` in the track's `AutomationEnvelopes`, `PointeeId` = the dial's `AutomationTarget`; opens with an event at `Time="-63072000"`, "before the song" | the empty set's tempo envelope on the master |
| a step in an envelope | **two events at one time**, the old value then the new; one event alone ramps from the last | the demo's `BoolEvent`s at 224, and `FloatEvent`s at 339 and 368 in a set of the owner's |
| Delay's `DelayLine_SyncedSixteenth` | an index into **1, 2, 3, 4, 5, 6, 8, 16** sixteenths | the empty set's delay carries Live's "Dotted Eighth Note" preset at 2 (= 3); the whole menu read off the device in Live, with 4 lit for index 3 |
| Reverb `DecayTime`, `PreDelay` | ms | Live shows 3000 as `3.00 s` and 70 as `70.0 ms` |
| Reverb `MixReflect`, `MixDiffuse` | linear gain, floor 0.03 (−30 dB) | the empty set's range; Live shows the floor as `-30 dB` |

❗ **A glide goes in as its control points and nothing else.** The engine glides linearly between
records and Live draws a straight line between per-note events, so the MIDI export's resampling,
its simplifier and its fifteen-channel budget have no counterpart here.

## The mixer — the engine's gain on each channel, through Live's pan law

❗ **Live's pan law is constant power, 0 dB at the centre and +3 dB at either end**: the Live 11
manual's own *Audio Fact Sheet*, §34.3.9, page 835 of `User Manual English.pdf` beside the program
("Live uses constant power panning with sinusoidal gain curves"). So a track at volume `V` and pan
`x` puts `√2·cos θ·V` and `√2·sin θ·V` on its two channels, `θ = (x + 1)·π/4`. The engine's law is
linear ([synth-engine.md](synth-engine.md)): `2(1 − p)` and `2p` times `level × channelVolume` on a
mono sample, the 2 being the factor that enters with `Params[24]`. Both are unity at the centre, and
the two agree exactly when

```
x = (4/π)·atan2(p, 1 − p) − 1          V = level × channelVolume × √2 × √((1 − p)² + p²)
```

— `mixerOf` in `als.ts`. The fader rises to `√2` hard over, which with Live's +3 dB puts `2G` on the
one channel, as the game does. ⚠️ Writing the plain `2p − 1` put a part at pan 0.25 at 1.31 : 0.54
where the game plays 1.5 : 0.5. It is exact for a source that is the same on both channels, which
is what a mono sample through an instrument is; a stereo source gets the same gain per channel, and
whether the game pans a stereo sample that way is not checked.

`Params[24]` itself, the instrument's own output level, belongs to the instrument: with the
instruments off it is not in the set, and with them on it is the Sampler's volume — ❗ **without
the 2, which is already here in the track's law.** Written into both, every track played 6.02 dB
over the game, and the owner heard the tracks too loud and the master clipping (2026-09-29); a
test now holds Sampler × fader × Live's pan to the renderer's `level × channelVolume × 2 × P24`
times `1 − p` and `p`. That test could not see the other 22.8 dB, which were Live's own (*Vel → Vol*
in *The instruments* below). The set's master is the engine's own sum, at 0 dB: nothing of the
game's master bus is in it — no `SMS WaveHammer`, which Live does not have, and neither half of
the 7.1 fold, so the file's own pans and not the fold's gain (*53* in
[open-questions.md](open-questions.md); the bus itself is in
[lbp-audio-engine.md](lbp-audio-engine.md)).

## The colours — Live's palette, measured

A Live colour is an index, 0..69, into a palette that is not in any file. **Measured 2026-09-24**:
three sets of 24 folded tracks coloured 0..69 opened in Live 11.3.43, each header read off the
capture at three pixels that agreed on every row; the two indices read twice (23 and 46, selected
in one set and not in the other) gave the same value, so selection does not tint a header. The
values are `LIVE_PALETTE` in `als.ts`. A chip's tint (`drawnColour`, packed RGBA) goes to the
nearest of them in CIE Lab, on its track and on each of its clips, so a merged track keeps its
chips' colours. In Live the result reads as the board does: `This Is Halloween`'s pulse, music box
and piano rows came out blue, purple and yellow.

## The returns — Live's Reverb and Delay, set from the sequencer

| the sequencer | the return |
|---|---|
| `ReverbSetting` 0..5 | A, Live's Reverb: `DecayTime` = the preset's RT60, `PreDelay` = the time before its late field, the high shelf at its damping frequency (off for Bright Plate), and the early reflections as far below the late field as the preset has them — [lbp-audio-engine.md](lbp-audio-engine.md), *The six the sequencer offers*. 6 and 7, which no menu offers, take Small Room |
| `EchoTime` | B, Live's Delay, synced to that many sixteenths when Live's menu has them — 2, 1 and 1.5 beats are 331 of the corpus's 338 sequencers — and in seconds at the song's tempo otherwise |
| `EchoFeedback` | the Delay's feedback, clamped to 0.95: the engine's own clamp and Live's own maximum |
| `EchoMix` | return B's fader: the engine's echo is a plain wet gain |
| a part's `reverbSend` | its send into A, as it stands: the engine's reverb send is the field alone |
| a part's `echoSend` | its send into B, **the engine's**: the instrument's own `Params[25]`, at the modulation the part's notes mostly open at, bent by the field (`echoSendLevel` in `params.ts`; [synth-engine.md](synth-engine.md), *The output stage*) |
| the echo feeding the reverb | return B sends into return A at 1, post-fader — the engine adds the echo's wet to all four output lanes, and lanes 2-3 are the reverb's input ([synth-engine.md](synth-engine.md), *The echo*) |

❗ **A part's `echoSend` is not its send.** The engine reads it as a bipolar offset on the
instrument's own send: 0.5 leaves `Params[25]` alone, 0 mutes it, 1 forces unity. Until 2026-10-05
the set wrote the field as the send, and the owner suspected the delay's time, level or feedback.
Measured that day by a throwaway walk of `schedule()` over the 150 sequencers of `export-als.ts`,
each note's `Params[25]` read out of `fixtures/rinst` at its own modulation: **39,590 of 953,791
notes went into Live's echo louder than into the game's**, a median 19.6 dB louder where both echo
(10th percentile 4.4, 90th 31.2), and 9,760 of them echoed in Live and not at all in the game —
a part at 0.5 or under on an instrument with no send of its own, which 33 of the 68 are. None went
in quieter. A Live send is one per track, so the 615 notes that open at a modulation whose send is
not their part's take the part's. Without the Samplers the set still needs each instrument's
`.rinst` for this (`AlsExportOptions.instrumentSettings`): the page fetches them for every export
and `export-als.ts` reads them, and an instrument found in neither is taken to send nothing of its
own.

The time and the feedback were checked the same day, over the same 150: the delay Live is given
equals the engine's within 2 ms on every one. Every `EchoTime` is on Live's synced menu, and none
reaches the ring's 2.0 s clamp, which takes a tempo under 30 × `EchoTime`; the 150 run 70 to 240.
No `EchoFeedback` passes 0.95. Whether Live's Delay *applies* them as the engine does is *59* in
[open-questions.md](open-questions.md).

Checked in Live on `This Is Halloween`: the Delay reads Sync on both sides with 4 lit, feedback
54 %, dry/wet 100 %; the Reverb reads predelay 70.0 ms, decay 3.00 s, high shelf 7.00 kHz, reflect
−30 dB — the Cathedral, whose early reflections are 36 dB under its tail and meet Live's −30 dB
floor.

⚠️ **Two different algorithms.** This sets what the two have in common — how long the room rings,
when its tail arrives, how dark it is, how loud the early reflections are against it, the echo's
time and feedback — and is not the game's sound. The echo's hard clip and the reverb's absolute
level have no counterpart set.

## The swing — a groove every clip follows

| the sequencer | the set |
|---|---|
| `Swing`, unbaked (the default) | one groove in the set's pool, `LBP swing N` (N = swing × 100, the mixer panel's number): a bar of sixteenths at `swungFrame(k, 1, swing) / 4` beats, Base 1/16, Timing 100, Quantize, Random and Velocity 0; every arrangement clip's `GrooveId` is 0. The notes stay on the grid |
| `Swing`, baked | every time in the set through `swungFrame`, and the pool empty with `GrooveId` −1 — a groove as well would swing the notes twice |
| `Swing` 0 | the pool empty, as in Live's own empty set |

- **A groove in a set's pool**, member for member: the Core Library's `Templates/Demo & Sketch.als`
  (`11.0_11300`, Live 11.3d1), whose nine clips say `GrooveId 0` and whose pool holds `<Groove
  Id="0">` — `LomId`, `Name`, `Clip`/`Value`/`MidiClip`, `Grid`, `QuantizationAmount`,
  `TimingAmount`, `RandomAmount`, `VelocityAmount`, `Annotation`, `Selection`, `SourceContext`. The
  clip is an ordinary `MidiClip` of the schema, so `clipXml` writes it. `SourceContext` is empty, as
  in Live 11.3.11's own `.agr` files; the demo's points at the file its groove came from.
- **`Grid` is an index**: Live's own `Grooves/Utility/Quantize 4, 8, 8T, 16, 16T, 32.agr` say 0 to 5
  in that order, so a sixteenth is 3.
- **Timing 100 and the rest 0** is how Live's own swing grooves are set (`Grooves/Swing/MPC/Swing MPC
  3000 16ths 64.agr`, Base 3).
- **Why it is the engine's swing**: Live moves a clip's note towards the groove note at its nearest
  Base division, and a groove note on the grid moves nothing (the Live 11 manual, *Using Grooves*,
  13.1.1). So even sixteenths stay and odd ones go `swing/2` of a step late, which is the engine's
  even/odd stretch ([synth-engine.md](synth-engine.md)). In MPC terms the off-beat sits at
  `50 × (1 + swing/2)` % of the pair: the corpus's 0.05..0.75 is 51.25..68.75 %, inside the range of
  Live's own MPC grooves (54..74).

Checked in Live 11.3.43 on 2026-10-04 with `The Tip` (uid 110764, swing 0.6, `data2`): it loads
with no exception. The control bar shows the Global Groove Amount at 100 %, and the same song
baked does not. The manual says that slider appears only once clips use a groove. A debug copy
opened on `cell 0`'s detail shows its Clip box's Groove chooser at `LBP swing 60`. ⚠️ **What Live
then plays is not measured**: the Trial renders nothing, and the manual is silent about notes off
the sixteenth grid, note ends and per-note expression — *58* in [open-questions.md](open-questions.md)
has how many notes that is.

## The master bus — ours, on Live's master, off by default

The tracker's master bus (`audio/master.ts`, *42* in [open-questions.md](open-questions.md)) is not
the game's, and in the set it is an option like the instruments (`AlsExportOptions.masterBus`, the
page's "our master bus on the master" at the engine's glue knob, `LBP_ALS_MASTER=<glue>` in
`export-als.ts`). On, the master track holds two devices, in this order:

| `audio/master.ts` | Live's master |
|---|---|
| the glue: peak, 2.5:1, 6 dB knee, 10 / 150 ms (`GLUE`) | **Compressor** (`Compressor2`): Peak, the same ratio, knee, attack and release, no lookahead, Makeup off, Dry/Wet 100 % |
| the knob's threshold and makeup (`glueLevels`) | Threshold and Gain, each moved by the fold's gain (below) |
| the limiter: linked, the ceiling, 80 ms, 2 ms lookahead (`LIMITER`) | **Limiter**: Stereo, the same ceiling and release, Auto off, Lookahead 1.5 ms, the nearest of Live's three |

- ❗ **The fold's gain goes into the compressor.** The tracker's bus hears the engine's sum times
  `FOLD_GAIN`, +4.65 dB. Live's master hears the sum alone, its fader at 0 dB (*The mixer*). A
  peak detector with a knee in decibels treats a signal `G` dB quieter the same way if its
  threshold is `G` dB lower. So the Threshold comes down by the fold's gain and the Gain goes up by
  it, and the Limiter hears what the tracker's limiter hears. With the bus on, the set plays at
  the level the tracker does on ours; off, it is the sum before any master bus, 4.65 dB under
  the tracker's `'none'` and uncompressed where the game's bus would compress (*53*).
- **The Compressor, not the Glue Compressor.** The Glue has ratios of 2, 4 and 10 and its times in
  steps; the Compressor takes our numbers as they are, and every edition of Live has it.
- **Units and menus**, read off Live's presets and checked on the device: the Compressor's
  Threshold is linear (`Basic Peak Compressor` stores 1 for 0 dB), its `Model` 0 is Peak (that
  preset) and 1 RMS (`Mix Gel`). The Limiter's `Lookahead` 0, 1 and 2 are 1.5, 3 and 6 ms
  (`Low Latency` 0, `Fast` and `Slow` 1, `Lookahead` 2).
- ⚠️ The ratio's MIDI range tops out at `340282326356119256160033759537265639424`, every digit,
  in Live's preset. JavaScript writes that number with an exponent, so `num` in `als-xml.ts` spells
  out anything from 1e21 up.

Checked in Live 11.3.43 on 2026-10-04 with `Periastron` at glue 4. The set loads with no
exception. Live does not select the master through `HighlightedTrackIndex`: 22 and 23 both landed
on the Echo return. So a debug copy also put the same two devices on that return, and the panel
read back Peak, 2.50:1, 10.0 ms, 150 ms, Auto off, Thresh −17.0 dB, Out 8.49 dB, Makeup off,
Knee 6.0 dB, Dry/Wet 100 %, then Gain 0.00 dB, Ceiling −0.30 dB, Stereo, Lookahead 1.5 ms,
Release 80.0 ms, Auto off. That is glue 4's −12.4 dB threshold and +3.84 dB makeup, each moved by
4.65 dB. ⚠️ Same settings, different algorithms: how Live's ballistics and knee compare with ours
is unmeasured, and the set is a starting point for a mix, not our output sample for sample.

## The instruments — Live's Sampler from the `.rinst`, off by default

❗ **An option, off unless asked for, by the owner's rule (2026-09-24)**: on, the download carries
Sony / Media Molecule's samples ([game-assets.md](game-assets.md), *Asset licensing*) and becomes a
zip holding a Live project; off, the `.als` alone, a file of notes. The owner has Live 11 Suite,
which has the Sampler. `als-sampler.ts` has the mapping table; what it rests on:

- **The device is derived, not typed.** `SAMPLER` is Live's own `Core Library/Defaults/Instruments/
  Sampler.adv` reduced to `DeviceNode`s (`als-xml.ts`), and rebuilt without overrides it has the same
  1,243 elements in the same order as the file. The Shaper is the one in the Core Library's `Saw
  Filtered Bass` preset. A device in a track's list needs an `Id` the preset file's root lacks —
  without it Live refuses the set: `Not all list members have Ids`.
- **Zones** are `resolveSlot` run backwards, over the raw notes; fine tune and `fitBpm` go into the
  root and the cents; an unpitched slot is one zone per key, each its own root. Checked in Live on
  `Ascetic`'s double bass: silence above 73 and below 24 and `db_c3_dsp1` between, root 48, exactly
  as the instrument has it.
- ❗ **With a Sampler a note is written raw, and `Key` and the scale become pitch.** The engine
  picks the slot off the raw note and only then quantises and transposes (`scale.ts`). So the
  MIDI key is the raw note, the one the tracker's roll shows. The track's commonest `Key` lowers
  every pitched zone's root; unpitched zones keep theirs, since the engine plays them at one rate.
  Whatever is left is per-note pitch, on notes that land on a pitched slot: another part's `Key`,
  a note the scale moves, a glide. ❌ Until 2026-10-04 the note was the sounding one and the zones
  moved by the commonest `Key`. A part keyed otherwise then played through the zones next door,
  which the export only counted (`offKey`). `Periastron`'s row 2 kit has a part in D and a part in
  D# on one track; Live showed the D part's raw 48 as key 50, inside the tom's zone, so its 236
  closed hi-hats hit the tom (the owner, in Live's piano roll). Now every raw 48 is key 48, in the
  closed hi-hat's zone, and the D part's 572 notes carry −1 semitone each. Without a Sampler the
  note is still the sounding one, as in the MIDI export: an instrument the user loads has no `Key`.
- ⚠️ **Live names the octaves one lower than the tracker.** Live calls MIDI 60 `C3`; the roll
  (`noteName` in `editor/geometry.ts`) and `basenote` call it `C4`. So the raw note the tracker
  shows as C3 is `C2` in Live, though it is the same number.
- **Samples** are the `.smp` frames verbatim under a 48 kHz header, since the engine never reads the
  rate: Live then plays the 44.1 kHz ones 8.8 % fast, as the game does, with nothing to correct.
- **The loop**: Live's Sample tab showed `piano_c4` at Loop Start 20251 and Loop End 36562 —
  `[dwStart, dwEnd + 1)`, the loader's region — with `SustainLoop` `Mode` 1 as the forward loop and
  0 as none, and `ReleaseLoop` `Mode` 3 as off.
- **The project**: a sample referenced with `RelativePathType` 3 and a path relative to the set is
  found **only when the folder holds `Ableton Project Info`** — without it Live's log says `Il file
  "piano_c4.wav" non può essere aperto`, with it the set opens with its samples. Windows' own
  extractor keeps the empty folder from our zip, and `This Is Halloween`'s project, unzipped, opened
  with 0 missing files.
- **The MIDI tab**, read off Live with a numbered connection on every row. The rows (`KeyDst`,
  `VelDst` and `RelVelDst` are Key, Velocity and Off Vel):

  | `MidiCtrl.0` | `.1` | `.2` | `.3` | `.4` | `.5` |
  |---|---|---|---|---|---|
  | **Pressure** | Pitch Bend | Mod Wheel | Foot Ctrl | **Slide** | Note PB (±48 st) |

  and what a `Connection` number names:

  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
  |---|---|---|---|---|---|---|---|---|
  | Sample Selector | Sample Offset | Loop Start | Loop Length | Release Loop | Pitch | Pitch Sample | Pitch Osc | Pitch Env |

  | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
  |---|---|---|---|---|---|---|---|---|
  | Volume Osc | Shaper Amt | **Filter Freq** | Filter Q (Legacy) | **Filter Res** | Filter Morph | Filter Drive | Filter Env | **Volume** |

  The list goes on past 18, unread: Ableton's own Core Library presets route to 19–23, 25–27, 29
  and 30, all with the LFO on but `MPE Dulcimatica`'s 20, which has every LFO and the auxiliary
  envelope off (a scan of its `.adv`/`.adg` files). ❌ **A probe setting 19 to 36 at once crashed
  Live 11.3.43 on load**, and which of them did it is not known. One crash: Live packs the same
  dump into `Live Reports` again at each later start, five zips of it that night.
- ❗ **Every note carries its level on per-note pressure, because at 100 the Pressure row leaves a
  note with none silent.** The row is there for the volume ramp. The first export put pressure on
  the ramped notes only, the rest keeping their level as velocity, and it played nothing: the
  owner heard silence from `Ascetic`, whose first 872 notes, 22 seconds of it, have no ramp, and
  a capture of Live playing `This Is Halloween` has every meter flat (2026-09-24). So on a
  track with a Sampler every note gets a pressure list, a flat note's as one point, and velocity
  127: one law for every level. ⚠️ The price: a note drawn in Live, or played on a keyboard without
  aftertouch, is silent until it is given pressure or the row's Amount is turned down.
- ✔ **Live applies that pressure linearly in amplitude, which is the engine's `v/127`.** Measured
  2026-10-04 on Live's own peak boxes (*How it was checked* below), with a half-scale 1 kHz sine on
  each track through the export's Sampler at 0 dB:

  | pressure | 127 | 96 | 64 | 32 | 16 | 8 | 4 | 1 |
  |---|---|---|---|---|---|---|---|---|
  | Live, against 127 (dB) | 0 | −2.5 | −5.97 | −11.99 | −18.01 | −24.03 | −30.1 | −42.1 |
  | `20·log10(p/127)` | 0 | −2.43 | −5.95 | −11.97 | −17.99 | −24.01 | −30.03 | −42.08 |

  112, 80, 48, 42 and 24 agree as closely. ❌ *53* in [open-questions.md](open-questions.md)
  guessed from Ableton's presets that the law was something else; the presets were not evidence of it.
- ❗ **Vel → Vol (`VolumeVelScale`) is 0, Live's own default, so the velocity plays no part.** The
  export wrote 1 from its first version, with no reason given. At 1 Live raised a velocity-127 note
  **22.8 dB** over the dial, and a velocity-64 one sat 2.4 dB under it. Every note goes in at 127, so
  every track played 22.8 dB hot, and the owner had to pull the master down 20 dB to stop it
  clipping (2026-10-04). It was found by one track per suspect, each with one member changed from
  the reference. Only `VolumeVelScale` 0 moved it, to the expected −8.52 dBFS to the hundredth.
  These made no difference: 6 voices instead of 32, retrigger on, the sample's loop off, and no
  pressure list with the row off. The dial (−12 dB moved it −12.02), the fader (0 dB moved it
  +2.5) and the zone's `Volume` (0.5 moved it −6.04, so linear) all read as the file says.
- **Voices**: `Globals.NumVoices` is an index — 5 shows 6 voices (the default), 13 shows 24, 14
  shows 32, the engine's pool. The default 6 would cut every chord denser than that; the default
  retrigger (`RetriggerMode`) would end a note where the same key strikes again, and the engine
  gives both a voice. The export writes 14 and no retrigger.
- **Filter and envelopes**, checked on `Ascetic`'s square wave: Clean circuit, 24 dB, 480 Hz at rest
  with an envelope amount of 67 semitones (its envelope amount 0.98 takes the cutoff from 2 % to all
  of it: 12·log2 50), filter release 4.00 s, and the volume as written, −8.23 dB (then `2·P24`,
  since corrected to `P24`: *The mixer* above). Live's envelope amount stops at 72
  semitones, and past it the export keeps the peak and lets the rest rise: kept at the rest, an
  amount of 1 peaked at 6 % of the cutoff. 13 of the 68 instruments in `fixtures/rinst` pass 72 at
  modulation 0 or 1, `concertina` and `space_piano` at every modulation.
- ❗ **The filter envelope meets the engine at its peak and its sustain.** Live's envelope moves the
  cutoff in semitones and the engine's in proportion (`1 + amount·(env − 1)`, `moog.ts`), so they
  agree at two levels only; the export picks the peak and the sustain, and the peak and the rest
  when the sustain is 0 or 1. Fitted at the rest and the peak, `robot` — held at 0.58 of an amount
  of 0.98, in `Ascetic`, `Rotary` and `Voltaic` — sat at 2.3 kHz where the game holds 7.1 kHz;
  now its rest is 3.4 kHz and its swing 21.9 semitones (2026-09-29).
- ❗ **The Sampler's volume carries the ladder's passband.** Each stage of the Stilson/Smith ladder
  passes DC at 1, so its feedback `q` leaves `1/(1 + q)` under the cutoff — measured by running
  `MoogLadder` on a 110 Hz tone, within 0.1 dB of the formula. Live's Clean circuit is "the same
  as the filters used in EQ Eight" (the Live 11 manual, *Sampler*), and its passband is flat:
  measured +0.08 dB at a resonance of 0.53, an octave and more under the cutoff (below). At the
  point the note is heard — the sustain when the amplitude holds one, the peak of a pluck — the
  game takes 5.5 dB off `saw_wave`, 7.7 off `noise`, 6.0 off `ghost`, 4.1 off
  `electric_harpsichord` and 3.2 off `triangle_wave`, which the volume now does too.
- ❗ **Live's key tracking runs from key 60; the engine's from the slot's root.** The engine
  multiplies the cutoff by the playback rate (`moog.ts`), which is 1 at the slot's base note after
  `Key`. Live's `ModByPitch` at 1 leaves the cutoff at the dial on key 60 and moves it an octave per
  octave from there. So the dial carries the distance between the two, times the amount
  (`LIVE_KEY_TRACK_REFERENCE` in `als-sampler.ts`). The root is the pitched slot the track's notes
  play most (`trackingRoot`). ❌ Until 2026-10-04 the dial was the engine's resting cutoff as it
  stands. `Periastron`'s `ghost` is rooted at 48 on a track keyed +3, and it sat 15 semitones darker
  than the game: the owner heard it "too closed, too quiet" in Live. It now plays at 691 Hz, so key
  55 gets the game's 517 Hz. The same correction makes `pulse_wave` and `square_wave`, rooted above
  60, darker than they were.
- **Live's Clean low-pass, measured: the same shape at every frequency.** A sine through the
  export's Sampler at known dials, with no resonance, against the filter off. The slide and cutoff
  probes give these readings; the notes stop before the loop comes round, so they are clean:

  | sine / dial | 0.25 | 0.5 | 0.707 | 1 | 1.414 | 2 | 4 | 8 |
  |---|---|---|---|---|---|---|---|---|
  | Live (dB) | −1.8 | −3.3 | −5.3 | −8.0 | −11.6 | −15.9 | −24.5 | −31.0 |
  | the engine's `MoogLadder` at the same nominal cutoff (dB) | −1.0 | −3.0 | −5.3 | −9.2 | −15.3 | −23.6 | | |

  `dev/probe-als-cutoff.ts` put sines at 250 Hz, 1, 4 and 8 kHz under dials at 0.707, 1 and 1.414
  of each. They read −5.3, −8.0 and −11.6 at 250 Hz and 1 kHz, −5.3, −8.3 and −11.8 at 4 kHz, and
  −4.9, −7.4 and −11.1 at 8 kHz (against its own unfiltered reading, which the Sampler plays 1.25 dB
  down at that rate). So Live's dial is its −8 dB point wherever it is. ⚠️ The 0.25 column is
  from a reading the loop inflated (*How it was checked*). The filter probe's tracking rows
  (keys 36 to 84) were inflated too, and they are what first made Live's shape look
  frequency-dependent. Its key-60 row is still exactly the untracked 1 kHz. At a resonance of 0.53
  (`ghost`'s) on the cutoff, Live rises 13.9 dB over its resonance-0 reading and the ladder
  6.3 dB. With the passband compensation above, the two land within 0.7 dB of each other there.
- ❗ **The dial is where the ladder attenuates as Live does at its dial, not the same nominal
  frequency.** `liveDialHz` maps the engine's cutoff (`Params[3]²` × keytrack × envelope factor,
  0..1 of 24 kHz) to the frequency where `MoogLadder` reaches −8.0 dB. That is `LADDER_KNEE`,
  generated by `dev/ladder-knee.ts` and re-derived off its grid by a test. The ladder's knee sits
  2 semitones under its nominal value at 500 Hz, on it near 2.3 kHz, and 5 over it at 9 kHz. Mapped
  nominal to nominal, `Periastron`'s opening `pulse_wave` sweep went dark in Live up to a second
  early; the owner heard it close "too fast" (2026-10-04). Now Live's dial-equivalent follows the
  game's through the whole sweep within 0.1 semitone. Every corner of the envelope fit
  (`filterDial`) and every point's slide (`heldDial`) goes through it.
  ⚠️ **A compromise between two shapes.** The ladder is flatter under its knee and falls faster
  over it: 23.6 dB an octave up against Live's 15.9. Matched at −3 dB instead the dial would sit
  up to 16 semitones higher, matched at −15 dB up to 8 lower, and a least-squares fit over the
  knee lands between. −8 dB is Live's own definition of its dial; no dial copies the ladder
  everywhere.
- **Under Live's floor the envelope gives way.** The dial stops at 30 Hz. When the points of a
  sweeping track want less, the envelope's amount comes down instead, by the shortfall over the
  reference's heard level, and every point's heard cutoff comes down with it. `pulse_wave`
  wanted its dial near 20 Hz at the end of its sweep, and its envelope went from 72 to 65.1
  semitones.
- ❗ **The modulation's level rides on the pressure, its cutoff on the slide, note by note.** The
  engine reads every `Params` range at each note's modulation as it moves; a Sampler holds one,
  the track's commonest. Two of the moving things go back per note:
  - **The level** (`heardLevel`: `Params[24]` times the ladder's passband). The Sampler sits at the
    loudest level the track's notes reach, and each control point's pressure comes down by its
    own level against that. This is exact because Live's pressure law is linear.
  - **The cutoff where the note is heard** (`heldDial`), at the point's modulation and pitch,
    after Live's own key tracking and its filter envelope at the reference.
    The dial sits at the lowest any point wants, and the slide row (`MidiCtrl.4`) goes to Filter
    Freq at 100. Each point's slide raises the dial to its own cutoff.
  `Periastron` opens on a `pulse_wave` chord whose modulation goes 0 to 13 inside each note: its
  level 0.094 to 0.17 and its held cutoff 24 kHz down to 1.6 kHz. The Sampler held the first of
  each, and the owner heard the sweep missing (2026-10-04). Both lists follow the note's course
  (`courseOf`), with a moment at every sixteenth of modulation crossed. What the modulation gives is
  a curve in it, while Live draws per-note lists straight between points, so with the control
  points alone that sweep sat 5 semitones darker than the game halfway. Over the corpus 543 of 3,222
  tracks carry a filter slide, in 765,474 points. 32,250 of them (4.2 %) would need more than the
  slide's six octaves and stop there (`clampedSlide`); which end of a track's range they sit at is
  not counted.
- **The slide's law, measured.** `dev/probe-als-slide.ts`: the dial at 125 Hz, a 1 kHz sine, the
  slide row to Filter Freq at 100, one held slide per track, read against cutoffs with no slide:

  | slide | 0 | 16 | 32 | 48 | 64 | 80 |
  |---|---|---|---|---|---|---|
  | semitones over the dial | 0 | 9.1 | 17.2 | 27.6 | 36.3 | 46.0 |
  | `72 × slide/127` | 0 | 9.1 | 18.1 | 27.2 | 36.3 | 45.4 |

  So at 0 the dial is where it was, and 127 is 72 semitones up (`LIVE_SLIDE_SEMITONES`). 96, 112
  and 127 read past the measured curve's end, within 1 dB of the same law.
- **The filter envelope's law, measured.** `dev/probe-als-envelope.ts` holds the envelope at 1 on
  a 125 Hz dial. Amounts 12, 24, 36 and 48 read exactly as plain cutoffs of 250, 500, 1,000 and
  2,000 Hz, so `Amount` is semitones at level 1. An envelope of +24 with a slide of +12 read as
  1 kHz, so the two add in semitones. `pulse_wave`'s own setting (dial 30 Hz, Amount 67.7, sustain
  1) read 1.52 kHz against 1.50 expected, and 3.15 kHz with +12 of slide against 3.0. ⚠️ How the
  amount scales with a sustain under 1 is not read: the peak box holds the millisecond the
  envelope spends at 1 before it decays.
- **Per-note `TimeOffset` re-checked in Live's own demos**: of 249 lists in the five `Ninajirachi`
  sets, none runs past its note's `Duration` and many end exactly on it, on notes at beats 0 to
  32. It is beats from the note's start, not from the clip's.

⚠️ **The level is measured; the sound is not.** A Sampler's absolute level and its pressure law
are read off Live's meters (above). The rest is measured only to be what the file says. This Live
is a Trial that cannot export, so no Sampler here has been compared with the engine by ear or by
capture; what is unmeasured is *53* in [open-questions.md](open-questions.md).

## Measured over the corpus — `packages/lbp-tracker-lib/dev/export-als.ts`, 2026-09-24, re-run 2026-10-05

```
150 sequencers, 0 malformed
3222 tracks from 4909 parts, 3047 mixer switches, 62094 clips from 62158 placements, 953791 notes, 78647 glides, 19.3 MB gzipped
clamped: 0 keys, 582 bend points, 0 slide points; 11528 notes overlap one of their own key
```

- **3,222 tracks from 4,909 parts**, with `mergeRows` on (the default): one track per row and
  instrument, the MIDI export's own `rowGroups`, which puts the same corpus on 3,224 MIDI tracks —
  the two extra are its lanes ([midi-interchange.md](midi-interchange.md)). `This Is Halloween` is
  124 parts on 46 tracks, `Ascetic` 46 on 36. Live imposes no limit either way; what a track costs
  is an instrument to load.
- ❗ **3,047 mixer switches, and 1,368 of them go back to a part the track has already played.**
  Parts sharing a track interleave — A at cell 0, B at cell 2, A again at cell 4 — so the mixer
  steps wherever a part's note starts after another part's, not once per part. Counted twice: by
  the export, and by a separate walk of the notes on every merged track; both give 3,047. They gave
  3,056 and 1,371 while the echo send was the field itself: nine switches were between parts whose
  fields differ and whose engine sends do not. The MIDI export wrote its mixer once per part and
  was fixed for it; the measurement and the check are in [midi-interchange.md](midi-interchange.md).
- The step sits at the new part's first note. The engine fixes a voice's gain when the note starts;
  a Live track's automation moves whatever is still ringing, so a release tail that outlasts the
  switch takes the next part's mixer. Parts share a track only when their notes never overlap, so
  it is a tail and never a note.
- **78,647 notes bend in pitch.** [midi-interchange.md](midi-interchange.md)'s 88,893 counts a
  volume ramp as a glide too (`hasPitchAutomation || hasVolumeAutomation` in `verify-midi.ts`);
  counting pitch alone gives 78,647 whether the raw field or the quantised pitch is compared.
- **582 control points glide past 48 semitones** — the same 582 the MIDI steering counts past MPE's
  default — and stop at 48, since Live's per-note range is fixed. The MIDI export widens its bend
  range instead; an `.als` has no range to widen.
- ❗ **A clip is as long as its chip, notes or no notes** (the owner's rule, 2026-10-04). Its window
  runs from its cell for the chip's note grid. The file holds no grid length, so a sequencer read
  from a level gets `clipStepsFor` (`song.ts`), the editor's own load rule; the editor passes the
  `Clip.steps` the composer drew (`AlsExportOptions.clipSteps`). The window runs further only if a
  note sounds past the grid. Over the corpus that lengthened **19,352 of the 62,053 one-chip clips**;
  42,686 already ended there, their notes reaching the grid's last step.
- ⚠️ **Only 64 placements share a clip.** Live plays one arrangement clip per track at a time, so
  chips on one track whose **notes** reach into the next one's window (`endPosition + 1` past its
  cell) are merged into one clip, whichever parts they belong to, running to the later chip's end.
  A chip whose grid only covers the next one with silence is instead **cut where the next begins**
  and stays its own clip: 15 clips, 8 of them cut right where their notes end. The MIDI steering's
  "clips of one part overlap heavily" is about the 128 steps a clip *may* hold; what the notes
  actually reach rarely leaves the cell.
- ✔ **11,528 notes start while a note of the same key is still sounding on their clip, and Live
  keeps both.** 11,397 of them are inside one placement, the commonest shape (3,751) a two-step note
  re-struck by the same key one step later. A probe clip — a four-beat note with a one-beat note of
  its key on top, and that corpus shape — opened in Live with every note at its full length and the
  overlaps drawn darker, two notes lying on one another. ⚠️ This file and the page said "Live ends
  the first where the second begins" until that was looked at; it was a guess. Whether an
  instrument voices both is the instrument's affair.

## How it was checked — making Live show what the file says

`tools/open-in-live.ps1 -file x.als -shot x.png` opens the set in Live, prints the log lines about
the load, captures **Live's window alone**, and closes Live ([tools.md](tools.md)). Input sent from
the script never reached Live — a `SendKeys` Tab and `mouse_event` clicks both missed, for a reason
not looked into — so everything Live has to *show* is asked for in the file, in a debug copy:

| to see | set in a copy | measured |
|---|---|---|
| the Arrangement, not the Session view | `ChooserBar` 0 | the demo says 0 and opens on its Arrangement, the empty set says 1; ❗ **the export writes 0** |
| a track's devices in the detail panel | `HighlightedTrackIndex` = the track, counting MIDI tracks then returns | the Echo return's Delay and the Reverb return's Reverb, read above |
| a clip's notes | `ViewStateDetailIsSample` true, the set's `TimeSelection` over the clip, the track's `IsContentSelectedInDocument` true | `Ascetic`'s `cell 41`, sixteen A#3s at velocity 47 |
| the clip's MPE | and the track's `PreferredContentViewMode` 2 | the Note Expression tab: each note rising in a line and holding, pressure ramping and holding, slide flat — exactly the file's `0:0 0.25:512` pitch (+3 semitones), `0:47 0.25:96` pressure and zero slide |
| envelopes on a track without an instrument | one of the track's envelopes pointed at the master's tempo | Live shows the envelope's opening 99.00 over the fader's 180, with the automation marker |
| how loud a Sampler plays | `packages/lbp-tracker-lib/dev/probe-als-level.ts` writes the whole set: one sustained sine per track at a known pressure, the master at −inf, the Session view, the transport looping | **someone presses Play**; each track's peak box is the reading, against the expectation the script prints. The pressure law and *Vel → Vol* above |
| where a Sampler's filter sits | `dev/probe-als-filter.ts`, on the same frame (`dev/als-probe.ts`): cutoffs around the sine, the resonance, and key tracking on five keys | the curve, the passband and the key-tracking reference above |

⚠️ **Read the peak boxes against each other, or before the loop comes round.** The note lasts
exactly the loop. At each restart the new note starts while the old one is still releasing, and
the held peak takes their sum. On 2026-10-04 the filter probe's unfiltered track read −3.63 dBFS
against the −8.52 it read before the loop first wrapped, and every track rose alike.

❌ **Two ways of making Live play by itself failed.** A space key posted to Live's window
(`PostMessage`) left the transport where it was. A Max for Live recorder on the master, hand-written
XML around an unfrozen `.amxd`, crashed Live 11.3.43 at load (`Fatal Error: Unhandled exception`
in its log, 2026-10-04). Live itself plays and meters fine; it just needs a person to press Play.

⚠️ **Capture the window, never the screen.** The first capture of this work was a full-screen grab,
and it took whatever else was open on the owner's desktop instead of Live. `PrintWindow` on Live's
own handle cannot.

⚠️ This Live is a Trial whose saving and export are switched off (its status bar says so), so a set
cannot be re-saved by Live to see what Live would write, and nothing can be rendered to audio.

⚠️ **Count tracks, not parts.** `MidiExportResult.parts` counts parts; reading it as MIDI tracks once
made `mergeRows` look inert — 124 "tracks" for `This Is Halloween` with it on and off. Count the
`MTrk` chunks, or `AlsExportResult.tracks`.

## What the set does not carry

- **The sounds, unless asked for**: with the instruments off the tracks have no device; on, a
  Sampler as above.
- **Per-note modulation**, with the instruments on, beyond the level and the cutoff (above): every
  other `Params` range is read at the modulation the track uses most. That covers the envelopes'
  shapes, the resonance, the key tracking's amount and the drive. Over the corpus
  (`LBP_ALS_INSTRUMENTS=1`): 3,222 of 3,222 tracks got a Sampler, 105.7 MB of samples, and
  **44,787 notes (4.7 %) sit at another modulation**. A part in another `Key` than its track's is
  no longer a loss (the raw note, above).
- **The unison stack, the three LFOs, the mip levels and the ladder's saturation.**
- **A glide past 48 semitones**, which Live's per-note range cannot hold.
- **The game's reverb and echo themselves**: the returns hold Live's, set as above.
