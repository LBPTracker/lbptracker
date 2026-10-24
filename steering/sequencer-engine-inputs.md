# What the engine takes from a sequencer — `RInstrument`, the clip, and the game's limits

The parts a level carries — `PSequencer`, `PInstrument`, the note record, the circuit board — are
read by cwlib, and their schemas are `../../cwlib-ts/steering/sequencer-data-model.md`. This file is
the other half: what the engine makes of the sampler patch — whose layout and reader are cwlib-ts's
([sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md), *`RInstrument`*; `@lbptracker/cwlib/rinstrument.ts`) — and what the game does with the parts once it
has them — the clip it builds per placement, `Key` and `Scale`, the board's size limit and the
sequencer's thermometer. Addresses are **vaddrs** in the eboot; [eboot-re.md](eboot-re.md) has the
conventions. What the engine then does with the clip is [synth-engine.md](synth-engine.md).

## What reaches the engine from a placement — the clip filler `v0x1607c0`

The eboot builds one `0x470`-byte clip per placement (`PInstrument` in `rdi`, the clip in `rsi`),
and it is worth having field for field:

| clip | from | what |
|---|---|---|
| `+0x00` | `Notes.count` | how many records |
| `+0x04` | `+0x20` | `Colour` |
| `+0x08` | `+0x24` | `Loops` |
| `+0x0c` | `+0x2c` | `Scale` |
| `+0x10` | `+0x28`, as `key < 12 ? key + 12 : key` | the root the engine adds after quantising |
| `+0x1c` | `+0x60` | the bound a record's step is compared against |
| `+0x20`… | `Notes[]` | the records, with **bits 28..29 cleared** (`and edi, 0xcfffffff`, `v0x1608bd`) |
| `+0x420` | `+0x30` | `Level` |
| `+0x424` | `+0x34` | `Pan` |
| `+0x428` | `2 × (+0x38) − 1` | `EchoSend` as a bipolar offset |
| `+0x42c` | `+0x3c` | `ReverbSend` |
| `+0x430` | (written by `v0x1c4420`) | the instrument index |

✔ So **one instrument, one level, one pan, one echo send and one reverb send per clip**, which is
what `Track` has always carried. ⚠️ The function has a second loop (`v0x160860`) for a
caller-supplied note array that rewrites bits 8..14 as `(95 − y) & 0x7f` (constants 96.0f at
`v0x1062e10` and −1 at `v0x1062e14`) — an editor-side y-coordinate form. **It is unreachable from
a level**: the filler's only caller, `v0x1c449b`, passes `rdx = 0`, so the file's `Notes` reach the
plugin with nothing but bits 28..29 cleared, and the stored `y` **is** the note.

## `RInstrument` — what its fields mean to the engine

The resource's layout — field order, counts, member offsets, the serialiser at `v0xc68a70` — is
cwlib-ts's, with its reader
([sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md), *`RInstrument`*).
This is what the values mean once the engine has them. The 27 `Params`, each a range `(x, y)`, are
all named in [synth-engine.md](synth-engine.md).

**Measured across the game's 68 `.rinst` files** (`tools/ExtractGuid.java` pulls them out; every
one parses exactly in cwlib-ts's `test/rinstrument.test.ts`):

- `Splitnotes` is **descending** and `splitNotes[0]` is **87 in every instrument**; unused trailing
  entries are 0. Slot `i` covers `splitNotes[i+1] <= note < splitNotes[i]` — each bound belongs to
  the zone **above** it, the comparison is strict, and the walk is the engine's own
  ([synth-engine.md](synth-engine.md), checked over 68 × 128 notes with no disagreement). ⚠️ The
  **zone count is the number of leading non-zero bounds**, not the number of slots holding a
  sample: `conga`, `djembe`, `dumbek` and `ukulele` carry spare slots (six bounds against seven
  samples), and `mime_artist` has one bound and four samples. Zero corpus notes change slot under
  either count, but the wrong one shows up as phantom unreachable slots; the real one leaves exactly
  one — `ukulele`, bounds `87,60,40,40,16,12`, a genuinely empty zone in the game's own data.
  ⚠️ **Do not score the zone rule on "does a zone contain its own base note"**: that ranks voicing
  styles, not rules — `guildford` centres its samples, `piano` sets every bound ~6 semitones below
  its slot's base so that it always transposes downward, and both are the same rule.
- ⚠️ **`Numstack` is not the number of slots in use** — it matches the used-slot count in only 14
  of 68 (`electric_piano` uses one sample with `Numstack` 2, `ghost` one with 3, most 8-slot kits
  carry 1). It is the number of overlapping copies of the **same sample** a note plays, at most 5;
  a stacked voice never reaches a second slot. To find the slots that exist, test
  `SampleGuids[i] != 0`.
- `basenote` **is a MIDI note number**: the piano's five slots read 84, 72, 60, 48, 36 and its
  `SampleGuids` resolve to `piano_c6` … `piano_c2`. And it is in the same numbering as `Notes.y`
  and `Splitnotes` — the toolkit annotates `Splitnotes` as piano-key numbers, 20 apart, and the
  corpus refutes it: 188 of 249 zones contain their own sample's base note against 48 of 249 with
  the shift, and the median of (note played − base note of the slot it resolves to) over 953,221
  notes is **0**, with per-instrument medians scattering from −18 to +28 — a numbering mismatch
  would be one constant on every instrument (`packages/lbp-tracker-lib/dev/pitch-probe.ts`).
- 68 instruments, 47 multisampled, 274 pitched slots against 4 unpitched, and **not one** with
  `fitbpm` set.

## The sample slot — `finetune`'s unit

The slot's layout — 16 bytes, stream order not member order, `fitbpm` written twice and no third
bool — is cwlib-ts's
([sequencer-data-model.md](../../cwlib-ts/steering/sequencer-data-model.md), *The sample slot*).

**`finetune` is in semitones**: the engine adds it into the same sum as the note and the root note
before the one division by 12 (*5* in [answered-questions.md](answered-questions.md)). The corpus
agrees — the 23 distinct non-zero values run −0.17 … +0.56, an ordinary fine-tune range read as
semitones and five-thousandths of one read as cents.

## The playback formula that follows

```
slot         = the zone whose bounds contain `note`                  (the strict walk, synth-engine.md)
ratio        = 2 ^ ((note + slot.finetune - slot.basenote) / 12)     # semitones throughout
if !slot.pitched:  ratio = 1                                         # percussion
if slot.fitbpm:    ratio *= sequencer.Tempo / slot.basebpm
playbackRate = ratio * (sample.rate / outputRate)                    # every .smp is 48 kHz
```

Every term is measured in [synth-engine.md](synth-engine.md); the shipped samples are laid out the
way it describes — `piano_c2` … `piano_c6`, one sample per octave, exactly the shape `basenote` +
`Splitnotes` implies.

## The board's size limit

The editor's resize clamps the board before it snaps it (function
around `v0x169940`–`v0x169c47`, read 2026-09-21 with `lbpdis.py`; found by scanning the image for
`25 × 105` as a float — 24, 26, 30, 32, 40, 50 and 64 rows have no such constant at all):

```
cap  = (26250, 2625)  grid = (52.5, 105)     bit 37 of the Thing's part mask set     v0xe5c9c0, v0xe5c9e0
cap  = ( 2625, 2625)  grid = (52.5, 52.5)    clear                                   v0xe5c9d0, v0xe5c9f0
size = max(min(requested, cap), extent of the components)                            v0x169b47, v0x169b4b
size = ceil(size / grid − 0.1) × grid                                                v0x169b94–v0x169bc1
```

So a sequencer's board is at most **25 rows** tall and **500 cells** (250 tiles) wide. *Read*: the
two caps, the two grids and which pairs with which (one `test rcx, rcx` picks both). *Inferred*:
that the set bit is the sequencer — from the 52.5 × 105 grid being the one `v0x1c4ad0` reads chips
on, and from the corpus's tallest board being exactly 25. The sizes are `PMicrochip + 0x4c` / `+0x50`
(serialiser `v0xd3afb4`, `v0xd3afc7`), and `v0x1686b2`–`v0x1686d0` tests both against the same
2625.0 (`v0xe5d23c`) on another path — ⚠️ not read further; what it does with an oversized board is
unknown. ⚠️ **The editor's clamp is not the game's ceiling.** With cheats a board reaches **33 rows**
(3465 units) and the game plays it — the owner's report from the running game, 2026-09-22, not a
reading; where 33 comes from is not known. `MAX_BOARD_ROWS` in
`packages/lbp-tracker-lib/src/song.ts` is therefore the 33, and `MAX_BOARD_CELLS` the 500: placing, moving and the song's end stop there. ⚠️ Two routes still pass the right edge —
lengthening a chip that already sits against it, and a paste walking right off a taken cell — and
a level that arrives larger is opened as it is.

## The sequencer's thermometer

A budget of its own, in bytes of sample, read 2026-09-21:

```
cost  = sum of the FileDB size of every DISTINCT sample GUID among the used SampleGuids_0..7
        of every RInstrument on the board                                     v0x1c4720
limit = MaxSequencerMemory = 1000000        gamedata/data/limits_settings.lmt, GUID 45910
shown = cost of the sequencer a player has open, the largest among the players   v0x74b960
```

- `v0x1c4720(PSequencer)` collects the board's instruments with `v0x1c49e0` (the same walk over
  the board's children that computes the grid cell at `v0x1c4ad0`), and for each `RInstrument`
  that is loaded (`[+0x45] & 0xfe == 4`) inserts the eight `u32` at `+0xc8`..`+0xe4` that differ
  from the empty value into a `std::set` (`v0xb3ab30`). It then walks the set, asks the file
  databases for each GUID's row (`v0x10680`) and adds `[row + 4]`. So **a chip costs nothing the
  second time, two instruments sharing a sample pay for it once, and notes cost nothing.**
- *Read*: the row keeps its path pointer at `+0x1c` (`v0xf407`), which leaves exactly two `u32`
  and a 20-byte SHA-1 before it. *Inferred*: that `+4` is the size, from the file's own order
  (date, size, SHA-1) — and **confirmed by the corpus**, below; a date would fill the budget at once.
- `limits_settings.lmt` is a resource in its **text** form (magic `LMTt`): tab-separated
  `name value` lines with the developers' `#` comments, no container to inflate. It is
  `RLimitsSettings` (type 33, loaded at `v0x27d3d0`), whose serialiser names every field;
  `MaxSequencerMemory` is `+0xc4` (`v0xc4b8ea`). Read from the base game's `intro_001.farc`; the
  patch's own FileDB names the same SHA-1 (`03ca65ee…`) for GUID 45910, so 1.28 reads this file.
- The level thermometer's table has 37 budgets of 20 bytes (`id, max, current, flags, dirty,
  enabled`); `v0x74af60` fills it, and the sequencer is entry 29: max from `+0xc4`, flags `0x38`.
  The level's fill takes the largest ratio among entries with `flags & 0x70 == 0x10`
  (`v0x74cf3b`), so **entry 29 never moves the level thermometer**; its ratio goes to the
  object's `+0x354` alone (`v0x74cc77`–`v0x74cc9e`).
- When `current > max` — strictly — and the flag at `+0x377` is clear, `v0x74cb31`–`v0x74cc63`
  posts game message `0x44`, `EGMT_SEQUENCER_LIMIT_EXCEEDED` by its place in the enum's name
  list, with LAMS `0xb1304e3b`: *"There are too many instruments on this sequencer! Try removing
  or replacing some. Check the blue thermometer to the left to see how expensive each instrument
  you place is."* The flag clears once a sequencer is open and its cost is not over (`v0x74bafa`). ⚠️ **Not read: whether
  anything refuses the chip.** What was read is a warning.

✔ `packages/lbp-tracker-lib/dev/sequencer-memory.ts` runs the sum over every real sequencer on
disk: **183 sequencers, none over, the fullest at 999,562 bytes** and 36 of them between 90% and
100% — creators filled it to the byte, which is what says the size, the set and the million are
all the right reading. One instrument alone runs from 490 bytes (`sine_wave`) to 340,346
(`a_kit_1`); the three pianos share their samples, so all three together cost what one does.

## `Key` and `Scale`

They act in the engine, after the record is read: the note is snapped to the scale
table first and then transposed by `key mod 12` ([synth-engine.md](synth-engine.md)). Reading 0 as
"no key" and 0 as "C" happen to agree; reading `Key` as a literal root would drop 96.7% of all
placements by an octave, and ignoring it — which this project did for its first day — played 2,461
placements (1.90%) and 75,073 notes (2.35%) in the wrong key, up to 11 semitones out.

## Defaults and ranges worth knowing

From the toolkit's field initialisers — for authoring, and as a sanity check when a parsed value
looks wrong.

| where | field | default / range |
|---|---|---|
| `RInstrument` | `Numstack` | `1` |
| | `Splitnotes[0]` | `87` |
| | `Params` | **27** entries, each two f32, each preceded by an i32 count of 2 |
| | `Arpeggio` | **32** bytes, each defaulting to `0xf` |
| `Sample` | `basenote` | `48` |
| | `basebpm` | `149.5` |
