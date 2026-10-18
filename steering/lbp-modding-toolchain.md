# The LBP modding toolchain — what exists, how much to trust it, where we differ

Read before trusting or porting anything from ennuo's toolkit, and before attacking a question
that touches the **save format** rather than the runtime engine. Someone has already done a large
part of that work in the open, and the rule for using it is the first thing here.

## The project — and who wrote which half

`https://github.com/ennuo/toolkit` — "Craftworld Toolkit". Java, **MIT licensed**, ~770 files. Two
parts matter, and **they have different authors, which changes how much weight each carries**:

- `lib/cwlib/` — **ennuo's**. Hand-written serialisers for LBP resource types and Thing parts, each
  carrying field order, per-field revision gates and defaults, with a decade of community use
  behind it. This is the part worth treating as a serious independent reading of the format.
- **`sequencerdump`** — **this project's own author wrote it**, and it is not in this repository:
  fork at `https://github.com/sgdc3/toolkit`, local checkout at
  `C:\Users\sgdc3\Desktop\LBP\toolkit\`. It walks a level or `.plan`, finds every **music**
  sequencer, and exports to MIDI or Ableton ALS. ⚠️ **The author's own instruction: trust its
  level-extraction logic, ignore its sequencer parsing.** The traversal is sound; the musical
  interpretation on top of it (note grouping, durations, triplet timing) is, in the author's words,
  suboptimal and inconsistent. Where our measurements disagree with it, ours win without argument.
  Its ALS writer is no reference either: Live 11 refuses its sets, and opens them with every clip
  gone once the version is rewritten ([ableton-interchange.md](ableton-interchange.md)).

MIT means we may port logic from it with attribution. Prefer porting the *understanding* over the
code.

❗ **cwlib's Java source is on this disk, not just its jar**:
`C:\Users\sgdc3\Desktop\LBP\toolkit\lib\cwlib\src\main\java\cwlib\` — `structs/things/` for
`Thing.java` and the `parts/`, `enums/Part.java` for the mask semantics, `enums/Revisions.java` and
`enums/Branch.java` for every gate constant. **Read it before tracing bytes.** Question 28 spent a
session on a byte-level trace and then found its bug in ten minutes by opening `Thing.java`; and
`tools/CwlibTrace.java` turns cwlib's own serialiser log into part boundaries with offsets, so a
divergence from it is a diff rather than a hunt ([tools.md](tools.md)).

## Provenance rule — a source of hypotheses, not of measurements

This workspace's rule is that steering facts are measured out of the game's own bytes. The toolkit
is a third party's reading of those bytes: excellent, load-bearing for a decade of community
tooling, and still a reading. So:

- Anything taken from the toolkit enters as a **hypothesis** and is marked as such until confirmed
  against the eboot or against a file diff.
- Where confirmed, say so and give the address, exactly as for anything else.
- Where the toolkit and our own disassembly disagree, the eboot wins — but treat the disagreement
  as a signal that one of the two readings is subtly wrong, and find out which before moving on.

Three of its claims were confirmed against `eboot-v128.bin` on 2026-09-01 and are recorded in
[sequencer-data-model.md](sequencer-data-model.md) with their addresses; one was sharper than our
own prior reading and corrected the phantom third bool in the sample slot. The other evidence
rule — that a capture of "the game" is a capture of shadPS4 — is in
[project-brief.md](project-brief.md).

## What it implements that we care about

| toolkit class | our topic |
|---|---|
| `structs/instrument/Note.java` | the 4-byte note record — confirmed against 1.6 M real notes |
| `structs/instrument/Sample.java` | the sample slot; stream order and defaults |
| `resources/RInstrument.java` | the sampler patch; array lengths and defaults |
| `structs/things/parts/PInstrument.java` | the instrument part; revision gates, defaults |
| `structs/things/parts/PSequencer.java` | the sequencer part, including three fields our own serialiser walk missed |
| `structs/things/parts/PMicrochip.java` + `components/CompactComponent.java` | how instruments are placed on the timeline |
| `enums/ResourceType.java` | `INSTRUMENT = 48`, `SAMPLE = 49` — independent confirmation of our own table |
| `io/streams/MemoryInputStream.java` | endianness: defaults to **big**, with a per-stream override |
| `util/Crypto.java`, `types/archives/SaveArchive.java` | the `FAR4` save key and revision gates |
| `types/archives/FileArchive.java` | the FARC index, which `tools/ExtractGuid.java` links against |
| `structs/things/Thing.java`, `parts/*.java` | every version gate the LBP1 readers were checked against |

## What it does *not* cover

- **`RSample` (type 49) is declared but not implemented** — no magic, no class. What it settles is
  the *kind* of reference: `serializer.guid()`, an ordinary GUID into the game's FileDB, not an FSB
  index. The resolution — plain RIFF `.smp` files in the FARCs — is ours,
  [game-assets.md](game-assets.md).
- **No audio and no synthesis model.** No FSB reader, nothing about pitch ratios, key splits at
  playback time, echo, reverb, or the FMOD side. Everything in [synth-engine.md](synth-engine.md)
  and [lbp-audio-engine.md](lbp-audio-engine.md) is ours.
- **`StandardInstrument.java` is LBP2-era and self-admittedly incomplete** (`// TODO: LBP3
  instruments`): 59 stock instrument GUIDs with display names, and two entries whose enum names
  disagree with their strings (`CARILLON` → "Kalimba", `KALIMBA` → "Marimba"). A convenience for
  display; verify before relying on any single row.

## Known approximations in `sequencerdump`'s musical layer — do not inherit these

1. **Grid snapping.** It rounds each component's board position to a fraction of 2 and takes
   `floor(x / 52.5)`. The game applies a `-0.5` bias (measured at `v0x1c4ad0`,
   [sequencer-data-model.md](sequencer-data-model.md)).
2. **Triplet timing.** `Point.toMidiTick()` maps a triplet step with `group = step/4, pos = step%4,
   tick = group*96 + pos*32`; four positions at 32 ticks overrun the 96-tick quarter, so the fourth
   slot lands on the next beat. Their interpretation, not a measurement.
3. **Note volume and timbre are read as signed Java bytes** while the write path masks with
   `& 0xff`; values above 0x7f would come back negative. Read them as u8.

### The `RawDump` duplication — kept for the rule at the end

`tools/RawDump.java`, deleted 2026-09-02 once `../cwlib-ts/src/level.ts` replaced it, walked
`world.things` and dumped every Thing carrying a music `PSequencer`. ⚠️ **A world's Thing list can
carry the same sequencer twice**, and when it does every component was written again with the same
`seqUID` **and the same `instIdx`**, byte for byte. **60 of the corpus's 338 sequencers came out
that way** — all-or-nothing per sequencer, 23,911 duplicate rows out of 129,696 — and it cost a
rendered note: every note played twice (6 dB, invisible under a normalising render) and **every
note took two of the engine's 32 voices**, so at step 2176 of `This Is Halloween` the pool
overflowed, stole the quietest, and the four voices carrying the sustained lead vanished for two
bars, exactly as a listener reported.

The fixture on disk, `fixtures/levels/sequencers.jsonl`, **predates the fix and still contains the
duplicates**; `../cwlib-ts/dev/verify-levels.ts` drops any row repeating a
`(file, seqUID, instIdx)` it has already seen — exact rather than heuristic, because a board cell
holds one component. The TypeScript walk cannot produce this at all: it visits each Thing once, and
its 62,158 placements over the ten-level corpus are exactly `PartCensus.java`'s `INSTRUMENT` count.

**The rule this earns:** a structural regularity in *our* extraction is a bug until proven
otherwise. This one was written into steering as a fact about the level — "the composer plays every
hit on two components" — and stood for a session, because nobody asked whether the two components
were at the same board cell. They were.

## How `sequencerdump` gets from a file to a set of sequencers

The traversal is the part worth reusing, and all of it is implemented in `../cwlib-ts`
(`backup.ts`, `savearchive.ts`, `readPlan` in `level.ts`). The containers, the `FAR4` recipe, the
plans and the streaming chunks are in [level-files.md](level-files.md); the sequencer-specific
half:

- A music sequencer is a Thing with **both** a `PMicrochip` and a `PSequencer` whose
  `MusicSequencer` is true. Check that flag: animation sequencers share the part.
- Instruments are normally `PMicrochip.Components`, each a `CompactComponent` carrying the child
  Thing and its `(x, y)` on the board.
- ⚠️ **The open-circuit-board case.** If the microchip's `CircuitBoardThing` has a `PPos` part — the
  board was left open in the editor — `Components` is empty. Scan every Thing for children whose
  `parent.UID` equals the board's and which carry a `PInstrument`, and derive the cell from the
  matrices. ⚠️ The toolkit's own formula — the translation delta rotated by the **child's** inverse
  rotation — scores 100% on the corpus by accident and is wrong twice over; the measured one is the
  delta in the **board's** basis, *16* in [answered-questions.md](answered-questions.md). Miss the
  case and sequencers left open at save time come out empty: one corpus level loses five
  sequencers and 1,030 placements.

## Where we deliberately differ — a running list

Neither half of the toolkit is perfect, and finding places where either diverges from the game is
the **expected outcome** of this project, not an anomaly: matching them is not the goal, being
right is. Every known divergence lives here with its evidence, so a future session reading that
code does not "fix" our behaviour back toward it. Add a row whenever a difference is established;
never silently follow the toolkit against our own measurement.

| # | where | they do | we do | evidence |
|---|---|---|---|---|
| 1 | grid placement | `floor(x / 52.5)` | `floor(2x/105 − 0.5)` | measured at `v0x1c4ad0`; the game applies a half-cell bias |
| 2 | `Note.volume` / `.timbre` on read | signed Java byte | unsigned | their writer masks `& 0xff`, their reader does not |
| 3 | note duration | follows from the record chain, with an extra point pushed at `step+1` | `x_last − x_first + 1`; records are control points, not a filled span | 93.6% of 1.6 M real notes land on a power-of-two duration under this reading; the engine's gate closes at `lastStep + 1 + endSubStep/3` (*30*) |
| 3b | out-of-order points | sorts a note's points, with a "sometimes this isn't correct" comment | same — sort by position; but `Track.records` keeps the file's own bytes | ~81 notes in 1.6 M have a last record whose `x` precedes the first; re-encoding a sorted chain moves the end flag |
| 4 | triplet timing | `group*96 + pos*32`, overruns the quarter on the 4th slot | `step + subStep/3`; at 480 PPQ a step is 120 ticks and a third of one is exactly 40 | `v0x4558 = 0.333333` in the PRX |
| 5 | mixer | ignored; tracks grouped by row + instrument | `NumChannels`, `Volume[0..5]` and the row banding, all carried by the MIDI export | the fields exist and are audible; the banding is read at `v0x1c7909` (*9*) |
| 6 | open-board cell | child's inverse rotation | the delta in the board's basis | *16*: 78.93% of open placements on a cell with the bare delta, 100.00% in the board's basis |
| 7 | `Key`, `Scale` | not applied | `key mod 12` transposition after a table quantiser | `v0x160806`, PRX `0x240` (*18*) |
| 8 | `PQuest` types 1–4 | throws *"Unsupported quest type"* before the per-type block it already has | reads that block, which matches the game's | the loader `v0xdc0290` and its jump table at `v0xdc087c` (*54*); no file has carried one yet |

The general shape: their tool converts *to MIDI*, so anything MIDI cannot express gets flattened
or dropped. We reproduce the instrument, so the things they flatten — per-step automation, the
mixer, the sends, the sampler's key splits — are exactly the things we keep. Our own converter and
how far it is trusted is [midi-interchange.md](midi-interchange.md).

## How to work with it from here

Do not clone it into this repo. Read the specific class you need from the checkout (or over
`raw.githubusercontent.com`); the classes are small and self-contained, and a full checkout is
5.5 MB of Java we have no intention of building. Everything worth keeping belongs in this steering
directory, in English, with its provenance attached.
