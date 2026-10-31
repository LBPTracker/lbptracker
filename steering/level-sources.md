# Level sources — the public archive and Bonsai

Where a level comes from when it is not a file the user dropped: the Internet Archive's copy of
Mm's servers, reached by a root hash, and Bonsai, a live server the page searches. Both hand back
resources; what is inside them, and how a pile of them is walked, is cwlib's —
`../../cwlib-ts/steering/level-files.md`. The page's side is `packages/lbp-tracker-web/src/`
`lbparchive.ts`, `bonsai.ts`, `archive-panel.ts`, `bonsai-panel.ts` and `resource-walk.ts`.

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
author, hearts and root hash, sharded by search prefix (the song index below is that, for songs
rather than levels) — or one header upstream
(`Access-Control-Allow-Origin: *` on `/search` and `/slot/{id}`). What was learned scraping the
site, for whoever tries again: every route is Go `html/template` with no API; the result table has
ten fixed columns; the level page carries the SHA-1 in a `<span class="code">`; and ⚠️ the site's
`?page=` is zero-based (offset `page * 50`) while the template prints `page + 1` except on a full
page, where the handler overwrites it with `page`.

## The song index — every published sequencer, as static files

The open dialog's first tab, "song index", searches **songs** rather than levels: every music
sequencer in the archive's LBP2 and LBP3 levels with more than 1,000 plays, grouped so that copies
of one song are its variants. The page's side is `packages/lbp-tracker-web/src/song-index.ts` (the
format and the search, tested by `test/song-index.test.ts`), `song-index-panel.ts` and
`widgets/SongIndexPanel.vue`.

- ❗ **The index says where a song is, never what it is.** Every variant and every level row
  carries a resource SHA-1 and the sequencer's uid, and **open** is the demo button's route:
  `rememberSong(sha1, uid)` then the archive panel's `open`, so the song arrives through
  `?level=…&seq=…` like any shared link, with the game's samples, and the address bar is its link.
  No note data is shipped. The archive panel's `open` takes a `report` for this route: its lines
  go to the song's detail and a failure leaves the archive's tab where it is, so a copy that will
  not download is reported beside it and another can be picked.
- ❗ **The song's own open button goes to its origin level, not to the main variant's copy.** The
  export puts a variant's copy in its most played level, so "Haze - Velvet--Audio" opened in
  "LittleBigCity 2" (1.2M plays) instead of *Velvet--Audio's Music Gallery (V.2)*, where it was
  first published. `openTarget` in `song-index.ts` takes the origin level's copy when it has one
  (the button then says "Open the original") and the main variant's otherwise.
- ⚠️ **A copy the level names nobody for takes the index's maker.** The author is read off the
  sequencer's group chain (cwlib's `sequencerAuthor`), and a sequencer never grouped has none:
  measured 2026-10-31 on `ad4f399c…`, 7 of its 31 sequencers (Haze, uid 27943, among them) carry
  only the gadget's `MM_Studio` `GROUP` and no `groupHead`, while the others' chains name
  Velvet--Audio. Opened from the index, the copy it named (`Credit`: that resource's SHA-1 and that
  uid) gets the song's maker where the file names nobody — `credited` in `song-index.ts`, never
  over a name the file carries, never for a song out of the game. Opened any other way, a `?level=`
  link included, it stays empty: that is an inference from the other copies, not the file.
- ✔ **The SHA-1 may be a plan or a chunk, not only a level root**, and the archive route opens
  both: measured in the page on 2026-10-31 with a song that exists only in a plan ("Game Over",
  `1c870946…`, `seq=11`) and one only in an LBP3 chunk ("'Ghost von Frost'", `3ac0e254…`,
  `seq=6987912`), each opened the named sequencer with no error. The export still prefers a copy
  inside a level root where one exists.
- **The files** (format 3, and 2 is still read), under `fixtures/songindex/`: `index.json` (`format`, `version`, `generated`,
  `songs`, `shards`) names the current export and is fetched with `cache: 'no-cache'`; the export
  is a directory named by its version holding `songs.json` (the list, column-major: one array per
  field) and `song/000.json`…`song/255.json` (a song's variants, makers and every level that uses it, in
  the file `id % 256`). A new export is a new directory, so a cached list can never meet a detail
  file from another export. Measured on the 2026-10-31 export: 33,141 songs, `songs.json` 2.2 MB
  (518 KB brotli), detail files about 18 KB brotli each, 22 MB in all; the list loads in about
  100 ms from the dev server and a search over it is a filter in the page. With every level of
  every song (no cap since the same day) and cwlib 0.4.68's readers: 32,742 songs, 25 MB.
- **Where it comes from**: `npm run song-index` (`packages/lbp-tracker-tools/src/song-index/`, how
  to run it in [tools.md](tools.md), *The song index*), from the archive's whole download: 184,588
  levels with more than 1,000 plays, every level, plan and chunk read with cwlib and every
  sequencer clustered. It is not game data: names, numbers and the hashes of levels that are
  already public. ⚠️ So it is **optional**: `dev/stage-site.ts` ships the current export when the
  checkout has one and says so when it has none, and the panel then says the index is not
  available.
- ⚠️ **A variant is decided by notes, not by name.** Two copies are one song when they play the
  same notes or nearly (a MinHash over the notes on the grid and over each clip's pattern, at a
  similarity of 0.5 or more to the song's most widespread copy); the name a copy carries plays no
  part, which is why a song shows the other names it goes by.
- ⚠️ **A longer or shorter version has a low similarity and is still the song.** "LittleBigMe" by
  Velvet--Audio exists at 6,531 notes and at 18,920: the long one holds the short one, but the
  two share only 41% of their union, under the 0.5 above. So a copy also joins when nearly all of
  the shorter is inside the longer (containment 0.8 or more, taken on the similarity 1.5 standard
  errors below the measured one, the shorter at least 200 notes and a fifth of the longer). Its
  row says `extended` or `shortened` (a variant row's last field since format 2) and the panel tags it "Longer"
  or "Shorter", because a 41% bar would otherwise read as a mistake. 529 of 42,641 copies
  joined this way on 2026-10-31.
- ⚠️ **The maker is not the name on the most copies.** Whoever saves a copy into a plan of their
  own becomes the creator the sequencer's group names, and a copy that spreads further outnumbers
  the original ("Inner Space": Festerd_Jester from April 2011 in 32 levels, SonicBoomXD from
  October 2011 in 60). The maker is chosen among the names first seen within 30 days of the oldest
  (a date being the archived version of a level that holds the copy), then by copies. The archive
  has no creation date for a sequencer, so some songs stay ambiguous; `song-index set-author`
  keeps a manual override for those.
- ❗ **A song out of the game is the game's, whoever's level it is in.** "Dew Shimmers" and the
  8-bit and chiptune remixes come out of LBP2's story; players placed them from the game's own
  items, and cwlib's `sequencerAuthor` skips the game's `MM_Studio` group and climbs to the
  player's, so they were credited to whoever used them most (wurmstich23). Every such copy keeps
  the item's `planGuid` (197129 for "Dew Shimmers") under a group of `MM_Studio`'s. ⚠️ The popit's
  empty music sequencer is a game item too, 120863, under 32,381 songs; the seventeen other items
  with a sequencer are under 26 at most, so 100 songs is the line. A song is the game's when most
  of its copies came from such an item **and** it is the item's main song or its copies still
  carry the game's own text key for a name (`MOVE_DEW_SHIMMERS_MUSIC_NAME`: 388 copies of 197129
  over 20 songs, the item's parts and versions). The rest of an item's songs are players' edits
  and stay theirs; one stray copy in an LBP3 chunk with a game GUID made "FORGOT, LOL." the game's
  until the majority rule. 83 songs from 11 items on 2026-10-31; `songs.json`'s `game` column
  (format 3) marks them, the panel shows "LittleBigPlanet (the game)" as their maker, and they have
  no origin level, the story being on the disc and not in the archive.
- ⚠️ **A search word has to start a word**, after accents are folded and punctuation becomes a
  space: "inner" inside "Award Winner" found an unrelated song before the rule.

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
[cwlib's answered-questions.md](../../cwlib-ts/steering/answered-questions.md). Six of six Vita music levels (`0x3e2`, branch `0x4431`
revision `0x87`, read off their headers) fail with "the world Thing carried no WORLD part". So the
search asks for `game=lbp2&game=lbp3` only, and a link to an LBP1 or PSP level is refused before
anything is downloaded, since neither game has a Music Sequencer; a Vita link is tried and the
reader says why it fails.

**The walk, over three levels**: #19986, 8 of 8 plans empty as above; "Hover-Kart Havok!"
(#20086), 10 of 13 plans came; "Table-Top Bowling" (#834), 75 openable parts, cut at 60 in 6.6 s.
None of them added a sequencer the level did not already hold (10, 5 and 4, with and without),
which is the archive's "Music Gallery #3" measurement again: the walk stays off by default.
