# What our MIDI file carries — every side channel, and what it costs

Read before changing `packages/lbp-tracker-lib/src/midi.ts`, and before adding a field to
`Sequencer` or `Track`. `smf.ts` underneath it is the container only — chunks, variable-length
quantities, running status — and `packages/lbp-tracker-web/src/daw/convert-view.ts` is the view.
`partKey` and `partLabel` in `midi.ts` are shared with the Ableton export, so changing what a part
is or what its track is called changes both files ([ableton-interchange.md](ableton-interchange.md)).

A MIDI file can say *notes*. A music sequencer is a board of placements with a mixer, two sends, a
key, a scale and per-record automation, and most of that has no MIDI message at all. So the file
we write is two things layered: **the music, in ordinary MIDI events that any DAW plays**, and
**everything else, in text meta events that any DAW ignores**. This file is the inventory of the
second layer and the measurement of the whole.

Every number here comes from `packages/lbp-tracker-lib/dev/verify-midi.ts` over the ten-level corpus
(149 sequencers, 62,158 clips, 953,791 notes, 1,448,224 records — [cwlib's level-files.md](../../cwlib-ts/steering/level-files.md)),
last taken 2026-09-24. Run it after touching either file; `LBP_MIDI_BUDGET=1` adds the byte
table below.

## The result: the round trip is exact, and MIDI alone is close

```
62,158 clips, 1,448,224 records: 0 came back different
54 clips carried verbatim, 0 unpatchable, 24.1 MB
22,188 chips tinted away from their instrument's own colour: 0 came back different
the mixer as a DAW plays it: 0 of 953,791 notes under another placement's level, pan or send
```

It is a **fixed point from the first trip**: three round trips give the same record count and the
same byte count, with all 149 sequencers identical between trip 1 and trip 2. The music comparison
reads 0 sequencers disagreeing, worst deviation pitch 0.000, volume 0.000, modulation 0.000 —
because the records themselves come back.

Four things got it there, in the order they were found: **byte 3's resting bit** (below — dropping
it made 78% of clips come back different); **the order records are written in** (position
ascending, then pitch descending on 27,124 of 27,124 tied clips, then the end ascending — sorting
on position alone left 1,944 clips holding the right notes in the wrong order); **a repeated value
is a control point** (below); and **a verbatim record patch for the remainder** — 54 clips of
62,158, 15 kB, 0.063% of the file.

`LBP_MIDI_LOOSE=1` turns the patch off and measures MIDI alone — what a reader that ignores our
metas hears, and what the file degrades to if a DAW edits it:

| lost without the patch | how much | why |
|---|---|---|
| which clip a note sat in | 54 clips of 62,158 hold a different set of notes | clips of one part overlap, so a few notes fit two of them and either answer puts them at the same place on the timeline — *24* in open-questions.md |
| coincident control points | 302 notes (0.03%) | two records on one position collapse to the later, which is what the engine's `t = span > 0 ? … : 1` does |
| pitch and volume resolution | within half a unit — worst 0.167 semitones and 0.467 (it read 0.500 on 2026-09-10; the committed exporter of 2026-09-24 gives 0.467 too, so the drift predates the mixer change) | bend is rounded to whole semitones and positions to thirds of a step, which is the record grid |
| `Scale`'s own pitch field | 0 placements in the corpus set it | folded into the note numbers so the file plays anywhere; `unquantise` picks the lowest note that snaps to the one written, which always *sounds* right. `Key` is exact — a transposition is invertible where a projection is not |
| a glide, to a shared channel | **0** | fifteen member channels against thirty-two voices, and lanes hold the difference |
| `timbre` bits 4-5, volume > 127 | 0 in the corpus | MIDI has seven bits for either; both ride in the patch for free, and `test/midi.test.ts` is the only place either is exercised |

88,893 notes (9.32%) carry a glide and **none loses it, even in the MIDI events alone**.

⚠️ **The two settings are two products, and `MidiExportOptions.exact` chooses.** `LBP-SEQ` and
`LBP-TRK` describe the *placement* and stay true however the notes are edited. A patch describes
the *records*, so a DAW that edits the notes leaves it stale and the import hands back the original
clip rather than the edit. Off is right when the file is going somewhere that will change it, and
the page says so. **The importer trusts the patch over the note events**, which is why
`flattened`, `dropped` and `dragged` describe what a *foreign reader* loses, not what a round trip
loses.

⚠️ **`Track.records` is the file's own bytes and `Track.notes` is not a re-encoding of them.**
`makeNote` sorts a chain into position order and real files do not always store it that way —
`Wayward` writes step 28 before step 23 with the end flag on the second — so re-encoding a note can
move the end flag into the middle of the chain. Every byte-level comparison goes through `records`;
the first version of the diff did not, and it invented 66% of notes diverging and a 4 MB patch.

## The budget — where 24.1 MB of corpus goes

`exact` on, which is what the page writes. ❗ **Measured by `LBP_MIDI_BUDGET=1`, 2026-09-24**, and
exact rather than estimated: `writeMidi` never uses running status, so an event costs
`varLength(delta) + data.length` and the rows add up to the file. The two fields that are not
events of their own — `fix` and the tint, both inside a `LBP-TRK` meta — are weighed by
re-serialising the meta without them.

| carrier | share | events |
|---|---|---|
| pitch bend — the glide | 24.80% | 1,468,357 |
| CC 74 — the modulation | 19.70% | 1,188,476 |
| note off | 16.78% | 953,791 |
| channel pressure — the volume | 16.11% | 1,294,870 |
| note on | 15.81% | 953,791 |
| **`LBP-TRK` meta** — placement and cells | **5.42%** | 4,911 |
| **`LBP-TRK` `colour`** — the chip tint | **0.34%** | 4,911 |
| track name meta | 0.32% | 3,373 |
| CC 7/10/90/91 — the mixer | 0.28% | 17,022 |
| **`LBP-SEQ` meta** — the sequencer | **0.14%** | 149 |
| tempo, time signature, end of track | 0.07% | 3,671 |
| **`LBP-TRK` `fix`** — verbatim records | **0.06%** | 17 metas |
| RPN / MPE configuration | 0.02% | 1,341 |

**The side channels are 6.28% of the file**, and 0.12% more is track headers and End of Track.
Three quarters of that is the cell list, which is what gives a level its board back.

⚠️ **This table used to be an ad-hoc count and several of its rows had gone stale** — 5,060 track
names for a corpus that merges down to 3,373, and a note-on and note-off share that were equal
when the deltas are not. It is a script's output now, and re-running it is one environment
variable.

## The ordinary MIDI

| what | carrier | note |
|---|---|---|
| pitch, and the glide | note number + pitch bend | MPE: one channel per sounding note, so the bend is the note's |
| volume, and its ramp | note-on velocity + channel pressure | ⚠️ the OPENING volume rides on the pressure at the note's own tick, because MIDI has no velocity 0 and `Northern Lights` opens 96 notes there |
| modulation, and its ramp | CC 74 | the 4-bit nibble ↔ 7-bit controller map is exact over all sixteen values, and `test/midi.test.ts` checks every one |
| the zone | RPN 6 on the master, RPN 0 for the range | MPE lower zone, master channel 1, members 2..16 |
| the mixer | CC 7, CC 10, CC 91, CC 90 on the master channel | level, pan, reverb send, echo send — so a DAW plays the level's own mix |
| the grid | 480 PPQ, 4 steps to the quarter | ⚠️ 480 is what makes a third of a step exactly 40 ticks — triplets land on a tick instead of between two |

⚠️ **CC 90 is undefined in the specification, and that is why it was chosen.** A delay send has no
controller anywhere in MIDI: 91 is reverb, 92 tremolo, 93 chorus, 94 celeste/detune, 95 phaser.
94 was tried first — some synths read it as a delay depth — and dropped, because many more read it
as detune, and a value landing on the wrong one is audibly wrong rather than merely ignored. 90
sits in the undefined block (85-90): a reader that does not know it ignores it. **Inert everywhere
beats right sometimes and wrong the rest.** That is a judgement, made deliberately, and recorded as
one so nobody mistakes it for a fact out of the game.

⚠️ **The bend range is picked from the music, not fixed at MPE's 48.** 582 of the corpus's
1,448,224 control points glide further than 48 semitones and the widest is 62; nothing reaches 96,
MIDI's own ceiling. A fixed 48 clamped 1,026 of them, and a clamped bend is a note that arrives at
the wrong pitch.

### The channel allocation

Every part gets all fifteen member channels: a DAW that imports a format 1 file as one project
track per MIDI track gives each track its own instrument, which only ever sees its own track's
events (Reaper does this). The file is written for that reader; `splitSequencerToMidi` is the
option for one that cannot promise it.

A part whose own polyphony passes fifteen is written across several MIDI tracks — `laneOf` — that
carry the same identity so the import merges them. It cost **2 extra tracks across the whole
corpus** (5,058 → 5,060) and took the clip count to exact.

⚠️ **The order notes are allocated in is what keeps glides whole, and it is not obvious.**
Allocating in plain time order let a flat note take the last free channel a moment before a gliding
one needed it: 3,593 notes lost a glide where only **1,172 ever arrive while more than fifteen
glides are already sounding**. `sequencerToMidi` allocates in two passes — the notes that need a
channel to themselves first — and falls back through a channel nobody is bending, then the master
channel (which MPE allows to carry notes and where nothing is ever bent), then a channel whose
glides all began earlier, and only then gives a glide up. ⚠️ **The master goes before the
earlier-glide case, not after**: our own importer knows whose a bend is, a synth does not, and the
master is the one placement that cannot be dragged. Deciding is a separate step from writing,
because displacing a glide has to be able to reach a note placed earlier.

**30 notes of 953,791 still share a channel**, and the polyphony count does not predict them: a
channel is held for a note's whole life, so **one long note can pairwise overlap fifteen short ones
without three ever sounding together**. Measured at the moment it happens: 1-2 concurrent, 14-17
booked ahead, and every one of the 30 is a FLAT note — so `dragged`, `timbred` and `flattened` are
all 0. ⚠️ Report `dragged`, not `sharedChannel`: the raw sharing count implies a damage that is not
there.

## 1. `LBP-SEQ ` — one text meta on the conductor track

Meta type `0x01`, the tag then JSON. **Only what MIDI has no message for**:

`v` · `uid` · `swing` · `swingBaked` · `echoFeedback` · `echoTime` · `echoMix` · `reverb` · `loop` ·
`startPoint` · `numChannels` · `volumes` · `boardRows` · `author`?

⚠️ **`author` is not FF 02.** A MIDI file has a *copyright notice* meta, which is the nearest
standard carrier and the wrong one: writing a PSN handle there states something about rights on
somebody's behalf that the game's file never said. It rides here, and only when the sequencer
names somebody ([cwlib's export-to-game.md](../../cwlib-ts/steering/export-to-game.md), *The author*).

`boardRows` is the clearest case for the rule: MIDI has no circuit board, and the board's height in
cells is what bands a track to a mixer channel (`channelVolume`, *9* in answered-questions.md).
Drop it and a re-imported file routes every track by the fallback modulo instead — a different mix,
silently. `test/midi.test.ts` pins the field list, so adding a field to `Sequencer` and forgetting
it here fails there rather than in a DAW six months later.

**Five fields were removed because MIDI already says them**, and the rule they taught is worth more
than the 12 kB: **a duplicated field is a field that can disagree with itself.**

| was in the header | says it instead | why it had to go |
|---|---|---|
| `name` | the conductor's track-name meta | ❗ write the REAL name, empty or not — 10 of the 149 corpus sequencers have none, and a friendly default would rename them on the way back |
| `tempo` | the tempo event | ⚠️ **it was an actual bug**: exported at 120, re-tempoed to 174 in a DAW, imported at 120, because the meta won |
| `bendRange` | RPN 0 on a **member** channel | ❗ not the master's, which is a different and smaller range — ours writes 2, and reading that one would flatten every glide by 24× |
| `mpe` | the MCM, RPN 6 on the master | already the fallback; now the only source |
| `stepsPerQuarter` | nothing | written and never read |

⚠️ **The tempo message stores microseconds per quarter, so it is not a float you get back.** 174
BPM reads as 173.99979 and the field would drift on every trip. The import asks which whole BPM
encodes to exactly the microseconds in the file and takes that one; all 149 corpus tempos are whole
(70..240), and a genuinely fractional tempo keeps its fraction to within 1e-4 BPM.

## 2. `LBP-TRK ` — one text meta per part track

`guid` · `instrument` · `gridY` · `level` · `pan` · `echoSend` · `reverbSend` · `key` · `scale` ·
`colour` · `clips` · `name`? · `names`? · `colours`? · `rest`? · `lane`? · `fix`?

A `clips` entry is `[gridX, steps]`, `[gridX, steps, rest]` or `[gridX, steps, rest, bitmap]`.

### `colour` — the chip's tint, which MIDI has no message for at all

`PInstrument.Colour`, packed RGBA ([cwlib's sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md)). There is
no controller for a colour and a CC would be the wrong tool anyway — seven bits of one, and a
synth would act on it — so it rides in the meta and nowhere else. **Measured 2026-09-10 over the
ten-level corpus: 22,188 of 62,158 chips carry a colour that is not the one their instrument
ships with, and dropping the field brings back every one of them wrong.** It costs 82,993 bytes,
**0.34%** of the 24.1 MB export, and `dev/verify-midi.ts` reports the tints that come back
different and fails on any.

It is written for **every** part rather than only where it differs from `factoryColour`, and that
is a deliberate 50 kB: the cheaper form makes the file unreadable without our own instrument
table, which is the trap the `instrument` name beside the GUID exists to avoid. A file that says
nothing — a DAW's own — leaves the chip on `factoryColour`, the same rule a chip drawn on the
board follows.

⚠️ **A part is a group of placements that share a mixer, and the tint is not in that key**, so
`colours` maps `gridX` to the tint of each clip that disagrees with the part's — exactly as
`names` does for the Thing's label, and for the same reason. Putting the tint in the grouping key
instead would have split parts and changed every count in this file for a field nothing plays.

### What a DAW can edit, and what it cannot

Audited by making each edit to an exported file and re-importing it. **The rule that came out of
it: a value with a MIDI message of its own must not have a second copy in a meta that wins.** Three
fields failed that and were fixed; all ten edits survive now.

| edit | how |
|---|---|
| rename the song | the conductor's track name is the only source |
| move a part to another row | it is in the track name; there is no MIDI message for a board row |
| change a part's instrument | ⚠️ cannot be a program change — 7 bits against a six-digit GUID. It is in the track name, and `midiToSequencer`'s `instrumentGuid` resolver turns it back |
| change the tempo | the tempo event wins (it used to be overwritten by the meta) |
| transpose the notes | `Key` is undone by subtraction, and a transposition composes |
| move the notes in time | the cell list re-fits them; notes outside every declared cell open a new clip |
| level, pan, both sends | CC 7, 10, 91 and 90 (they used to be ignored); a fader move comes back |

❗ **The mixer needs BOTH the controller and the meta, and a rule for when they disagree.** Seven
bits cannot hold the editor's steps: over 62,158 placements `level` is exact at 7 bits on 70.2%,
`echoSend` on 96.4%, `reverbSend` on 80.5% and **`pan` on 8.9%** — the values are round decimals
(0.25, 0.35, 0.46). So the meta keeps the exact number and the controller wins only once it stops
agreeing with it, the same rule the tempo uses. ⚠️ **CC 7 carries `level` alone, not level times
the channel volume**: folding the mixer stage in would make it un-invertible, and 308 of the
corpus's 338 sequencers run one channel at a uniform 0.75 — a constant, not a balance.

### The track name is `row 4 - saw_wave`

Two of a placement's fields have no MIDI message at all — the board row, and the instrument (bank
select could be abused into 21 bits, but a DAW would then show "bank 1009, program 61"). Both are
in the track name, which is the one thing about a track a DAW always lets you edit.

❗ **The label is cosmetic; the meta is the carrier.** Everything the label says is in the meta as
well — `gridY`, and the instrument's `instrument` name beside its `guid` — and the label is read
only to see whether it says something **different**. Measured: every part-track name stripped from
the corpus's exports, **62,158 clips of 62,158 still correct**. Carrying the name beside the GUID
closed a real hole: before it, any resolver hit overrode the GUID, so a manifest that mapped
`saw_wave` to a different GUID silently changed the instrument on a file nobody had touched. A
renamed instrument still needs the caller — only the `.rinst` manifest knows what `piano` is, and
`instrumentGuid` is that map read backwards; without one, or with a name that resolves to nothing,
the meta's GUID stands, because **a typo in a track name must not silence a part**.

⚠️ **The label carries the INSTRUMENT, never `Track.name`.** `Track.name` is the Thing's own label,
carried by 4,353 of the 62,158 placements (7.0%) — but only 23 distinct strings, the editor's own
defaults (`Synth: Ray Gun`, `Percussion: Acoustic Kit 1`). It rides in the meta, where nothing else
claims it; 7 parts of 4,909 hold clips whose names disagree, so the meta carries a per-clip `names`
map as well.

❗ **A label names two of a placement's eight fields, and half the corpus needed more**: 2,539 of
4,911 part tracks (51.7%) shared a label, separated by level (466 groups), pan (444), the reverb
send (391), the echo send (195) and the key (10) — `Ascetic` has `row 0 - baiyon_drums_1` twice, the
same kit at pan 0.60 with no reverb and at 0.30 with 0.20 of it. A `#2`, `#3` index settles it; the
mixer is on the controllers, so a DAW already shows what differs. A lane's track is
`row 3 - saw_wave (2)`, and the meta says which lane it is, so what to strip is known exactly.

### One track per row — `mergeRows`, on by default

**4,911 tracks become 3,224**: every placement of one board row and one instrument goes on a single
track, with one `LBP-TRK` meta each and the mixer written as **CC automation that steps wherever
one placement's note starts after another's** — which is what a DAW does with a mixer that changes
during a song. The invariant is that **at every note, its own placement's dials are in force**. It
stays exact: the import hands each note to whichever placement declared the cell it falls in — **no
two placements of a row group ever share a cell**, 0 of 62,158 — and reads each placement's
controllers *in force* at the first of its notes that no other placement's cells also claim. Placements *sounding at the same time* are not merged (one track has
one mixer state), and over the corpus that is 2 row groups of 850, which is what makes merging free.
⚠️ Overlapping is a clip started at an earlier cell still sounding when a later one begins — a cell
is 16 steps and a clip may hold 128 — not two Things in one place.

Two traps, both caught by the corpus rather than by reading the code: **the mixer was read before
`clips` was parsed**, so every placement looked like it began at cell 0 and the second one on a
merged track read the first one's pan (0.598 instead of 0.3); and **"the value at that tick" is
the wrong question** — the exporter skips a controller whose value has not changed, so the value
*in force* is what to read.

⚠️ **A round trip that is exact can still play wrong in a DAW, and this one did until
2026-09-24.** The controllers were written once per *part*, at its first cell, and parts sharing a
track interleave: A at cell 0, B at cell 2, A again at cell 4. The import read the value in force at
each part's first cell and was right; a DAW played A's cell 4 on B's mixer — **65,345 of the corpus's
953,791 notes, in 102 sequencers**, all on merged tracks, with another part's level, pan or send.
Nothing in the round trip could see it, so `verify-midi.ts` now reads the file the way a DAW does
(`misMixed`: the CCs in force at each note-on against the placement the note came from) and fails
on any; it reads 0 now, and 65,345 with the old exporter swapped back in. It cost 1,709 controller
events, the mixer's share going from 0.26% to 0.28% of the file. The Ableton export steps its
mixer the same way ([ableton-interchange.md](ableton-interchange.md)).

⚠️ **With the steps at the notes, the first cell is the wrong place to read.** A part's first
cell can still be under the part before it, whose note is sounding there or starts there; read
at the cell, the controller disagreed with the meta and won. The import reads at one of the part's
own notes. A placement with no notes reads the meta alone: nothing of it sounds, so no controller
on the track is its.

❗ **The tracks come out in board order**, row ascending then cell then GUID. `gridY` is the
Thing's own y negated, so row 0 is the top of the board and ascending reads top to bottom, the way
the sequencer draws it. ⚠️ The level's own order is not board order: of 149 sequencers exactly one
already had its tracks ascending.

### `clips` — the board layout, and why the length is there

MIDI has no controller for "this note belongs to that clip", and a CC would be the wrong tool
anyway — seven bits, and a synth would act on it. ⚠️ **The cell alone is not enough — the LENGTH is
what makes it recoverable.** On cells alone **86.50% of the corpus's notes fit more than one clip**;
adding each clip's own extent takes that to **0.09%**, for one number per clip. ⚠️ **Emit every
declared cell, including the empty ones**: 52 corpus placements hold no notes at all — an
instrument dropped on the board and never written in — and nothing else in the file can bring one
back. Skipping them made the count 62,106 rather than 62,158, and it looked like an ambiguity
rather than the omission it was.

### `rest` — byte 3's inert bit, per part, per clip, and per record

The editor writes a resting value into byte 3's bit 6 that the engine never reads
([cwlib's sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md)). A third element on a `clips` tuple overrides
the part's value; omitted when it is 1, which is what the current editor writes. Inert to the
engine and still a fact about the file: dropping it made 78% of clips come back different. A fourth
element is a **base64 bitmap, one bit per record**, for the 31 clips that mix the two values — 93
bytes over the whole corpus, replacing what used to be the largest family in the verbatim patch.
⚠️ It is the one channel here that *degrades* rather than breaks: a DAW that edits the notes
misaligns it, and what lands on the wrong record is a bit the engine never reads. A run length
would have been the obvious encoding and the data refuses it: only 11 of the 31 are two runs, the
rest scatter over as many as eleven (`10110111111111111010101111` is a real one).

### `fix` — the records MIDI could not say, base64, by `gridX`

The exporter imports its own output, compares clip by clip through `Track.records`, and writes the
originals for the ones that differ. **54 clips of 62,158**; every clip in it is one family — a note
that fits two of a part's overlapping clips and went to the other one — and six tie-break rules have
already been measured against it (*24* in [open-questions.md](open-questions.md)). Carrying every
clip we could not *prove* would cost 22% of the file; carrying only the measured residue costs
0.063%. **A self-verifying export is what makes the side channel cheap.**

⚠️ **This is the only side channel that describes the notes rather than the placement, and the
only one that can go stale.** Edit the notes in a DAW and the import hands back the original clip
instead of the edit — which is what `exact: false` is for.

## A repeated value is a control point

The rule is one sentence: **the resampler never sends the same value twice, so a message carrying
the value already in force can only be a control point.** A rounded ramp is a staircase, so
resampling naturally produces runs of equal values; suppressing them costs a receiver nothing, and
it is what makes a deliberate repeat readable. The exporter emits one repeat wherever a control
point sits in a flat run of three, and `simplify` never drops a point the file stated outright.
That took the patch from 352 clips to 177 and made the whole file *smaller*.

Two traps, both found by the numbers moving the wrong way:

- **Marking every stationary point** rather than only those inside a flat run cost half a megabyte
  to save forty kilobytes of patch — 281,000 markers where 8,600 were needed. A point where a flat
  run meets a moving one is a corner and the simplifier keeps it anyway.
- **De-duplicating the event that OPENS a moving segment** took the patch from 352 clips to 1,077.
  That event states where the ramp begins, which is usually where the plateau before it ended; a
  note that sat at 96 for two steps and then faded came back fading from its first frame. `k === 0`
  is exempt — and so is `k === steps`: a resampled ramp reaches its final value one or two thirds
  *before* the control point the author wrote, and suppressing the last sample left the end
  unstated (`17:57 → 31:46` came back as `30+2/3:46`).

**Douglas–Peucker prefers a whole step at a near tie** (`WHOLE_STEP_BAND`, within one unit of the
field's own tolerance — the size of the rounding itself, not a fitted number), because authors
write on steps and the exporter resamples onto thirds. ❗ **Neither this nor the segment end is
worth anything alone**: the segment end alone moves the patch by 0 and the tie-break alone by 3;
together they are worth 24. A fix that measures as worthless may be half of one.

Three more things MIDI turned out able to say, each of which came out of the patch:

- **A coincident pair states both volumes**, as it already stated both pitches and both
  modulations — `Jarred` writes a note as pitch 48 at volume 27 and pitch 75 at volume 96 on one
  step; nothing hears the first, but it is in the file. ⚠️ **The jumped-to pressure has to sort
  AFTER the note-on and `rank` cannot see the difference**: pressure ranks 2 against a note-on's 3,
  so the exporter marks the event. CC 74 escaped this only because it shares rank 3.
- **A coincident pair's first modulation is not authoring debris**: `voice+0x28` is read once at
  voice start for `Params[0..2]` before any ramp runs, so it travels as two CC 74s, one before the
  note-on and one after — which is what the engine does and what a synth wants.
- **Which record of a chain carries the end flag is not information**: it delimits the chain, and
  `makeNote` sorts a chain anyway, so `sameNotes` masks the flag and compares the chain as a set.
  Order *within* a chain still counts — a chain stored out of position order puts its end flag
  somewhere else, which is a real difference — so `sameNotes` keeps each chain's bytes verbatim
  rather than going through `groupNotes`.

## The traps the round trip found on the way

Each was found by measuring, and none was where it looked:

1. **The pitch was rounded to a whole semitone before the simplifier saw it**, turning the ramp the
   file drew into a staircase whose treads the simplifier then kept. Keeping the fraction until a
   record is written took 2,432 differing notes to 592 and the worst pitch deviation to 0.
2. **Coincident points were collapsed everywhere**, which erased the segment *leading into* one: a
   dive in `Diode` that arrives and snaps back came out flat. The collapse belongs only at the
   note's own start, where both samples would land on the note-on's tick.
3. **`needsChannel` did not count the modulation.** A note whose pitch and volume are flat but
   whose modulation moves was allocated as flat — 608 undeclared notes. CC 74 belongs to the
   channel exactly as bend and pressure do.
4. **A newcomer's CC 74 was landing on the owner's ramp**, and the first fix was one event too
   greedy: excluding the whole tick threw away the owner's own final ramp sample whenever a note
   started on the instant a ramp ended (three notes in `Orb` and `Blackfire`). It is the **last**
   CC 74 before the note-on that belongs to the newcomer, not every one at that tick.
5. **The verifier was measuring the wrong things, repeatedly — the note pairing most often.** It
   compared the first record's modulation rather than the one the note sounds; its pairing cost
   ignored the modulation, so it paired notes that differ only in their filter at random and
   reported 458 casualties where a diagnostic costing all three found none; and its greedy walk
   crossed a flattened note with an intact sibling. ⚠️ Levels place the same hit on two components
   (`Partykill` has the same note twice at step 4308), so the pairing takes **exact matches first**
   and only then matches what is left by cost; and its key stays loose — step and pitch — because
   MIDI has no velocity 0, so a note that opened at 0 comes back at 1. The phantom counts, in
   order: 142 sequencers, 458 notes, then 8. None was real.
6. ⚠️ `verify-midi.ts` checks the note count against a **range** rather than `before − dropped`,
   because a dropped note comes back through the patch and the equality blamed `Avian` for a note
   that had already been restored.

⚠️ **The general rule, learned the expensive way**: the shape of an exact converter is not more
MIDI, it is a bigger side channel — but a side channel is only affordable if the exporter *checks*
rather than assumes. Every attempt to carry a category wholesale priced itself out (22% for the
records, 0.5% for a per-clip flag written unconditionally); every attempt that carried only the
measured residue cost under 1%. And "do not write a byte-equality test against a round trip; it
will fail for reasons that are correct" was true until the reasons were enumerated one at a time
and carrying them as data became cheaper than carrying the argument.
