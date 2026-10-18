# Level files — containers, saves, archives and the corpora

Read before writing a parser for any LBP resource, save or archive. Everything below is the
*carrier*: the formats a sequencer arrives in. What the sequencer's own data looks like once the
Thing graph is open is in [sequencer-data-model.md](sequencer-data-model.md); the implementation
is `../cwlib-ts`, and `tools/lbpres.py` is the Python reference for the container.

Everything here is read by `../cwlib-ts/src/resource.ts` and written back by
`writer.ts` — the container, the chunk table and the dependency table have a write side since
2026-09-09, and [export-to-game.md](export-to-game.md) is where that lives.

All integers are **big-endian**, including in the PS4 build — measured: the array serialiser at
eboot `v0xcc0f20` reads four bytes and byte-swaps them with `movbe` before storing (`v0xcc0f9d`,
`v0xcc1025`). LBP's formats are PS3-era and stayed that way.

## The container — `LVLb`, `PLNb`, `CHKb`, …

Derived from the bytes of real level resources, and verified on 18 levels spanning revisions
`0x3b8`–`0x3f9`: every chunk inflates, every inflated length matches its declared `rawSize`, and
the offset just past the last chunk lands **exactly** on `depsOffset` in all 18 — an offset the
parser never uses, so 18 hits on it is not a coincidence.

```
0x00  char[4]  magic        "LVLb" level, "PLNb" plan, "CHKb" streaming chunk, "ADCb" adventure …
0x04  u32      revision     0x3ee etc. A non-zero high half is a branch id:
                            0x021303f9 = branch 0x0213, revision 0x03f9 (LBP3)
0x08  u32      depsOffset   start of the dependency table = end of the payload
0x0c  u32      (zero in every file seen)
0x10  u32      0x07010001 in every level seen — flags; bit 0 of the low byte is `isCompressed`
0x14  u16      numChunks           ┐ only when compressed
0x16           numChunks x (u16 compressedSize, u16 rawSize)
...            chunk payloads back to back, each a complete zlib stream
```

- Chunks are `0x8000` bytes raw except the last, which is short. ⚠️ Both sizes in the table are
  `u16`, which is *why*: `0x10000` would not fit, and a chunk that deflates larger than `0xffff`
  cannot be written at all.
- ⚠️ **The zlib header is `0x68 0xNN`, not `0x78 0xNN`** — CINFO 6, a 16 KiB window. Grepping a
  resource for the familiar `78 9c` / `78 da` finds nothing and looks like proof the payload is not
  zlib. It is.
- ❗ **An uncompressed resource has no chunk table.** The payload starts straight after the flag
  and runs to `depsOffset`. `CHKb` chunks are stored that way, and a reader that ignored the flag
  took "96 chunks" out of the payload's own first bytes.
- ❗ **A resource is told from everything else by its first four bytes, never by its name.** A
  backup is full of `ICON0.PNG`, `PARAM.SFO`, costumes and photographs, and every resource is
  named after its SHA-1. `looksLikeLevel` in `../cwlib-ts/src/backup.ts` accepts `LVLb`,
  `PLNb` and `CHKb`.

### The dependency table

Measured 2026-09-05. It sits **after** the payload, at `depsOffset`: `u32 count`, then per entry
`u8 kind` — 1 for a 20-byte SHA-1, 2 for a `u32` GUID — followed by a `u32` resource type. ✔ On
"Music Gallery #3" the walk of 160 variable-length entries ended at exactly the last byte of the
file (`0x52d02` of `0x52d02`), which is the check that the reading is right. `readDependencies` in
`../cwlib-ts/src/resource.ts`.

❗ **A hashed dependency is a USER resource and a GUID one is a GAME asset.** The hashed ones are in
the public archive under the same URL scheme as the level; the GUIDs are in the game's FileDB and
are **not in the archive at all**. On that level: 20 hashed, 140 GUIDs.

The types, each checked against the magic of the resource actually downloaded for it rather than
read off an enum:

| type | magic | what it is |
|---|---|---|
| 1 | `TEX ` | a texture |
| 9 | `LVLb` | **a level inside an adventure** |
| 38 | `PLNb` | a plan |
| 46 | `VOPb` | a recording |
| 61 | `CHKb` | **a streaming chunk** |
| 62 | `ADSb` | an adventure's shared data, 35–270 bytes |

The `R*` resource-type ids themselves come from the eboot's ordered name list (`RTexture` = 1,
`RInstrument` = 48, `RSample` = 49) — [sequencer-data-model.md](sequencer-data-model.md).

## The Thing stream

`RLevel` → `PWorld.things`; `RPlan` → its Thing array. **The stream is strictly sequential**:
references are inline ids that expand at their first mention, parts carry no lengths, and
`PWorld.things` is an array of them, so reaching the 443rd Thing means having fully read the 442
before it. That is why `partReaders()` in `../cwlib-ts/src/parts.ts` has **50** readers rather
than the nine part types that ever share a Thing with a sequencer — count it, do not quote it.

Per Thing, in stream order — every gate below was taken from cwlib's `Thing.java` and then
confirmed against files:

- the **UID**, then the **parent** — ⚠️ the other way round below `0x27f`;
- the **parts revision**, an `s32` **in the stream** before the part mask, one zigzag byte when
  compressed and four when not. It was guessed from the version for two days and recorded as *"one
  byte cwlib does not account for"*;
- the **`0xAA` test marker**, at `version >= 0x2a1` — ⚠️ and also on the LEERDAMMER branch from its
  own revision 5. It is a per-Thing checksum over the whole walk, and it reports a misalignment
  **one Thing late**, so the byte it names is never the byte that is wrong;
- the **parts mask**, likewise present on LEERDAMMER from revision 2. Without it the mask was `-1`
  and every declared part was treated as present. ⚠️ **The mask can exceed 2^53**: the highest
  part index is 53, so a Thing with `STREAMING_HINT` and a low part cannot be held in a `number`.
  `BigInt(s.u64())` does not fix it — the bits have to survive the accumulation, which is what
  `u64Big` in `serializer.ts` is for;
- ⚠️ **below subVersion `0x107` a mask bit is not a part index.** The deprecated `PCreatorAnim`
  (index `0x3e`) has bit `0x29`, read only from parts revision `0x32`, and every part from
  `TRANSITION` (`0x29`) up is **one bit higher** than its index; at `0x107` and above the creator
  anim is gone and the bits are the indices. ✔ Confirmed in the game's Thing loader, `v0xd49d92`
  in `eboot-v128.bin`: with the head `<= 0x106ffff` it tests the creator-anim bit and then tests
  `TRANSITION` on bit `0x2a` rather than `0x29`. `partBit` in `thing.ts` is the rule, for the reader
  and the plan writer both. This is not a pre-LBP3 corner: **subVersion 0 is in range**, it is
  every LBP2 level and nine of the ten corpus levels;
- the parts, each read by its own gates.

Three traps that were each found on the first file of a new kind:

- ⚠️ **`PStreamingHint.connected` is a double reference** — `s.references(builder)` reads an id
  and then the builder reads another. Empty in every corpus file, so the loop never ran.
- ⚠️ **A level can carry a second world Thing** — one has a `WORLD` inside a `CREATURE` — so only
  the outermost may throw `StopParse`; `WORLD` was once installed on a *copy* of the reader map.
- ⚠️ **Nine of the fifteen LBP1 divergences were a version gate that existed in the reader's own
  comment and not in its code.** Parts were ported with their gates documented and then written
  for the LBP3 branch only; a grep for "at or below", "above 0x" and "regenerated" in `parts.ts`
  is a work list for anything still unported. And `connectorPos` is a `vectorarray`, whose cwlib
  return type is `Vector4f[]`: **a helper's name does not say its element width.**

### `cf7` hides field-width bugs — the archive's chunks are the only `cf0` corpus

With `COMPRESSED_INTEGERS` set — which every level and plan in the corpus has, the flags byte reads
`cf7` — every 32- and 64-bit integer is a LEB128 varint (7 bits per byte, low group first) and
signed ones are zigzagged; floats stay fixed 4-byte big-endian. So **an `i32` whose value is zero
is a single byte**, and a field declared `s.i32()` that is really one byte reads correctly on all
62,158 placements of the golden fixture and is wrong the moment it meets an uncompressed stream.
`CHKb` chunks are `cf0`, and three fields died on the first one:

| field | declared | is |
|---|---|---|
| `FieldLayoutDetails.machineType`, `fishType`, `arrayBaseMachineType` from `0x3d9` | `enum32` | **`u8`** — nine bytes per field on an uncompressed stream, none on a compressed one. With it wrong 101 of 2,553 islands died and the rest quietly lost most of their Things |
| `PCostume.creatureFilter` | `u8` | `i32` — the same mistake the other way |
| `PControlinator.parentBoneIndex` | `i32` | **one byte** — read as `4,161,536`, which is `0x003F8000`: a zero byte followed by three quarters of the `1.0f` of the identity matrix after it |

❗ **A field whose value is usually zero or small is untested for width by a compressed corpus.**
The 32 archived chunks — 5,832 Things, all parsing clean — are the `cf0` regression corpus; run
anything that touches a field width against them before believing the ten-level corpus.

## Plans — `PLNb`

A plan is a saved Thing rather than a world — a costume, a vehicle, or a music sequencer copied into
somebody's popit. `readPlan` in `../cwlib-ts/src/level.ts` opens one and `readLevelProject`
dispatches on the magic. `RPlan` is four fields and only the third matters:

```
bool  isUsedForStreaming   subVersion >= 0xcc          (Revisions.STREAMING_PLAN)
i32   revision             the plan's own, IGNORED -- the resource's revision wins
i32   length               \  thingData
byte  data[length]         /  a Thing[] as a reference array: i32 count, then each
...   inventoryData        head >= 0x197 and not streaming -- never read here
```

⚠️ **The Things are in a nested stream with a fresh reference table.** Reference ids inside
`thingData` mean nothing outside it, so the blob gets its own `Serializer` with the same revision
and compression flags. Reading it in place works by accident on a plan holding one Thing. Two
proofs the wrapper offsets are right: the Thing array **fills `thingData` exactly** — 0 bytes left
on 220 of 220, asserted — and every one of 83,188 Things carries the `0xAA` marker.

❗ **Nine tenths of the music in a creator's backup is in plans, not levels.** Six real PS3 saves,
663 resources: **224 plans**, all but one parsing — the exception is at revision `0x272`, refused by
the bound on purpose — and **172 music sequencers inside plans against 19 inside the levels beside
them**. A gallery level is a rack of speakers pointing at plans; the songs are the
plans. `../cwlib-ts/test/plan.test.ts` pins the counts. ⚠️ `PLNb` was once in the level
magic list meaning "read a plan as if it were a world", which produced eleven loud failures for a
backup that was fine; the magic was never the problem, the reader was.

## Streaming levels — `CHKb` and islands

An LBP3 adventure is not one level: `RLevel` → `StreamingManager` → `LevelData.chunkFileList`
names a pile of `CHKb` resources; each chunk holds **islands**; each island holds a whole `PLNb`
resource; that holds the Things. Measured against the two PS3 saves that use it (*Meched Inc.*,
42 chunks; *New Heights*, 129):

```
ChunkFile      sha1 chunkHash                       subVersion > 0x130
               StreamingCheckpoint[] QuestTracker[] QuestSwitch[] CollectableData[]
               i32 n, then n resource descriptors WITH AN INLINE TYPE   (>= 0xde)
               v3 min, v3 max, 4 bools, i32 n + n GUIDs, i32 n + n SHA-1s
StreamingIsland i32 timeZone, i32 flags, v3 min, v3 max
               bytearray planData        <- a complete PLNb resource, header and all
               the same four lists, then the GUID and hash lists
RStreamingChunk  StreamingIsland[] (references), then an intvector of chunk codes
```

**171 chunks, 2,553 islands, 10,837 Things, 9 music sequencers**, every island opening and the
chunk's own stream ending exactly on its last byte; `plan.test.ts` pins all four numbers. The 32
chunks fetched from the public archive (three levels, PS3 and PS4) hold 5,832 Things and **no
sequencer at all** — the plumbing is proved and the payoff still hypothetical.

⚠️ **An island that will not open is reported, not swallowed.** Islands are independent resources
in one list, so one failing says nothing about its neighbours: `LevelParse.problems` carries them
out and `readBackup` puts them in `failed`. This is the one place in the reader where a partial
result is honest; everything else is one stream, where a bad read poisons what follows.

## The `FAR4` save archive — how a PS3 backup opens

A PS3 level backup is a save-game folder: `PARAM.SFO`, `PARAM.PFD`, `ICON0.PNG` and numbered files
`0`, `1`, … The numbered files are **the game's own `FAR4` save archive, XXTEA-encrypted** — not
PS3 savedata encryption — and the key is a constant that every tool for these files carries:

```
TEA_KEY = 0x01B70CBD 0x149607D6 0x07F94DD5 0x10DB8CA0   (big-endian 32-bit words)
```

The recipe, from `sequencerdump`: sort the fragments **by name as strings**, XXTEA-decrypt each,
strip the last 4 bytes of the *final* one, concatenate, append `46 41 52 34` = `"FAR4"`, then walk
the archive's entries and keep the `LEVEL` and `PLAN` resources. The layout, from the **end**
backwards — the last four bytes are `FAR<rev>` **and are never encrypted**, which is how a save is
recognised without decrypting anything:

```
len-4    char[4]  "FAR4"        rev 2..5; 5 is the Vita and is little-endian in places
len-8    u32      entryCount
len-0x1c sha1     hashinate      HMAC-SHA1 over the archive, rev > 2 (Vita: len-0x20)
         Fat[]    entryCount x 0x1c: sha1[20], u32 offset, u32 size   — always big-endian
         byte[]   the save key, 0x84 bytes: revision, localUserID, root type, root hash
         byte[]   the resources, back to back from offset 0
```

`fatOffset = len - 8 - entryCount*0x1c - 0x14` (rev > 2), minus 4 more on rev 5. The save key is
skippable; the FAT alone gets every resource out. The archive is cut into **0x240000-byte chunks**,
one file each, and each chunk is XXTEA'd on its own. ⚠️ **Only single-chunk saves are measured**;
`../cwlib-ts/src/savearchive.ts` verifies every resource against the SHA-1 in the table,
which turns that unmeasured boundary into a loud failure rather than a corrupt level.

✔ Measured 2026-09-04 on `BCES00850LEVEL01EE7CEE/0` (472,960 bytes): 28 resources, **28 of 28
SHA-1s matching their bytes**, one 275 KB `LVLb` holding **11 music sequencers**, in 102 ms. A wrong
key does not produce 28 matching SHA-1s. Two independent implementations agree on the key and the
table — ennuo's `cwlib/util/Crypto.java` + `SaveArchive.java`, and Zaprit's
[lbp_archive_dl](https://github.com/Zaprit/lbp_archive_dl) `save_archive.rs`, which **writes** one:
a site can serve the same level as a backup zip and as loose resources because it holds the
plaintext and *builds* the save on the way out. The encryption is something a download acquires.

- ❗ `PARAM.SFO` is not encrypted either: `../cwlib-ts/src/psf.ts` reads `SUB_TITLE`, which is
  how the pages title a drop "FJ's Music Hub by Festerd_Jester" rather than `32406766.zip`.
- ❗ **`FAR4` is not `FARC`.** The game's own `base_001.farc` is a different archive family; see
  [game-assets.md](game-assets.md).
- ⚠️ A uid is unique inside a level and **not** across a backup: a folder of forty routinely holds
  two sequencers numbered 7, so anything keyed on a sequencer must key on `file#uid`.
- ⚠️ This project told its users for two days that a PS3 save "cannot be read", with the recipe
  above already in steering. The wrong turn is *The PS3 backup* in
  [answered-questions.md](answered-questions.md).

## The toolkit's `.mod` — a zip, a FileDB and a `FAR4` in the clear

Not a game format: a `.mod` is Craftworld Toolkit's own package, defined by nothing but cwlib's
`types/mods/Mod.java`, and the game never sees one — the toolkit installs its rows into a FileDB
and a FARC. `../cwlib-ts/src/mod.ts` reads and writes it; the page opens one like a zip and
the Import/Export view writes one around the `.plan` ([export-to-game.md](export-to-game.md)).

| entry | what |
|---|---|
| `config.json` | `ModInfo`: `ID`, `type` ("pack"), `title`, `version`, `author`, `description` |
| `data.map` | a FileDB, revision `0x01480100` — LBP3 rows: `i16` path length, path, `u32` date, `u32` size, SHA-1, `u32` GUID; ascending GUID |
| `data.farc` | the rows' bytes as a `FAR4`: sorted by SHA-1 hex, padded to 4, a 0x84-byte save key holding only the revision (head `0x021803f9`, branch `0x4d5a`/`0xc` — the toolkit's own "Mizuki"), the table, a **zeroed** hashinate |
| `icon.png`, `patches.json` | optional; neither read nor written here |

A new row's GUID is the first free one from `0x00180000`, cwlib's "not used by any game".

✔ **Measured 2026-09-21 against cwlib itself, both ways** — `tools/ModCheck.java`
([tools.md](tools.md)): `Mod` opens a file `writeMod` wrote, every row held under its hash; and a
mod `Mod.save` wrote around a gallery plan opens here as its 116-chip sequencer. Entry for entry,
**`data.farc` is byte-identical** to cwlib's and `data.map` differs only inside the date.
⚠️ No `.mod` from the wild was on this disk; the legacy one-file `MODb`/`MODe` that
`Mod.fromLegacyMod` still reads is not read here.

⚠️ **`data.farc` ends in the magic a save does and is not encrypted.** `readBackup` finds a save
by that magic and XXTEA-decrypts it, so a mod read as a pile fails every SHA-1 — except that a
one-plan farc *begins* with `PLNb` and opens by luck, with a save error beside it.
`readBackupZip` asks `looksLikeMod` before anything else; `readFar` in `savearchive.ts` is the
archive without the cipher.

## The public archive — a level from one hash, with no server

The Mm servers closed in 2021 and their resource store survives as an Internet Archive dump
(`@tamiya99/uploads`), indexed by Zaprit's **LBP Search Facility**, <https://zaprit.fish>
(<https://github.com/Zaprit/LBPSearch>). A listener finds a level there and pastes its **root level
hash** into the tracker; `packages/lbp-tracker-web/src/lbparchive.ts` turns the hash into a URL.

- **The download URL is a pure function of the hash**, from `SlotHandler` in `handlers.go`:
  `archive.org/download/dry23r<h[0]>/dry<h[0:2]>.zip/<h[0:2]>%2F<h[2:4]>%2F<h>`.
- **`archive.org` answers any origin** — `view_archive.php` echoes whatever `Origin` is sent,
  verified from `https://example.github.io` — so the download works from a dev server, a static
  host or a `file://` page alike.
- ⚠️ **`zaprit.fish` sends no CORS headers at all**, on any route. A page cannot read its search or
  its level pages. This is the fact the whole design turns on, and why the route is a hash and not
  a search (the decision is in [tracker-architecture.md](tracker-architecture.md)).
- ⚠️ **A 200 from the archive is not a level.** A missing entry comes back as a short body rather
  than a 404; the sampler rejects anything under a header's length.
- ⚠️ **A hash cannot be found in text with `\b`.** In `…eb%2F8febe1f9…` the character before it
  is the `F` of `%2F`, itself a hex digit, so the boundary fails and a backtracking match lands on
  a 40-digit window two characters off. Take the last path segment; `readPaste` does and a test
  pins it.

✔ **A root level on its own is enough.** "Music Gallery #3" (`8febe1f9…`, LBP3 PS4/PS5, 339 KB)
parses into **31 sequencers with zero problems** — on subVersion `0x218`, which the corpus did not
contain.

**The dependency walk.** An adventure (`ADCb`) has no world of its own and four of twelve
"adventure map" hashes off the index are one; its levels are the type-9 dependencies. So the walk
is **not optional when the root cannot itself be opened**, or a good hash would silently do
nothing. Measured on "Music Gallery #3": the level plus its 17 plans, six at a time, took 10 s
against 3 s for the level alone and gave 46 sequencer rows instead of 31 — but *distinct* songs, by
name and track count, were **16 either way**. The case the walk exists for is a song that lives
only as a plan, which cannot be known to be absent without fetching; it is a checkbox, **off** by
default (`deep: false` in `archive-panel.ts`, and `deep=1` in a link), read once when the open
starts. The walk itself is `packages/lbp-tracker-web/src/resource-walk.ts`, shared with Bonsai.

**The archive's own index is downloadable.** `dry.db`, 2.65 GB of SQLite from
<https://archive.org/download/dry23db>, **10,467,874 level slots**; its `slot` table carries the
20-byte `rootLevel` SHA-1, so the index plus the URL above is a scriptable corpus of every level
that survives — `../cwlib-ts/dev/archive-sample.mjs`. ⚠️ **`slot.game` is which title the
slot was PUBLISHED for, not the revision the file carries**: a level published as LBP2 and last
saved in LBP3 is stored as LBP3, so `game` 1 spans `0x3b7`–`0x3f9` and only `game` 0 reaches
LEERDAMMER. Ids are chronological, so an even spread over them is an even spread over the game's
life.

**Why a search cannot be served from a static page.** Paging through `dry.db` over HTTP — the
`sql.js-httpvfs` technique — needs `Range` **and** CORS on the same URL, and archive.org gives
exactly one of the two:

| URL | `Range` | CORS |
|---|---|---|
| `archive.org/download/dry23db/dry.db` | ✔ `206 Partial Content` | ✘ no header at all |
| `archive.org/cors/dry23db/dry.db` | ✘ ignored: `200 OK`, `Content-Length: 2651348992` | ✔ echoes the origin |

If a serverless search is ever wanted, the way in is our own index — `dry.db` reduced to id, name,
author, hearts and root hash, sharded by search prefix — or one header upstream
(`Access-Control-Allow-Origin: *` on `/search` and `/slot/{id}`). What was learned scraping the
site, for whoever tries again: every route is Go `html/template` with no API; the result table has
ten fixed columns; the level page carries the SHA-1 in a `<span class="code">`; and ⚠️ the site's
`?page=` is zero-based (offset `page * 50`) while the template prints `page + 1` except on a full
page, where the handler overwrites it with `page`.

## Bonsai — a live server, searchable from the page

The archive holds what Mm's servers had until 2021; what has been published since is on community
servers, and the one the tracker opens is **Bonsai**, `https://lbp.lbpbonsai.com` — the official
instance of **Refresh** (<https://github.com/LittleBigRefresh/Refresh>), as its own
`GET /api/v3/instance` says (`instanceName: "Bonsai"`, `softwareName: "Refresh"`, version
`1.0.0+4060ec45` on 2026-10-04). `packages/lbp-tracker-web/src/bonsai.ts` builds the URLs and
reads the answers; `bonsai-panel.ts` drives them. Everything below was measured with `curl` and
in the page on 2026-10-04 unless it says it was read from the source.

- ✔ **Every route under `/api/v3` answers any origin**: `Access-Control-Allow-Origin: *` on a
  search, a level by id, a 404, an asset download and its `OPTIONS` preflight
  (`CrossOriginMiddleware` in Refresh). This is the whole difference from the archive route, which
  is a hash and not a search only because zaprit.fish sends no CORS; here the page searches Bonsai
  directly and still needs no server of ours.
- **The routes**: `levels/id/{id}` and `levels/hash/{sha1}` give a level's metadata, title,
  creator and `rootLevelHash`; `levels/search?query=…&count=…&skip=…` searches titles and
  descriptions; `assets/{sha1}/download` is the resource's bytes, the same the game downloads;
  `assets/{sha1}/image` is a texture converted to PNG. Every answer is `{ success, data }`, or
  `{ success: false, error: { name, message, statusCode } }`.
- ⚠️ **The search is ordered by rating, never by relevance.** `SearchForLevels` matches
  `ILIKE '%query%'` on the title **or** the description and sorts by `CoolRating`; no parameter
  changes it (read from the source). So the page asks for the most a page allows (`count=100`,
  clamped by `GetPageData`) and ranks it itself, title first (`rankLevels`). On "sequencer", 18 of
  the 31 hits say it only in their description, and five of Bonsai's first eight are among them.
- **A creator is found by name, two ways.** `users/name/{name}` looks a registered user up
  **whatever its capitals** (`GetUserByUsername(id, false)`: `subyuko` → `Subyuko`); then
  `levels/byUser?username=Subyuko` lists what they published — ⚠️ **case-sensitive**, `subyuko`
  is a 404. A creator whose levels came across from the archive is a name in other people's
  reuploads: `levels/byUser?username=!FattyMcIntosh` matches `originalPublisher` (the `!` is
  Refresh's `SystemPrefix`), also case-sensitive — 11 levels, 0 for `!fattymcintosh`. ⚠️ There is
  **no user search**: `users/search` answers 404 on Bonsai, which does not permit listing users
  (`PermitShowingOnlineUsers`), so a partial name finds no creator. A name is
  `^[A-Za-z0-9_-]{3,16}$` (`UsernameRegex`), which is what decides whether a query is worth asking
  about.
- ⚠️ **A level is named by its number**, the one in its page's address (`/level/2488`), and the
  number is resolved to a root at every open: a republish keeps the number and changes the hash.
- ⚠️ **`skip` is one-based** (`GetPageData` subtracts one) and **`nextPageIndex` is `0` on the
  last page**: "music gallery", 19 levels in pages of 10, says `11` and then `0`.
- **`game` repeats to take several** (`FromApiRequest` in `LevelFilterSettings.cs`): "music" gives
  475 levels unfiltered and 435 with `game=lbp2&game=lbp3&game=vita`. Values are Refresh's
  `TokenGame`: 0 LBP1, 1 LBP2, 2 LBP3, 3 Vita, 4 PSP, 6 beta.
- ⚠️ **Rate limits, read from the source and not provoked**: `assets/…/download` 70 per 60 s,
  then 30 s blocked (`ResourceApiEndpoints.cs`); `…/image` 100 per 60 s; level lists — the
  search and `byUser` — 50 per 240 s, then 180 s; `users/name/` 30 per 180 s, then 120 s.
  Unauthenticated, the bucket is the remote address, and a violation is `429` (Bunkum's
  `RateLimitService`). The dependency walk is capped at 60 for this, and a search costs at most
  three level lists and one user lookup.
- ⚠️ **A 200 is not a resource here either.** All eight plans that "Random Music Sequencer
  Melodies" (#19986) depends on answer `200` with `Content-Length: 0` and `cf-cache-status: HIT`,
  while `assets/{sha1}` (the asset's metadata) says 404 for them; a hash Bonsai has never seen
  gets a real `404`, cached by Cloudflare for four hours. The walk counts anything shorter than a
  header (`HEADER_MIN`) as missing. ⚠️ The image route does the same: `200 image/png`, empty
  body, for #19986's icon.

**What opens.** Twelve levels off a "music" search, read with `readBackup`: every LBP2 and LBP3
level parses (revisions `0x3f8`, and `0x3f9` on subVersion `0x218`), the two LBP1 ones (`0x272`)
are refused by the version bound, and two that failed on "quest type 2 has no reader" were a
`PWormhole` read under the wrong mask bit and open now — *54* in
[answered-questions.md](answered-questions.md). Six of six Vita music levels (`0x3e2`, branch `0x4431`
revision `0x87`, read off their headers) fail with "the world Thing carried no WORLD part". So the
search asks for `game=lbp2&game=lbp3` only, and a link to an LBP1 or PSP level is refused before
anything is downloaded, since neither game has a Music Sequencer; a Vita link is tried and the
reader says why it fails.

**The walk, over three levels**: #19986, 8 of 8 plans empty as above; "Hover-Kart Havok!"
(#20086), 10 of 13 plans came; "Table-Top Bowling" (#834), 75 openable parts, cut at 60 in 6.6 s.
None of them added a sequencer the level did not already hold (10, 5 and 4, with and without),
which is the archive's "Music Gallery #3" measurement again: the walk stays off by default.

## The corpora

Every corpus is somebody's own data and **none of it may be committed**; `.gitignore` covers
`fixtures/`, and the SHA1-named resources in the toolkit checkout are referenced by path.

| corpus | where | what it is |
|---|---|---|
| the toolkit checkout | `C:\Users\sgdc3\Desktop\LBP\toolkit\` `data*\` (`LBP_LEVELS`) | 18 loose LBP2/LBP3 level resources, revisions `0x3b8`–`0x3f9`, one on branch `0x0213`; plus two PS3 save folders (`BCES00850…`, `BCES01663…`). ⚠️ The sibling `out*\` folders are that tool's MIDI output — ignore them |
| the cwlib dump | `fixtures/levels/sequencers.jsonl` | 129,696 rows over **19 files** (22 levels walked), produced by cwlib through the deleted `RawDump.java`; the golden fixture, unregenerable, and still holding 23,911 duplicate rows — [lbp-modding-toolchain.md](lbp-modding-toolchain.md) |
| the ten-level subset | the ten files of the above that `verify-levels.ts` matches | **149 music sequencers, 62,158 placements, 953,791 notes, 1,448,224 records** — the numbers every MIDI and pool measurement quotes |
| six PS3 saves | the two in the checkout, plus downloaded backups | 663 resources, 224 plans, 172 + 19 sequencers |
| the archive sample | `fixtures/archive/` | 103 root levels spread over LBP1, LBP2 and LBP3 slots |
| the archived chunks | fetched through the dependency walk | 32 `CHKb`, 5,832 Things — the only `cf0` corpus |

`../cwlib-ts/test/resource.test.ts` and its siblings read `LBP_LEVELS` and **skip** when it is
absent, so the suite passes on a machine without the game.

## The reader's version bound — `LBP3_MIN_VERSION = 0x3b7`

`../cwlib-ts/src/serializer.ts` refuses anything older. Two measurements put it at `0x3b7`
rather than the corpus's own `0x3b8`: cwlib has exactly one gate at `0x3b8` in its whole tree
(`PPhysicsTweak`'s `version > 0x3b8 && configuration == 0xd`, which `readPhysicsTweak` has), and
all four `0x3b7` levels in the archive sample parse the moment the bound allows them.

What the 103-level sweep finds (2026-09-05):

| version | branch | parses |
|---|---|---|
| `0x3b7` | `0/0` | **4 of 4** |
| `0x3b8`–`0x3f9` | `0/0` | **78 of 78** |
| `0x272` | `4c44` (LEERDAMMER) | 0 of 19 at the bound; **19 of 19 identical to cwlib, Thing for Thing**, with it lowered by hand |
| `0x26e` | — | 0 of 1: the chunk table is not where this reader looks |
| — | — | 1 file the archive stores truncated (`0-aaaffe`, 4,327 bytes) |

**82 of 103, with no failure anywhere in the range the reader claims.** Below it, twelve part
readers were wrong for LBP1 files and are fixed (`fillThing`, `readPos`, `Polygon`, `readShape`,
`readRef`, `readGroup`, `readMetadata`, `readRenderMesh`, `readTrigger`, `readJoint`,
`readSwitch`, `readCreature` — the gates are in *28* in
[answered-questions.md](answered-questions.md)), and all nineteen files read identically to
cwlib. ❗ **The bound has not been lowered anyway**: LBP1 has no Music Sequencer, and the range
between `0x272` and `0x3b7` has **zero coverage** — no file in the sample sits there, and 2 of 19 at
the start of that work is what "reading an older layout with newer rules and producing plausible
nonsense" looks like from the outside. Whether to admit an *allowed set* (`0x272` plus
`0x3b7..0x3ff`, refusing the untested span between) is a decision, in *28* in
[open-questions.md](open-questions.md), with the other leftovers of the sweep.

### How a reader bug is found, the technique

1. `tools/CwlibTrace.java spans` for cwlib's part boundaries with offsets, and
   `../cwlib-ts/dev/trace-level.ts` for ours; the first part whose span disagrees names the
   reader and therefore the cwlib file to open. ❗ Reach for this before a hex dump.
2. Wrap every `Serializer` method to log each read as `(name, start, end, value)` — **values, not
   just widths**; widths align at any offset, values do not. The tail of a part that reads
   plausibly (`radius 250`, `angleRange 180`) says that part is aligned and the next field is not.
3. List every top-level Thing with its span and look for the one whose **size** breaks the pattern:
   nineteen Things of 575–588 bytes and then one of 64 says exactly where to look, with no
   byte-level reading at all. `0xaa` followed by a plausible uid varint locates the true next Thing,
   which turns "how far off are we" into a number.
4. Then, and only then, the raw bytes at the disagreement.

❗ **A field that is empty or zero everywhere in the corpus is untested, whatever it is declared
as.** Two of the four bugs in `8b904be1`, `69318581`, `7c0f1a1d` and `5576f758` were exactly that
shape, found on the same day.
