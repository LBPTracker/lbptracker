# Game assets — where the audio lives and how to read it

All measurements are from the retail LBP3 PS4 build `CUSA00063`: its **01.00 install** at
`D:\PS4Games\CUSA00063\` and its **01.28 update** at `D:\PS4Games\CUSA00063-patch\` — `APP_VER` in
each folder's `sce_sys/param.sfo` (01.00, category `gd`; 01.28, `gp`), read 2026-10-25. The update
is a second layer, with its own `eboot.bin`, FileDB, remap, `patch_001.farc` and level archives;
what it changes is cwlib-ts's steering/level-files.md, *The 01.28 update*. The tree and the counts
below are the install's. Nothing here is encrypted or obfuscated.

```
D:\PS4Games\CUSA00063\
  gamedata\audio\
    ps3_main.fev  ps3_lbp3.fev  ps3_lbp2_dlc.fev  ps3_move.fev …   FMOD Designer projects
    sfxbank_compressed.fsb        1048 samples  — SFX (and 25 SFX-bank copies of instruments)
    musicbank.fsb                   28 samples  — ambiences/loops, MP3
    voiceover.fsb  gibberish.fsb  lbp3_vo_eng.fsb  …               dialogue
    lbp3\music\*.fsb   lbp2\music\*.fsb   move\music\*.fsb         one bank per licensed track
    <language>\*.fsb                                               localised dialogue
    music\samples\<family>\…\*.smp                                 ← THE SEQUENCER'S SAMPLES (inside the FARCs)
    music\instruments\*.rinst                                      ← its instrument definitions (inside the FARCs)
  gamedata_orbis\spu\fmodextinput.prx  fmodsmsreverb.prx  fmodsmswavehammer.prx   the audio plugins — ⚠️ the copies
  sce_module\libc.prx                                              the game's own libc    this project reads are the
                                                                                          PATCH ones (eboot-re.md)
  base_001.farc  chunk1_001.farc  craftworld_001.farc  intro_001.farc   game resources, by SHA-1
  output\orbisguids.map                                            the FileDB: GUID → path + SHA-1
```

⚠️ The `.fev` projects are still named `ps3_*` in the PS4 build — the audio assets were carried
over from the PS3 version untouched. Do not read anything into the prefix.

## ❗ The sequencer's samples are `.smp` files in the FARCs, not the FSB banks

Established 2026-09-01, and it invalidated the assumption the FSB half of this file was first
written under. The music sequencer's samples are **plain RIFF/WAV files stored in the FARC
archives**, addressed by GUID through the game's own file database. The chain, verified end to end:

```
RInstrument.SampleGuids[i]                       e.g. 122694
  → output/orbisguids.map (FileDB, 107,673 rows)  → gamedata/audio/music/samples/keys/piano/piano_c3.smp
                                                    + SHA1 48a8ca84…
  → base_001.farc (19,545 entries, by SHA1)       → 73,440 bytes beginning "RIFF"
```

`tools/GuidLookup.java` does the lookup and `tools/ExtractGuid.java` the extraction
([tools.md](tools.md)); the eboot loads them as type-49 (`RSample`) resources inside the
sample-preload worker (`v0x1c38aa`, the only `mov eax, 0x31` site in the binary).

**How we know it is this side and not the FSB side.** `piano.rinst` (GUID 122737, the "Piano"
entry in the stock instrument table) decompresses to an `INSb` resource whose `SampleGuids` are
`122697, 122696, 122695, 122694, 122693` — exactly `piano_c6` down to `piano_c2` — paired with
`baseNote` values `84, 72, 60, 48, 36`. Nothing points at an FSB index. And a scan of all 514 banks
finds instrument-shaped names in essentially one place — 25 of them in `sfxbank_compressed.fsb` —
and nothing at all for Glockenspiel, Marimba, Vibraphone, Music Box, Clarinet or the rest of the
stock instruments. Those 25 are SFX-bank copies at a different quality: the FSB piano is 22050 Hz
4-bit IMA ADPCM (C6 at 32000 Hz), audibly gritty, and that grit is what the first listening test
heard and mistook for a bug in our resampler.

**The real piano, measured:** `piano_c2.smp` … `piano_c6.smp` are **48000 Hz, 16-bit PCM, mono,
uncompressed**. The library is 216 entries under `gamedata/audio/music/samples/`, organised by
family (`keys/`, `guitar/`, `orchestra/`, `percussion/`, `synths/`, `sfx/`), and **68 `.rinst`**
instrument definitions under `gamedata/audio/music/instruments/`, one per stock instrument. ⚠️
Three of the 216 sample paths carry a `#` and 48 a space, which is why `asset()` in the web package
percent-encodes every segment.

### The instruments' names live in the palette plans, not in the `.rinst`

An `.rinst` carries no name; the name a player sees belongs to the **palette item** that places it.
Every `gamedata/.../instr_instrument_*.plan` (and, for the three plain waveforms, a
`gad_instrument_*.plan`) is an `RPlan` whose `InventoryItemDetails.titleKey` is a LAMS id, and
`gamedata/languages/english.trans` turns that into the words: "Synth: Saw Wave", "Plucked: Harp",
"Percussion: Beatbox Kit 2". The plan's dependency list holds the `.rinst` GUID, which is what
joins the two ends.

Measured 2026-09-07 with `tools/InstrumentNames.java`: **68 plans name all 68 `.rinst` files, each
by exactly one plan, and no two plans disagree.** The table is
`packages/lbp-tracker-web/src/editor/instrument-labels.ts` and a test holds it against the
manifest. The label's own prefix is the game's category -- Keys, Plucked, Wind, Voice, Percussion,
Tuned Percussion, Synth, SFX -- and ⚠️ that is **not** the family the tracker colours a chip by,
which comes from the asset's path and is release-shaped (`move_pack`, `lbp3`, `baiyon`). The game
files `space_piano` under Synth and the path files it under `keys`; both are kept.

### The samples carry their own loop points — and you must honour them

Every `.smp` is a RIFF with the sound designer's DAW metadata still attached. Most of it is debris
(`CDif` from Cool Edit, `bext`, `acid`, `JUNK`); two chunks matter.

**`smpl` — the sustain loop.** 79 of the 215 samples have one, including every pitched
multisample. All type 0 (forward), count 0 (infinite). The piano's:

| sample | frames | loop |
|---|---|---|
| `piano_c2` | 50367 | 24168 → 50365 |
| `piano_c3` | 36546 | 17558 → 36544 |
| `piano_c4` | 36563 | 20251 → 36561 |
| `piano_c5` | 30933 | 22361 → 30931 |
| `piano_c6` | 9966 | 7793 → 9953 |

⚠️ **Do not use `start` and `end` verbatim — loop `[start−1, end+1)`.** Measured, not reasoned: the
join has to be phase-continuous, so the question is which frame follows which at the wrap. Across
the 60 loops with room on both sides, the jump at the join in units of the sample's own average
adjacent step:

| join | mean | median | worst |
|---|---|---|---|
| `d[end] → d[start-1]` | **0.59×** | **0.37×** | 3× |
| `d[end+1] → d[start]` | 0.98× | 0.33× | 16× |
| `d[end] → d[start]` (the literal reading) | 3.28× | 1.86× | 69× |

A mean below 1 means the join is smoother than an average pair of adjacent frames. The literal
reading is 5× worse, and a listener heard it as a transient on high notes — `piano_c6`'s loop is
45 ms and wraps 22 times a second, so a 2× step becomes a 22 Hz buzz. ❌ **And the literal
reading is the game's.** The eboot's loader (`v0xb3e520`, *The loader* in
[synth-engine.md](synth-engine.md)) takes `smpl` as written — `[dwStart, dwEnd + 1)` — and copies
the loop's first 16 frames past its end, so the engine's join is `d[dwEnd] → d[dwStart]`, the
3.28× row. `loopRegion()` in `packages/lbp-tracker-lib/src/wav.ts` returned the 0.59× region until
2026-09-08, a frame longer than the engine's and a few cents flat on a short loop; it returns the
loader's now, and `engineSample()` applies the patch. The table stays as a measurement of the
*files*: whatever the sound designers cut their loops for, the game plays them literally, and
whether that clicks on a sustained F5 is what a capture would show (*The piano's loop contour* in
[open-questions.md](open-questions.md)). ⚠️ The metric is
meaningless for synthesised waveforms: `kenny_saw_a4` measures 108× because a sawtooth's vertical
edge *is* its shape. Judge it on the acoustic multisamples.

⚠️ **After the join is perfect, a periodic artefact remains — the loop's own contour.** Reported
as a click on high notes like F5, and traced with the metric that matches the ear: not "is there a
transient" but "is something repeating at the wrap rate":

| note | wrap rate | envelope modulation at that rate | background | ratio |
|---|---|---|---|---|
| **F5** (77) | 14.8 Hz | **5.75%** | 0.29% | **20×** |
| C6 (84) | 22.2 Hz | 5.29% | 0.19% | **28×** |
| C4 (60) | 5.6 Hz | 5.36% | 2.41% | 2.2× |

`piano_c6`'s loop region has a **1.70 dB peak-to-trough amplitude contour of its own** (17.7%), so
repeating it modulates the output at the wrap rate however cleanly it is spliced. Three metrics
missed this: the adjacent-sample step at the wrap is only 1.5× the median, high-frequency energy at
the wrap is 0.98× the background, and single-block rendering is bit-identical to 128-frame blocks.
A 5% modulation is not a transient; it is a flutter, and only a modulation measurement finds it.
Two fixes were tried: a decay envelope (`VoiceSpec.decayDbPerSecond`) drops the *ratio* from 43.7×
to 1.4× by raising the background, not by removing the flutter; a loop crossfade (`crossfadeLoop`)
measurably makes it **worse** — 5.75% → 5.72% → 5.91% → 6.79% → 9.51% for fades of 0, 2, 5, 10 and
20 ms, because a long fade mixes in the louder pre-loop material. Both functions are kept only so
the dead ends are not re-explored.

❗ **That measurement predates the amplitude envelope.** The game's own envelope has since been
read (`Params[11..14]`, [synth-engine.md](synth-engine.md)): the piano's is decay 0.527, sustain
**0.070**, so a held note falls to 7% before the loop has wrapped many times. Whether the flutter
is still audible through it has not been re-measured, and nothing settles it but a capture of a
sustained F5 from the game run through the same modulation measurement — *Residues* in
[open-questions.md](open-questions.md).

**`inst`** — key range and unity note, present on a handful of samples. ⚠️ **`smpl`'s `unityNote`
is not authoritative**: it reads 60 on every piano sample, C2 through C6, which is the DAW's
default. `RInstrument`'s `baseNote` (84/72/60/48/36) is the real pitch reference.

### ⚠️ Two sample GUIDs shared one filename, and one kit played the other's kick

`ExtractGuid.java` named each extracted file after the **basename** of its FileDB path, and two
GUIDs under `audio/music/samples` end in the same one:

```
g129030  gamedata/audio/music/samples/percussion/a_kit_1/kick.smp        45,044 bytes
g148304  gamedata/audio/music/samples/baiyon/baiyon_drums/kick.smp       46,186 bytes
```

The second write silently clobbered the first and `manifest.json` listed both GUIDs pointing at the
survivor — 216 rows, 215 files — so one kit played the other's kick in every render this project
had made. Found 2026-09-03 only because a listener recorded the game and synced it against a
render. Long-term average spectrum of `Ascetic`'s two kits, ours against the game's:

| band | before | after |
|---|---|---|
| 30-60 Hz | −0.81 dB | **−0.04 dB** |
| 60-120 Hz | −1.57 dB | **−0.20 dB** |
| 120-250 Hz | **+2.10 dB** | **−0.16 dB** |

and the envelope correlation over 18 seconds went from 0.72 to **0.79**. The whole "our low end
sits an octave too high" signature was one wrong file; so was the one-shot rule invented to
compensate for it (*10* in [answered-questions.md](answered-questions.md)). The extractor now
prefixes a clashing name with its GUID and prints the clash — [tools.md](tools.md).

## The FSB banks — the SFX side, verified and not the sequencer's

Counted 2026-09-06 by reading every bank's header: **514 FSB4 banks holding 4,846 samples under
`gamedata\audio`**, plus 68 single-sample banks under `gamedata\lbp2` and `gamedata\lbp3`. A
236-bank scan of the main directory earlier split its 4,488 samples into 3,601 IMA ADPCM and 887
MPEG, at sample rates 4000, 8000, 11025, 16000, 22050, 32000 (1,309) and 44100 (2,526) Hz. The
reader (`tools/fsb.py`, `packages/lbp-tracker-lib/src/fsb.ts`, `ima.ts`) is how the game's SFX
and ambiences are read and it is verified byte-exact; it is simply not the sequencer's audio path.

### FSB4, as LBP3 uses it

File header, 0x30 bytes, little-endian:

| offset | type | field |
|---|---|---|
| `0x00` | char[4] | `"FSB4"` |
| `0x04` | u32 | `numsamples` |
| `0x08` | u32 | `shdrsize` — total bytes of sample headers |
| `0x0c` | u32 | `datasize` |
| `0x10` | u32 | `version` — `0x00040000` in every LBP3 bank |
| `0x14` | u32 | `mode` — `0x20` (MPEG-padded) in every LBP3 bank |
| `0x18` | u8[8] | zero |
| `0x20` | u8[16] | hash |

Then `shdrsize` bytes of **variable-length sample headers**, then the sample data back to back in
header order. Each header starts with `u16 size` covering the whole header, so you **walk** the
headers, you never index them:

| offset | type | field |
|---|---|---|
| `+0x00` | u16 | `size` |
| `+0x02` | char[30] | name, NUL-padded (truncated to 30 chars — long names are cut) |
| `+0x20` | u32 | `length_samples` (per channel) |
| `+0x24` | u32 | `length_bytes` (compressed) |
| `+0x28` | u32 | `loop_start` |
| `+0x2c` | u32 | `loop_end` |
| `+0x30` | u32 | `mode` — FSOUND_* bits |
| `+0x34` | i32 | `freq` |
| `+0x38` | u16 | `volume` (0-255) |
| `+0x3a` | i16 | `pan` (128 = centre) |
| `+0x3c` | u16 | `priority` |
| `+0x3e` | u16 | `channels` |

Mode bits observed: `0x02` LOOP_NORMAL, `0x20` MONO, `0x40` STEREO, `0x200` MPEG, `0x2000` 2D,
`0x80000` HW2D, `0x100000` 3D, `0x400000` IMAADPCM. Bits never seen set are deliberately left
unnamed in `tools/fsb.py` — guessing at unseen flags is how you get a decoder that is quietly
wrong.

### The codecs — measured

**IMA ADPCM (all the SFX).** FMOD's variant: **36 bytes per channel per block, 64 samples per
channel per block.** A block is a 4-byte preamble (`i16 predictor, u8 step index, u8 pad`) then 32
bytes of 4-bit nibbles, low nibble first. For stereo the channels' 36-byte blocks are stored back to
back, **not** nibble-interleaved. Pinned down by the compressed size over the sample count landing
on 36/64 = 0.5625 for every mono sample, with the tail padded to a 32-byte boundary:

| sample | `length_samples` | `length_bytes` | blocks × 36 |
|---|---|---|---|
| `triangle_synth_C4_01.wav` | 9536 | 5376 | 149 × 36 = 5364 → padded 5376 |
| `physx_tinfoil_impact_02.wav` | 14528 | 8192 | 227 × 36 = 8172 → padded 8192 |
| `pod_search_ping_02.wav` (stereo) | 95808 | 107808 | 1.125 B/sample = 2 × 0.5625 ✓ |

**MPEG (`musicbank.fsb`, all the `*/music/*.fsb`, dialogue).** Plain MP3 frames.
`amb_mexican_graveyard_LOOP.wav` is 3572352 frames at 44100 Hz = 81.0 s in 1621536 bytes =
160 kbps stereo. In the browser these go straight into `decodeAudioData`.

**The decoder is verified against the game's own data**: decoding `piano_C3.wav` gives 66112 frames
at 22050 Hz, RMS 2770, peak 28588, zero clipped samples, and autocorrelation of the decoded PCM
puts the fundamental at **132.8 Hz against C3 = 130.81 Hz** — inside one autocorrelation bin. A
wrong ADPCM decoder produces noise, not a clean tone at the expected pitch.

```bash
python tools/fsb.py list "D:/PS4Games/CUSA00063/gamedata/audio/sfxbank_compressed.fsb" piano
```

⚠️ **Never look a bank sample up by substring.** Bank names carry their `.wav` suffix, so a search
for `piano_C4` misses the exact match and falls through — where **`epiano_C4.wav` contains
`piano_C4`** and comes first in bank order. That silently loaded the electric piano into the
acoustic piano's key zone in the first listening test. `findSample` in
`packages/lbp-tracker-lib/src/fsb.ts` tries exact, then exact + `.wav`, then prefix, and only then
substring. Filenames are a hint for display; the pitch reference is always `RInstrument`.

## The FARC archives

`base_001.farc` (1.7 GB), `chunk1_001.farc` (3.3 GB), `craftworld_001.farc` (139 MB),
`intro_001.farc` (90 MB): resources back to back, each starting with its 4-character magic, indexed
by SHA-1 from a table at the end whose last 12 bytes are `[u32 BE][u32 BE]"FARC"`. The index was
**not** decoded by hand — an evening at 24/28/32/36-byte strides produced nothing plausible — and
did not need to be: cwlib's `FileArchive` reads it, and that is what `ExtractGuid.java` links
against. ❗ `FARC` is not `FAR4`, the save-archive family in
[cwlib's level-files.md](../../cwlib-ts/steering/level-files.md).

## Asset licensing — a design constraint, not a footnote

Every sample above is copyrighted Sony / Media Molecule material, and every level in the public
archive is its creator's work. **Nothing of either is in this repository**: `fixtures/` is
gitignored and always has been, and `vite build` never copies it — `fixtures/` is served by a
middleware in dev and preview. The one step that puts any of it into `dist/` is the deployment's
staging, `packages/lbp-tracker-web/dev/stage-site.ts`, which runs only under `npm run stage` /
`deploy`, copies exactly what the `rinst` and `smp` manifests name, and prints what it copied.

The code's constraint is that assets arrive at runtime, never baked into a build: the pages read
the user's own files client-side, and `packages/lbp-tracker-web/src/assets.ts` fetches manifests and
samples from `../` relative to itself, which is whatever the deployment's root is. **Where a
deployment gets those files from is the deployment's decision, and the Cloudflare deployment
serves them from the same origin as the site** (*Deployment* in tracker-architecture.md). This note used to say "the tracker
must not redistribute them"; the sentence is gone rather than quietly contradicted, because a
steering file that forbids what the project does is a trap for the next session. The copyright
fact is unchanged and is why it was worth weighing.

❗ **The instrument icons are traced from the game's own textures, and they are in this
repository.** Until 2026-09-07 the icons were marks of this project's own and this section could
say the repository held nothing of the game's; that sentence would now be false, so it is gone
rather than left standing. `src/editor/icons.ts` holds 68 silhouettes traced from the textures the
palette plans carry, and they are a derivative of Sony / Media Molecule's art.

⚠️ **The alternative was tried, and the owner rejected it.** On the same day a full set was drawn
from scratch -- our own geometry, showing what the game's icons show without touching their pixels
-- specifically to avoid this. The owner judged the result worse to use and asked for the traced
set back, knowing what it is. Recording that here is the point: the next session should not
re-run the experiment thinking nobody considered it.

`tools/IconDump.java` and `tools/trace-icons.py` regenerate the file from a copy of the game, so
what is committed is a drawing rather than a texture. The samples and the levels are unchanged and
still arrive at runtime.

❗ **Nothing in the app claims either way.** The footer used to say "no game data is included
here", which was true of a tracker that only read the user's own copy and would not be true of that
deployment, so it was removed; `LICENSE` says only that this repository contains no game data,
which stays true. See `packages/lbp-tracker-web/src/footer.ts`.
