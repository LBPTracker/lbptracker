# `@lbptracker/tools`

Command-line tools around the tracker: Node programs that run on a developer's machine, against
data that lives on it, and produce what the app serves. Nothing here is bundled or shipped.

| tool | what it does |
|---|---|
| `src/song-index/` | the song index the app's open dialog searches: every music sequencer of the public archive's LBP2 and LBP3 levels, grouped into songs with their variants, makers and levels. `npm run song-index -- <step>` from the repository root |

How to run each, and the environment variables, are in `steering/tools.md`; what the song index
found is in `steering/level-sources.md`, *The song index*.
