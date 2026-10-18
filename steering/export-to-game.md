# Export to the game — writing a `.plan` LBP3 can load

Read before touching `../cwlib-ts/src/writer.ts`, `write-plan.ts` or `chips.ts`, or before
changing anything a `Sequencer` carries. This is the return leg of
[level-files.md](level-files.md) and [sequencer-data-model.md](sequencer-data-model.md): those two
say what the game's files hold, and this says how one is built.

The reader was proved by reading real files. **A writer has no such corpus**, so everything below
is either a measurement out of the game's own bytes or a stated deviation from one — there is no
third category, and a value that is neither belongs in [open-questions.md](open-questions.md).

## Why a plan, and why it travels alone

A plan (`PLNb`) is one saved Thing — a costume, a vehicle, a music sequencer copied into somebody's
popit — and it is the smallest unit anyone can drop into a level. **Everything a sequencer plan
refers to is a GUID**: the gadget's mesh, the gadget's own plan, and one `RInstrument` plus one icon
texture per chip. A GUID is an asset already in the player's FileDB and a SHA-1 is a user resource
that has to travel beside the file ([level-files.md](level-files.md)), so a sequencer plan is
**self-contained** — no FARC to build, nothing to ship with it. Measured on every plan this writer
produces: `readDependencies` on the output has never once returned a hashed entry.

That is the whole argument for exporting a plan rather than a level. A level would need all of
`RLevel`, and `readLevel` is deliberately a prefix (`level.ts` says so at the top).

**The same plan also goes out as a `.mod`**, the package ennuo's toolkit installs from: the plan's
bytes unchanged, one FileDB row naming them `plans/lbptracker/<song>.plan`. The format and its check
are *The toolkit's `.mod`* in [level-files.md](level-files.md).

## The shape, measured

✔ **17 real LBP3 sequencer plans** — the plan dependencies of "Music Gallery #3",
`../cwlib-ts/dev/fetch-plan.ts` — agree Thing for Thing:

```
Thing uid 2   parent —   groupHead 3   planGuid 120863
              parts RENDER_MESH POS TRIGGER STICKERS SWITCH GROUP MICROCHIP SEQUENCER
Thing uid 3   parent —   groupHead …   planGuid 0        parts GROUP
Thing uid 4   parent 2   groupHead 2   planGuid 120863   parts SWITCH      ← the circuit board
Thing uid 5+  parent 4   groupHead 3   planGuid <chip>   parts INSTRUMENT  ← one per placement
```

- `120863` is the **Music Sequencer gadget's plan GUID**, on the sequencer Thing and on its board.
- Every Thing writes `partsRevision` **63** (`PartHistory.STREAMING_HINT`), including the
  GROUP-only ones whose last part is at 0x26. ⚠️ cwlib's writer computes the *last part present*
  instead; both read back the same and only one is what the game does.
- `createdBy`/`changedBy` are **2** on every Thing of all 17 — that creator's controller slot, not
  a constant. This writer puts −1, cwlib's "nobody".

### Three deliberate simplifications

Each is something the real plans carry that is a person's history rather than the object:

| what | the corpus | here | why |
|---|---|---|---|
| the group chain | 3–6 GROUP-only Things linked through `groupHead`, each with the SHA-1 of a plan its creator saved earlier | one | the chain is a copy-and-paste history; one link is the same structure with none of it |
| `STICKERS` | 179 bytes: three decals whose textures are **hashes** | four empty lists | a hashed texture is a user resource, and it would turn a self-contained plan into one with a hole |
| the extra component | every board carries one chip that is not an instrument — a speaker, a script | none | the creator's wiring, not the instrument rack |

## The chassis — the parts that hold no music

`RENDER_MESH`, `POS`, `TRIGGER`, the two `SWITCH`es and `GROUP` carry nothing musical, and the
reader in `parts.ts` steps over their values. `write-plan.ts` writes them from constants taken out
of the same 17 plans with `dev/dump-fields.ts`, and `dev/verify-export.ts` diffs our bytes against
the game's span by span. **Result: identical except the reference id and three floats**, and the
three are the same deviation stated three times.

| part | ours | the corpus | why they differ |
|---|---|---|---|
| `RENDER_MESH` | mesh GUID 127558, bones `[self, null, null]`, anim null, speed 1, loop true, loopEnd 1, editorColor −8323200, visibility 3, **poppetRenderScale 1.0** | 1.0696549 in eleven, 1.0 in the rest | the object's own scale; 1.0 is the gadget untouched |
| `POS` | no translation, no rotation, a uniform **scale of `0.7333331f`** | a world position, a hair of rotation, and that scale times the object's own resize | the game moves a plan to wherever it is dropped; the only part that survives placement is the scale |
| `TRIGGER` | type 0, no inThings, **radius 600**, zRange 5, allZLayers, hysteresis 1, enabled, scoreValue 10 | 594.2279 on a resized object | 600 is the round one, and it goes with a scale of 1 |
| `SWITCH` ×2 | **radius 250**, angleRange 180, bulletsRequired 1, randomBehavior 1, on-times 30/30, userDefinedColour −8355585, playSwitchAudio, playerMode 1, stickerSwitchMode 1 | 267.4137 = 250 × 1.0696549 | the same scale again |
| `GROUP` | creator `MM_Studio`, planDescriptor GUID 120863, lifetime 0, **aliveFrames 11**, flags 2 | identical | — |

❗ **The gadget's own scale is 0.7333, not 1.** ✔ Measured 2026-09-21 with `dev/dump-fields.ts`
over the 14 sequencers in `fixtures/plans`: the eleven with `poppetRenderScale` 1.0 and radius 600
sit at 0.73329–0.73333 on all three axes (mode `0.7333331f`, four of them to the bit; one outlier
at 0.7563), and the three resized ones at up to 0.7844 = 0.7333 × 1.0696549. ⚠️ The writer put the
**identity** until 0.2.29, on the reading that 1 was the untouched gadget — a sequencer 1.364 times
the game's. It imported, which is all *46* checked; whether it is why the game called one "too big"
to place is in [open-questions.md](open-questions.md).

⚠️ **The two switches differ in exactly two fields**: `type` is 36 (`SWITCH_MICROCHIP`) on the
gadget and 37 on its circuit board, and `manualActivation.player` is 0 on the gadget and −1 on the
board. Everything else is the same 68 bytes.

❗ **`MM_Studio` is the game's own marker, not a name being borrowed.** It sits beside
`planDescriptor` 120863 on every copy of the gadget in the corpus, and the pair means "this came
from Mm's plan".

## The author

The **human** fields — the group Thing's `PGroup.creator` and `InventoryItemDetails.creator` —
carry `Sequencer.author`. Until 2026-09-14 they were left empty, on the argument that this tracker
had no author to claim; the owner asked for the author to be loaded, edited and exported, and the
argument turned out to point the other way: the name was in the file all along, and blanking it
took the maker's name *off* their own song.

✔ **Where the game keeps it, measured 2026-09-14 over 210 music sequencers** (the toolkit corpus,
the 17 gallery plans, `fixtures/levels`, the archive sample):

| where | what it holds |
|---|---|
| the sequencer Thing's own `PGroup.creator` | `MM_Studio` on 207, empty on 3 — the gadget's marker, never a person |
| the GROUP-only Things up its `groupHead` chain | a PSN handle on **149**; 61 sequencers have no chain at all, nobody ever grouped them |
| `InventoryItemDetails` at the end of a plan | the same handle twice on all 15 gallery plans that name somebody — `creator` and the creation history — found by a byte search, since `readPlan` does not parse that block |

⚠️ **Nearest, not outermost.** Seven chains name more than one person, and in every one the uids
grow outward — `sethe99#7320 → RyanSpiker#7322 → montyferah#7395` — so the nearest group is the
oldest: whoever made it, with whoever later pasted it into their own contraption wrapped round.
`sequencerAuthor` in `level.ts` is the rule. The writer puts the author on its one group Thing
(uid 3, the chain's single link) and in `InventoryItemDetails.creator`; `creationHistory` stays
null, which *46* in [answered-questions.md](answered-questions.md) cleared.

⚠️ **A handle is 16 bytes of `NetworkOnlineID.data`.** Of the 741 distinct creators in every
`PGroup` of every file in the same corpora, 740 are letters, digits, `_` and `-`, at most 16 long,
which is what PSN allows; the odd one out is `Ú'x5`, which is not a name at all. `authorHandle` in
`project.ts` keeps exactly that and cuts at sixteen, in the song file's reader, the MIDI reader,
the page's field and the writer alike.

⚠️ **`PMicrochip.hideInPlayMode` is written as 116.** It is declared a bool and the game writes
`0x74` into it on the microchip of every one of the 15 plans measured. Any non-zero byte reads as
true; this is the byte the game itself puts there.

## The geometry, run backwards

`project.ts` turns a board position into a grid cell; the writer needs the inverse, and both halves
are checked against the corpus's own fingerprint — every stored `x` an exact multiple of 52.5 and
every `y` an **odd** multiple of it.

```
x = (gridX + 1) * 52.5
y = -(gridY + 0.5) * 105
```

**The chip's own size.** ✔ Measured over 3,724 instrument components: `scaleY` is `1.4666666f`
(`0x3fbbbbbb`) on every one of them, and `scaleX` is that unit times a cell count which is exactly

```
cells = ceil((highest step in the clip + 1) / 16) - 1
```

⚠️ **Two of the widths are not the product.** Three cells is `4.4f` and six is `8.8f`, each one ulp
above `cells * 1.4666666f`; five and seven are the rounded product and one, two and four are exact
doublings. `CHIP_WIDTHS` in `write-plan.ts` is therefore the game's own bit patterns and not an
arithmetic expression, with the product as the fallback past seven cells.

The board is sized to fit: `rows = max(boardRows, lowest row + 2, 3)` and
`columns = max(rightmost chip's right edge + 1, 4)`, which reproduces the corpus's boards to within
the slack a creator leaves by hand. The spare row gives way at 33 rows, the tallest board the game plays (*The board's
size limit* in [sequencer-data-model.md](sequencer-data-model.md)).

## The instrument chip table — `src/chips.ts`

A `Track` carries two things about its instrument: the `RInstrument` GUID, and the tint the chip
wears. The **chip** carries two more, both properties of the instrument rather than of the music —
the popit plan it was placed from (the Thing's `planGuid`) and the icon drawn on it
(`PInstrument.Icon`) — and the tint that plan ships with, which is what an untinted placement
shows.

❗ **Measured 2026-09-10 out of the game's own popit plans, all 68 of them.** A chip is placed from
its instrument's `instrument_*.plan`, so that plan holds every column of the table:
`tools/InstrumentColours.java` walks them through the FileDB and prints the row. It **replaced** a
corpus tally (`dev/chip-table.ts` over 19,116 placements in the 17 gallery plans, the ten-level
corpus and the 103-level archive sample, 2026-09-09) which had answers for only the 50 instruments
somebody had used — and the two agree on **50 of 50 rows, plan and icon both**. The tally is still
worth running: it is the check on the table, and the only way to see what creators do with
`Colour`. Neither the plan nor the icon reaches playback — a plan without them plays right and
puts blank grey chips on the board.

The tint is one colour per instrument **family**, and
[sequencer-data-model.md](sequencer-data-model.md) has the reading of the field; `factoryColour`
is the lookup and `drawnColour` is what an untinted chip shows.

❗ **The writer puts `drawnColour`, not the byte it was handed.** Measured in the game on
2026-09-14: a plan whose chips carried `0xffffffff`, exactly as the level stores them, imported as a
white board while the tracker had shown them in their family colours. The game draws the value;
the tracker's reading of white as "the instrument's own" is the owner's decision, and the plan
follows it so that what the board showed is what arrives in the popit. `verify-export` compares the
colour as drawn for the same reason.

⚠️ **The writer used to put the constant `0x41000000` in `PInstrument.Colour`**, on a comment
saying it was what every plan measured holds. It is in none of them: over 68,568 placements the
field takes 25 values and that is not one of them. It went in while the reader was still throwing
the field away, so nothing could contradict it — **a constant in the writer for a field the reader
skips is unfalsifiable by construction**, and the fix was to read the field. The writer now puts
the placement's own colour, which for a chip this tracker made is the instrument's factory one.

## `RPlan` and the inventory block

`readPlan` reads three of `RPlan`'s four fields and has never read the fourth. The game always
writes it, so `write-plan.ts` does too: `InventoryItemDetails` at `version > 0x37c`, transcribed
from cwlib and then checked against the 218 bytes a real plan carries.

✔ **The alignment check is `type`**: the field decodes to `1 << 7`, `USER_OBJECT`, on all 17 — a
reading one field out could not land on a flag word that says what the item is. The name goes in
`userCreatedDetails`, where the game puts a creator's own title; `titleKey` is for Mm's own items
and stays 0. `location` is 0 and `category` is the LAMS key `3423480070`, the same on all 17, which
is what makes it the category rather than the item.

❗❗ **`Icon` must not be null, and it is the only field in the whole export the game insists on.**
A plan whose `InventoryItemDetails.Icon` is a null descriptor never becomes ready — its resource
status byte stays 9 instead of reaching 4 — and `AddInventoryItem` never puts it in the popit. The
file is otherwise perfect: it parses, its Things are right, its dependency table is right, and the
game silently declines to own it. Measured in the game (1.28 under shadPS4) on 2026-09-10 by
bisection against a plan the game itself wrote; the method, and the list of everything the same
bisection **cleared**, are *46* in [answered-questions.md](answered-questions.md).

⚠️ **The descriptor only has to exist.** An icon resolving to nothing — a hash in no archive —
imports just as well, so this is a presence check in the loader rather than a texture it draws.
What it changes is the picture in the popit, and `DEFAULT_PLAN_ICON` is **128567**,
`texture_library/ui/auto_icons/dlc_arcade/palette_gameplay_arcade_6416.tex`. `PlanDetails.icon`
overrides it; 0 writes the null descriptor, which exists so a test can reproduce the failure.

❗ **How that GUID was found, which is the route to repeat for any other gadget**: the mesh this
writer puts in `PRenderMesh` is 127558, and the one plan in the game's data that depends on it is
`plans/palettes/dlc_arcade/sequencer.plan` — GUID **120863**, the same plan GUID the corpus's
sequencer Things carry. Its own `InventoryItemDetails.Icon` is the answer.

⚠️ **`electronics_inventory_logic_sequencer.tex` is a different gadget**, and this file shipped it
for a day. 128125 is the icon of `gad_sequencer.plan`, GUID 125400, the **logic** sequencer from
the electronics palette — which shares `PSequencer` with the music one (`MusicSequencer` is the
flag that separates them, [sequencer-data-model.md](sequencer-data-model.md)) and therefore shares
its vocabulary. A search by name lands on the wrong one; **the dependency on the mesh is what tells
them apart.**

⚠️ **The icon is written by the OUTER writer, and its dependency has to be collected from there.**
`planPayload` returns the Thing blob's table merged with the wrapper's; it returned the inner one
alone while the icon was null, which was correct exactly until it wasn't — and a plan naming a
texture it does not declare is the next bug of this shape.

## The container, and the two builds

`writeResource` in `writer.ts` writes the header `resource.ts` reads, and the round trip through
`loadResource` re-checks the one thing the header never states: **the chunk data has to end exactly
on the dependency-table offset**.

⚠️ **The subVersion is the platform.** `0x3f9 / 0x213` is what LBP3 on PS3 writes (and what RPCS3
wants); `0x3f9 / 0x218` is PS4/PS5. A game reads its own. `LBP3_PS3` is the default because the
modding route — a `bigfart`, a `patch_002.farc` — is a PS3 route; the byte-for-byte chassis diff is
against `0x218` files, because that is what the public archive holds. The one gate between them is
`PSwitch.unspawnedBehavior` at `subVersion > 0x216`, which the writer has.

⚠️ **The zlib header differs by platform of the *exporter*, and the game does not care.** It
writes `0x68` — CINFO 6, a 16 KiB window — and `nodeDeflate` reproduces that exactly with
`windowBits: 14`; the browser's `CompressionStream` has no such control and writes `0x78`, as
ennuo's toolkit does. ✔ **Both import**, measured in the game alongside *46* — *47* in
[answered-questions.md](answered-questions.md). The `windowBits` stays so that a hex dump of our
output lines up with the game's own.

## What proves the writer

| check | where | what it says |
|---|---|---|
| the reader reads it back | `test/write.test.ts`, `dev/verify-export.ts` | 15 of 15 real gallery sequencers written and read again: every setting equal, every note record **byte for byte** |
| the container checks itself | `loadResource` in the same tests | the header is right or the file will not open at all |
| the chassis matches the game | `dev/verify-export.ts` | span by span against real plans; identical but the reference ids and the three scale-derived floats above |
| the primitives are the reader's | `test/write.test.ts` | every `Writer` method written and read back through `Serializer` |
| growth does not lose bytes | `test/write.test.ts` | see below |

❗ **The one real bug the writer had, kept as a comment on `Writer.need`.**
`this.buffer.set(v, this.need(n))` evaluates `this.buffer` **before** the call that may replace it,
so once a payload outgrew the initial capacity every byte after it landed in a discarded array —
silently, and only on large songs. Every accessor now takes the offset first.

## What the game says

✔ **LBP3 imports it.** Measured 2026-09-10 in the game (1.28 under shadPS4): the demo plan, a real
song exported from the tracker, and a corpus sequencer read and written back all arrive in the
popit as ordinary objects — **once `InventoryItemDetails.Icon` is not null**, which is *46* in
[answered-questions.md](answered-questions.md) and the paragraph above.

⚠️ What that establishes is that the game **takes** the object. Nobody has yet sat through a long
exported song in Create Mode and listened for a difference against the same song played here, and
that is the check this project would actually learn something from: every note record is the file's
own bytes, so a difference would be in the parts that are not — the board size, the chip widths,
the channel banding.

## Where the code is

| file | what |
|---|---|
| `../cwlib-ts/src/writer.ts` | the write-side primitives, method for method against `serializer.ts`, and the container |
| `../cwlib-ts/src/write-plan.ts` | the Thing graph, the part writers, `RPlan`, and `writeSequencerPlan` |
| `../cwlib-ts/src/chips.ts` | the instrument chip table |
| `../cwlib-ts/src/platform/{node,web}.ts` | `nodeDeflate` / `webDeflate`, injected as `inflate` is |
| `packages/lbp-tracker-lib/dev/export-plan.ts` | the command line: a level, a plan or a song file in, a `.plan` and its dependency table out |
| `packages/lbp-tracker-web/src/daw/plan-export.ts` | the Import/Export view's second section |
| `../cwlib-ts/dev/verify-export.ts` | the round trip and the chassis diff |
| `../cwlib-ts/dev/fetch-plan.ts`, `chip-table.ts`, `dump-fields.ts` | how the corpus above was gathered and read |
