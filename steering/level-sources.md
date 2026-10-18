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
[cwlib's answered-questions.md](../../cwlib-ts/steering/answered-questions.md). Six of six Vita music levels (`0x3e2`, branch `0x4431`
revision `0x87`, read off their headers) fail with "the world Thing carried no WORLD part". So the
search asks for `game=lbp2&game=lbp3` only, and a link to an LBP1 or PSP level is refused before
anything is downloaded, since neither game has a Music Sequencer; a Vita link is tried and the
reader says why it fails.

**The walk, over three levels**: #19986, 8 of 8 plans empty as above; "Hover-Kart Havok!"
(#20086), 10 of 13 plans came; "Table-Top Bowling" (#834), 75 openable parts, cut at 60 in 6.6 s.
None of them added a sequencer the level did not already hold (10, 5 and 4, with and without),
which is the archive's "Music Gallery #3" measurement again: the walk stays off by default.
