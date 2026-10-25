# Reverse-engineering LBP3's eboot and its audio plugins

Read before opening the binary. The address conventions have already cost one session several
hours twice; the rest is the map of what has been found, so the next session extends it instead of
re-deriving it. The tools are catalogued in [tools.md](tools.md).

## The files, and the delta each needs

| file | size | `file = vaddr + …` |
|---|---|---|
| `C:\Users\sgdc3\Desktop\shadPS4\lbp3-ebins\eboot-v128.bin` | 18,497,333 | **`0x4000`** |
| `D:\PS4Games\CUSA00063-patch\eboot.bin` (installed fSELF) | 18,506,517 | **`0x8AD0`** |
| `C:\Users\sgdc3\Desktop\shadPS4\lbp3-ebins\eboot-v100.bin` | 17,218,664 | derive it, don't assume |
| `D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodextinput.prx` | 23,794 | **`0x7e0`** for `v0x0`–`0x4b08`; the BSS segment `v0x8000`–`0xd3b0` is at file `0x5310` |
| `D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmsreverb.prx` | 16,118 | **`0x7c0`** |
| `D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\fmodsmswavehammer.prx` | 11,870 | `prxdis.py hammer map` |
| `D:\PS4Games\CUSA00063-patch\sce_module\libc.prx` | | `prxdis.py libc map` |

⚠️⚠️ **The plugins this project has read are the PATCH copies**, the ones `tools/prxdis.py` and
`tools/prxnid.py` open. The base game's `D:\PS4Games\CUSA00063\gamedata_orbis\spu\` holds
*different* files — 23,614, 14,898 and 11,754 bytes — with a different rodata layout, and a
constant dumped out of one of those at a vaddr from this workspace lands on the wrong value with
no error (measured 2026-09-06: the sampler's `4.0` is at `v0x4584` in the patch file and at
`v0x44f0` in the base one). The eboot is the patch too (`eboot-v128.bin`).

⚠️⚠️ **The delta depends on which file you opened.** `eboot-v128.bin` is the already-peeled ELF —
its own program headers say so (`ebseg.py`: LOAD `off=0x4000, vaddr=0`). The installed `eboot.bin`
is the fSELF, whose container header shifts everything by `0x8AD0`. **All addresses in this
workspace are vaddrs**; convert at the point of use. One-line check: apply the delta to the 4222
script-binding targets and count how many land on a `55 48 89 e5` prologue — the right delta gives
**3559/4222**, a wrong one ~640/4222.

The PRXs are SELFs too: the inner ELF's program headers are not file offsets, and the real offset of
ELF segment `i` is the SELF entry at `0x20 + n*0x20` whose `props >> 20` is `i`. ⚠️⚠️ **Every PRX
address written in this project before 2026-09-02 is 0x40 too high**: `prxdis.py` used `0x7a0` and
`0x780` — the offsets of the 32-byte *digest* blocks that precede those segments. The failure mode
is completely invisible: disassembly from `start` reads `data[start + delta]`, so a uniform delta
error just relabels correct code, and a rip-relative target computed as `vaddr + size + disp` is
read back at `target + delta` — the same error twice, cancelling. **No fact recorded from those
disassemblies is wrong; every address is.** Subtract 0x40 before looking one up.

⚠️ **The failure mode of a wrong eboot delta is silent and convincing too.** The identifier blob is
dense enough that you still read plausible strings — truncated by a byte or two
(`sSlotShareable__Q6SlotID` for `IsSlotShareable__Q6SlotID`) — and the disassembler starts
mid-instruction without complaining. If names look *almost* right, suspect the delta.

❗ **Find the function start before disassembling.** Take the largest `E8` target at or below the
address of interest; when that lands implausibly far away, suspect an indirect call rather than a
long function. `v0x2a1190` cost time twice: it is the `lea rdi, [r14 + 0x4e8]` *inside* the DSP
record builder, whose entry is `v0x2a1144` (`push r14 ; mov r14, rsi`), reached through a vtable
with no direct callers. The same trap in the PRX: `0x250` is inside the scale quantiser, which
starts at `0x240`; `0x3930` is the note walker, not `0x38e0`. A range quoted in a note can stop at
a loop's back-edge — **disassemble past its end**, or you stop before the loop's own conclusion
(the instruction after the stack loop was the whole of question 12).

## The script-binding table

`C:\Users\sgdc3\Desktop\shadPS4\lbp3-re\bindings-1.28.txt` — 4222 `name -> vaddr` pairs. Names
with a `__` suffix are the game's script-VM bindings. They have **no rip-relative reference anywhere
in the binary**, which is why xref hunts for them come back empty: the tables that hold them are
built from `R_X86_64_RELATIVE` relocations, so the pointers exist only as relocation addends.
`lbp3-re\ebrela.py` recovers them by finding the RELA array by shape. ⚠️ Use the **`vaddr` column
only**; the `file` column is computed with the `0x8AD0` delta.

## Techniques that worked here

- **FMOD's code range is derived, not assumed.** FMOD's memory tracker passes `__FILE__` at every
  allocation site, so every rip-relative reference to a `Z:\LBP\sdk\fmod\...cpp` string sits inside
  FMOD code. Collecting those gives FMOD's extent (`v0x9c5da3`–`v0xab6397`) and, per callee, which
  source file it belongs to; every tool in `tools/` marks calls that land there. The same trick
  works for the CWLib paths on the game side.
- **Serialiser walking.** Every LBP resource and part has a serialiser that emits, per field, a
  `lea` to the member offset and a `lea` to the field-name string. Disassemble it linearly and you
  get the whole schema with names — `PSequencer`, `PInstrument`, `RInstrument` and the sample
  slot. ⚠️ `ebschema.py` assumes the member `lea` comes first and the name second; pairing them
  the other way shifts every field by one and still looks plausible.
- **Array element sizes from the growth helper.** An array field passes an element callback whose
  allocation multiplier is the element size (`lea edx, [r13*4]` → 4 bytes) — how `Notes` was
  measured, cross-checked against `Name` giving 1.
- **Field-name neighbourhoods.** Serialiser name strings are packed contiguously, so dumping the
  strings around one known field name usually reveals the whole struct.
- **Import-library names from the dynamic section.** `DT_SCE_IMPORT_LIB` entries encode
  `(id << 48) | (version << 32) | name_offset`; the id maps to the symbol suffix through the same
  base64 alphabet as NIDs. That is how the `FMOD*` libraries and the 5 `libSceAudioOut` imports were
  found, and ⚠️ a NID's `#L#M` suffix names its module — read it before building anything on the
  symbol (`ebdyn.py`).
- ❗ **RTTI names vtables, and this binary has it.** 204 Itanium-mangled `N4FMOD…E` strings
  (measured 2026-09-06 with `N4FMOD[A-Za-z0-9_]+E\0` over the image) and **322 nameable vtables**.
  Three hops, each a lookup in the relocation map: `name -> type_info + 8 -> type_info -> vtable - 8
  -> vtable`; `ebvtable.py` does it in a third of a second. ⚠️ **Every vtable slot is ZERO on
  disk** — this is a PIE and the pointer lives in an `R_X86_64_RELATIVE` addend (plain 24-byte
  `(r_offset, r_info, r_addend)` triples with `r_info == 8`, recoverable by a stride-8 sweep with no
  section headers), so searching the image for a pointer returns nothing, which reads as "no
  RTTI". ⚠️ A pointer to `X`'s type_info comes from `X`'s vtable *and* from every derived class's
  `__si_class_type_info` at `type_info + 16`; half the candidates a naive walk finds are
  type_infos, and dumping one prints strings where functions should be. Require slot 0 to be code.
- **Naming a slot, once the class is named.** Nothing carries method names; identify a slot from the
  call site's *shape*: `v0xa0b539` calls `[vtable + 0x98]` with two floats and no integer, which is
  `setPan(pan, spread)` on a `ChannelSoftware` and could not be the four-argument
  `DSP::setDefaults` a structural search had offered.
- **Relocation addends over segment arithmetic.** The scale table's address was computed from the
  SELF mapping once and landed 48 bytes early on a row of zeros; the `R_X86_64_RELATIVE` addend on
  the pointer slot is the number. Read the relocation; do not compute the address.
- **Run the thing.** `tools/runhammer.py` loads a PRX into a Windows process; it settled in a minute
  what three static readings had got wrong (an absolute-offset search is only sound if every access
  uses the same base).
- **Byte-scan for `E8` displacements** landing on a known callee to find its callers, then search
  backwards for `55 48 89 e5` for the caller's prologue — how the channel-banding writer was found.
  `ebxref.py` does it in vaddr space.
- ⚠️ **A capstone loop over a range needs `md.skipdata = True`.** Without it `disasm` stops at the
  first byte it cannot decode, and a scan of FMOD's whole range comes back *empty* — which reads
  as "no such call" (2026-10-11, three empty scans for the speaker mode's writer). Decoding
  backwards from each byte match of a displacement, as `ebxref.py refs` does, has no such hole.
- **A field FMOD keeps twice.** The speaker mode is `SystemI+0x9788` and every channel copies it to
  `ChannelI+0x198`; the matrix builder is handed the copy, so searching for its writer at `+0x198`
  finds a dozen unrelated structs. Read the copy's source (`v0xa0f017`) and search for that.

## Anchors already mapped — the eboot

| what | vaddr |
|---|---|
| sequencer module | `v0x1c3000` … `v0x1c7000` (⚠️ linear disassembly from `v0x1c3000` desynchronises on the first instruction; sync from a function start) |
| `BeginSequencerPlayback__Q5Thingibi` (script binding) → part lookup wrapper → `PSequencer::BeginPlayback` | `v0x854b80` → `v0x9629d0` (reads `[thing+0x50] + 0x128`) → `v0x1c4f00` |
| **playback start**: fetches the audio state, plays the start sound (`v0x3de390` with 1.5), fills the clip arrays, pushes the settings — between a pause of the sequencer's channel (`v0x1c56cf`) and its unpause (`v0x1c5ef2`), after `v0x3e6c10` at `v0x1c56bd` | `v0x1c5670`, called at `v0x1c64c0` (not a separate "stop others" walk; the walk over every `MusicSequencer` Thing tests `+0x56` at `v0x1c5773`). ⚠️ `v0x1c5640` is a separate 0x2c-byte function before it — pause, `[state+0x1a60] = !arg`, and a tail-jump to the unpause at `v0x1c566b` — which a linear disassembly runs straight past into `v0x1c5670` |
| the settings push: `Tempo`, `Swing` (`vminss` 0.99), `EchoFeedback`, `EchoTime × 0.5`, `EchoMix`, eight `Volume × 0.75`, `ReverbSetting` → `v0x3e7470` | `v0x1c6250`; the constants at `v0xe60fe4`, `v0xe60fe8`, `v0xe60fec` |
| world length → steps (`x·32/105`) | `v0x1c5cda` |
| board position → grid cell (`floor(2x/105 − 0.5)`, `floor(−y/105)`) | `v0x1c4ad0`–`v0x1c4b23`; constants `v0xe60f98`, `v0xe60f9c`, `v0xe60fa8` |
| the clip filler (`PInstrument` → `0x470` clip), and its one caller | `v0x1607c0`; `v0x1c449b` (passes `rdx = 0`); the instrument index written by `v0x1c4420` |
| the instrument walk's writes of `gridX`/`gridY`/length (`+0x58`/`+0x5c`/`+0x60`) on both branches, its sort and the comparator; the playback start's loop over the sorted list — *Which clips spawn* in [synth-engine.md](synth-engine.md) | `v0x1c4a90`–`v0x1c4b75` (child Things), `v0x1c4c1c`–`v0x1c4d1f` (components); `v0x1c4d62` → `v0xb39cf0`, `v0x1c6220`; `v0x1c5ae7`–`v0x1c5b7f` |
| `Thing` first child `+0x78`, next sibling `+0x80`, parent `+0x88` (accessors; the serialiser writes only `Parent`, at `v0xd4bc27`); the link into a parent's child list, head or tail by a flag byte (`v0x7aab5f`), 15 callers all passing 0 (head) | `v0x7e4eb0`, `v0x7e4ec0`; `v0xd4bc00`; `v0x7aaa90` |
| the board resize clamp: caps `(26250, 2625)` / `(2625, 2625)`, grids, the ceil-snap; `PMicrochip.CircuitBoardSizeX/Y` at `+0x4c`/`+0x50` | `v0x169b35`–`v0x169bc1`; `v0xe5c9c0`–`v0xe5c9f0`; serialiser `v0xd3afb4` — [sequencer-engine-inputs.md](sequencer-engine-inputs.md) |
| **the sequencer's thermometer**: the cost (`PSequencer` → bytes), its instrument walk, the FileDB row lookup; the level thermometer's update, its table setup, the per-player walk that sets entry 29, the limit message | `v0x1c4720`, `v0x1c49e0`, `v0x10680`; `v0x74c310`, `v0x74af60`, `v0x74b960`, `v0x74cb31` — [sequencer-engine-inputs.md](sequencer-engine-inputs.md) |
| `RLimitsSettings`: the accessor, the load (type `0x21`, GUID at `v0xe109dc` = 45910), the serialiser naming `MaxSequencerMemory` at `+0xc4` | `v0xb11580`, `v0x27d3d0`, `v0xc4b8ea` |
| the thermometer classes' vtables (zero on disk, read from the relocations) and constructor | `v0x108a460`, `v0x108a490`, `v0x108a4c0`, `v0x108a4f0`; `v0x74ad90` |
| the clip header writer (channel band), the band divisor, the `<< 4` | `v0x1608d0`; `v0x1c7909`–`v0x1c793c`; `v0x1c452a` |
| the runtime instrument builder, and the DSP-record builder that copies `Params` at `+0x4e8` | `v0x1c3fb0`; `v0x2a1144` (entry; `v0x2a1190` is mid-function), constructor above it `v0x2a0e80`, the first slot field copied at `v0x2a1220` |
| sample-preload job spawner, its worker, the `RSample` (type `0x31`) load | `v0x1c3c80`, `v0x1c37f0`, `v0x1c38aa`; `"StartSamplePreload"` at `v0xe61158`, referenced at `v0x1c3ce5` |
| CWLib audio layer | `v0x3dd000` … `v0x3fe000` |
| the audio state block, its accessor, its init (768,000-byte echo ring at `+0x1b18`), enable/pause, teardown | `v0x132bb10`, `v0x3fbf20`, `v0x3e6c10`, `v0x3e6e00`, `v0x3e7060`; nine accessors over `+0x1ac8`/`+0x1ad0`/`+0x1ad8` at `v0x160930`–`v0x1610c0` |
| the `"Sequencer"` DSP: description on the stack, `createDSP`, `setDefaults`, `playDSP`, `setMode`, `addDSP`(reverb), `addDSP`(WaveHammer) | `v0x3e65a0`/`v0x3e664b`, `v0x3e66cb` (`createDSP` at `v0xa48b90`), `v0x3e66f4`, `v0x3e6718`, `v0x3e67cb`, `v0x3e67f9`, `v0x3e6976`; handles `v0x132aac8` (sequencer), `v0x132aac0` (WaveHammer); the read-callback import slot `v0x10cc3f8` |
| the WaveHammer description (name as a `movabs` immediate), its create callback with the `rep movsd` of the static template, its setparameter callback, the paramdescs | `v0x3e62b0`; `v0x3fd6c0` (`v0x3fd8cb`), template `v0x1062850`; `v0x3fda80`; `v0x10783c0` (`numparameters` = 16 from `v0xbc10a0`) |
| DSP creation range; the `DSP::setParameter` block (10 calls); `applyReverbPreset`; the reverb configure | `v0x3e6700`–`v0x3e72c0`; `v0x3fd4c0`–`v0x3fd5d0` (`setParameter` at `v0xa23970`); `v0x3fd4c0`; `v0x3fcd50` |
| reverb preset table (12 × 11 `int32`) / `ReverbSetting` remap (8 entries) | `v0x1062620` / `v0x1062830` |
| audio init, `.fev` load, `EventSystem::getGroup` calls | `v0x3e7960` (`getGroup` at `v0x9d3190`) |
| VoIP audio-out port open (4 ports of type 2, one per player) | `v0x3f5650` |
| FMOD code | `v0x9c5da3` … `v0xab6397` |
| FMOD's output description "FMOD Orbis AudioOut Output", its `GetDriverCaps`, its `Init` | `v0x13e3c78`, `v0xa57770` (`v0xa577f7` rejects any rate but 48000), `v0xa577a0` |
| `ChannelSoftware::setPan`, `setSpeakerMix`, the channel→speaker matrix, the 7.1×4 case | vtable `+0x98` → `v0xabdf30`, `+0xa8` → `v0xabe160`, `v0xa243a0`, jump tables `v0xa2664c`/`v0xa2670c`, **`v0xa2599f`** (`k = 0.5` at `v0xefc008`); the stereo→7.1 case `v0xa2579c` |
| the speaker mode: the game's `System::setSpeakerMode(6)`, the public wrapper, `SystemI::setSpeakerMode` (FMOD's ctor default of 2 at `v0xa4fbb4`), its field, `SystemI::init` handing the driver its channel count | `v0x3e76d8`; `v0xa48290`; `v0xa4fed0`; `SystemI+0x9788` (copied to `ChannelI+0x198` at `v0xa0f017`); `v0xa50f99`–`v0xa5101f` — [lbp-audio-engine.md](lbp-audio-engine.md) |
| a channel's DSP graph: `ChannelSoftware` vtable, its head unit (`+0x88`), the DSP-play slot that adds the "FMOD Resampler Unit" (`+0x490`) and the group connection (`+0x4b8`), `getDSPHead`; `Channel::addDSP` → `ChannelI::addDSP` → the queued insert-between and where it runs | `v0x10c25a0`, `v0xabb790`, `v0xabc6a0`, `v0xabf4f0`; `v0xa07c70` → `v0xa10fc0` → `v0xa27f20`, run by `v0xa28070` from `v0xa53010` |
| `ChannelI`'s play-time setup, which applies the volume and the pan (mode 0) to the real channel; the path from `SystemI::playDSP` | `v0xa0fbd0` (`setPan` call at `v0xa100b3`); `v0xa54e90` → `v0xa0a350` → `v0xa0a770` |
| Sony reverb plugin (`aSfxDsp`) entry — **not** the sequencer's reverb | `v0xab51b0` |
| `PSequencer`, `PInstrument`, `RInstrument`, sample-slot serialisers; the array serialiser with its `movbe` | `v0xd37d10`, `v0xd36c60`, `v0xc68a70`, `v0xcc0e90`; `v0xcc0f20` (`v0xcc0f9d`, `v0xcc1025`) |
| part-name table; the ordered `R*` resource-type names | file `0xe4e196+`; file `0xe4e405` |
| the script→native funnel (one indirect call, callee in `rbx`) | file `0x3d9e72` |
| `RLevel`'s binary loader (head-word gates) and its reflective serialiser (field names, no gates) | `v0xc51f60`, `v0xc52a20` — what they settle is in [cwlib's level-files.md](../../cwlib-ts/steering/level-files.md), *`readLevel` reads to the end* |
| `RQuest`'s binary loader, its objective reader, the descriptor reader (u8 flag, GUID, SHA-1), and the reflective serialiser | `v0xdbd490`, `v0xdbc520`, `v0xbadab0`, `v0xdbe720`; found by the five calls to the wide-string reader `v0xbdd2a0` — cwlib's level-files.md, *Quests* |
| `RThingRecording`'s binary loader, its three layouts' array readers (matrices; positions, bytes, floats; the packed bytes and their decoder) | `v0xc79610`; `v0xc924a0`; `v0xc92340` (element `v0xcdbab0`), `v0xc921c0`, `v0xc91ff0`; `v0xb03b50`, `v0x921b40` (its quantised read `v0xbb81b0`, the first-vector read `v0xbbaaf0`, the quantisers `v0xadfde0`/`v0xadfe20`/`v0xadfe50`) — found by its version compares inside `0x3bd`–`0x3d9`; cwlib's level-files.md, *Thing recordings* |
| `RTutorials`' reflective serialisers: the resource, the group list, a group, a tutorial (field names and order) | `v0xc88960`, `v0xcd8130`, `v0xcd84e0`, `v0xcd88c0` — reached from `VideoGUID`'s one reference; cwlib's level-files.md, *Small resources* |
| `PSwitch`'s binary loader at the live-streaming choice (five wide strings from subVersion `0x166`, type `0x4b`) | `v0xd0510a`; found by its compares with `0x1660000` and `0x1870000` — cwlib's level-files.md, *`playerMode` at 0x3eb* |
| `PStickers`' binary loader, its decal reader, and the descriptor array of versions `0x3bc`–`0x3cb`; the reflective serialiser (`Decals`, `CostumeDecals_%d` × 15, `EyetoyData`) | `v0xcfff80`, `v0xcff1f0`, `v0xd77400`; `v0xd000c0` — the decal reader found by its gates `0x260`, `0x214`, `0x219`, `0x34c` together |
| no code for the Vita branch: no instruction compares with `0x4431` (the one `mov` of it is a texture-format table at `v0xaccd03`) | measured 2026-10-25 |

Other useful script bindings: `StopSequencerPlayback__Q5Thingi`, `TriggerSequencerMusic__Q5Thing`,
`GetElemPSequencer__Q5Thingi`, `GetSizePSequencer__Q5Thing`, `GetTimeLengthOnSequencer__Q5Thing`,
`GetSequencerReverbSetting__Q5Thing`, `TweakSequencer`, and the Interactive Music set
(`SetInteractiveMusic__ggffiQ5Thing`, `GetInteractiveMusicStemName__gi`,
`GetInteractiveMusicNumSliders__g`).

## Anchors already mapped — the plugins

`fmodextinput.prx` exports exactly one symbol, `wycAbBCjLI4` at `0x170`; its LOAD segments are
`vaddr 0x0000 size 0x4ab0` and `vaddr 0x8000 filesz 0x210 memsz 0x53a0`; its imports and the
dynlibdata offsets are in [synth-engine.md](synth-engine.md), along with every function read
inside it (`0xa90` the block function, `0x1c60` the per-voice renderer, `0x3930` the note walker,
`0x19e0`/`0x1a70` note start and the stack loop, `0x1600` the allocator, `0x240` the quantiser,
`0x3780` the sampler, `0x12e0` the mip builder, `0x0680`/`0x07c0` the echo, `0x16b0` the
envelope, `0x0280` the clip scheduler). ⚠️ Several of those were spelled `0x20` off in older notes
(`0x19c0`, `0x1a50`, `0x1c40`, `0x38e0`, `0x1690`, `0xab0`, `0x3740`, `0x290`); measured 2026-09-06,
each of the labels above begins with a prologue and each of the old ones decodes as garbage. `fmodsmsreverb.prx` exports `iO5jJEuFaSo` at `0x23a0`; `fmodsmswavehammer.prx` has eight
functions and exports `0x19f0`; both are in [lbp-audio-engine.md](lbp-audio-engine.md).
`sce_module/libc.prx` has `rand` at `0x17000` and `_FLog` (`log10f`) at `0x383e0` → `0x37c20`.
