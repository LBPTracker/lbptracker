# The synthesiser — what `fmodextinput.prx` does with the data

Read before touching anything in `packages/lbp-tracker-lib/src` that makes sound. The sequencer's
audio is not a set of FMOD voices and the synthesis is not in the eboot: it is a **23 KB plugin**,
`gamedata_orbis/spu/fmodextinput.prx`, read here instruction by instruction. Module addresses are
**true ELF vaddrs** (`file = vaddr + 0x7e0`); eboot addresses carry a `v` prefix. ⚠️ Every PRX
address written in this project before 2026-09-02 was 0x40 too high — [eboot-re.md](eboot-re.md).
What the eboot puts *around* the plugin — the reverb, the compressor, the 7.1 output — is in
[lbp-audio-engine.md](lbp-audio-engine.md).

## Where the synthesiser is

The sequencer owns a custom FMOD DSP. `v0x3e65a0` builds the description **on the stack** (which is
why scanning the data for one found nothing), at `v0x3e664b`: name `"Sequencer"`, `channels = 4`,
`create = v0x3e6580`, `read` loaded from the global `v0x10cc3f8`, no parameters; `createDSP` at
`v0xa48b90`, the handle at `v0x132aac8`. That global carries an `R_X86_64_GLOB_DAT` relocation
naming dynamic symbol `wycAbBCjLI4#C#D` — the plugin's **only export**, at module vaddr `0x170`.
The `create` callback does nothing but cache the DSP's userdata at `[dspstate+8]`, and the userdata
is the game's **audio state block** (`v0x132bb10`, reached through the accessor `v0x3fbf20`).

The read callback (`0x170`) asserts 4 in and 4 out channels, zeroes the output, **asserts the
length is a multiple of 256** (`test r14b, r14b` then `int 0x41`) and calls the block function
`0xa90` with `mov esi, 0x100` in a loop. So **the engine works in fixed 256-frame blocks**, and
`0xa90`'s first act is `memcpy(0xb850, state, 0x1b50)` — it copies the game's whole 6,992-byte
sequencer state into the module's BSS and renders from it. The offsets it reads are the ones the
eboot writes (`v0x1c6250`, `v0x1c5670`), which is the cross-check that it is the same structure.

❌ **The inference that a library-provided read callback "cannot know about notes or instruments"
was wrong** — an argument from architecture, not a reading, and the module was on disk the whole
time. The eboot's 768,000-byte allocation (`v0x3e6c10`, stored at `[state+0x1b18]`) that the
inference took for the synthesis buffer is the **echo ring**, below.

**Re-measuring anything here**: the module's LOAD segments are `vaddr 0x0000, size 0x4ab0` (code +
rodata) and `vaddr 0x8000, filesz 0x210, memsz 0x53a0`, so `0x8210`–`0xd3a0` is BSS. Fields are
always reached through a register — the block copy's base is `r14` in `0xa90`, and every other
function receives the state or a record in an argument register (`rsi` in `0x3930`, `rdi` in
`0x3780`) — so a plain disassembly grep for rip-relative accesses finds only `lea`s of the base.
Follow branches from an entry point, then collect `[base + disp]`. ⚠️ **Read the PATCH copies**:
`tools/prxdis.py` and `tools/prxnid.py` open `D:\PS4Games\CUSA00063-patch\gamedata_orbis\spu\`,
whose three plugins differ from the base game's in size and rodata layout; every address in this
file is in those files ([eboot-re.md](eboot-re.md)).

## The state block — 6,992 bytes, three regions

Two independent loops walk the same array with the same stride (`0x0c69`: `r15 = 0x28 … add r15,
0xd0; cmp r15d, 0x1a28`; `0x0eb0`: the same from `0x28 + rbx`), and `0x1a00 / 0xd0 = 32` exactly:

| range | size | what |
|---|---|---|
| `+0x0000` … `+0x0027` | 40 | header; `+0x08`/`+0x10` two instrument-table bases, chosen by a byte flag at `+0x00` (double-buffered); `0x1060` zeroes them |
| `+0x0028` … `+0x1a27` | 6656 | **32 voice records of `0xd0` = 208 bytes** |
| `+0x1a28` … `+0x1b4f` | 296 | settings and playback runtime |

The settings, written by the eboot and read by the plugin:

| offset | type | what |
|---|---|---|
| `+0x1a28` | f32 | **Tempo**, copied verbatim; also passed to the renderer as its third float |
| `+0x1a2c` | f32 | Swing, `vminss` against 0.99 on the way in (`v0x1c5d0c`) |
| `+0x1a30` | f32 | `EchoTime × 0.5` (`v0xe60fe8`) |
| `+0x1a34`, `+0x1a38` | f32 | `EchoFeedback`, `EchoMix` |
| `+0x1a3c`, `+0x1a40` | f32 | echo ping-pong and damping — **never written by the game**, below |
| `+0x1a44` | i32 | disabled/paused — `0x3930` returns early unless 0 (`0x3944`) |
| `+0x1a48` | i32 | restart pending; set to 1 at the top of a block, cleared after the step runs |
| `+0x1a4c` | f32 | the previous playhead **in steps**; a step boundary is `floor(now) != floor(prev)` |
| `+0x1a58` | i32 | −1 sentinel |
| `+0x1a68 + 12·i` | f32 | **`Volume[i] × 0.75`** (`v0xe60fec`), `i = 0..7`, ending at `+0x1ac8` |
| `+0x1ad0`, `+0x1ad8` | ptr | the **clip arrays**, A and B — `0x470` bytes per clip |
| `+0x1af0` | i32 | how many clips |
| `+0x1af8`, `+0x1b00` | ptr | the clip **header** arrays, 16 bytes per entry |
| `+0x1b18` | ptr | the 768,000-byte echo ring |
| `+0x1b20`…`+0x1b2c` | f32 | the echo's damping states |

A/B is chosen by a module-global byte (`0x8210`), which is double buffering: the game can rebuild
the clips while the audio thread reads the other copy. `v0x1c5670` (playback start) fills the clip
pointers and the count and finishes by pushing the same settings `v0x1c6250` does.

### The clip — one placement, `0x470` bytes

Filled by the eboot's `v0x1607c0`, field for field in
[sequencer-data-model.md](sequencer-data-model.md): `+0x00` the record count, `+0x0c` `Scale`,
`+0x10` the root (`key < 12 ? key + 12 : key`), `+0x1c` the length in steps, `+0x20 + 4·cursor` the
records with bits 28..29 cleared, `+0x420`…`+0x42c` `Level`, `Pan`, `2·EchoSend − 1`, `ReverbSend`,
`+0x430` the instrument index. The 16-byte header beside it, written by `v0x1608d0`
(`v0x1608df`–`v0x160906`), holds the clip's **start in units of 16 steps** at `+0x00`
(`max(gridX, 0)`), its **mixer channel** at `+0x04`, its **length in steps** at `+0x08` (the same
`PInstrument+0x60` as the clip's `+0x1c`) and its **board row** at `+0x0c` (`gridY`). ❌ This said
the channel was at `+0x0c`, tested by `0x280` against a mute mask, until 2026-10-11: the mask is
the rows the walk has already given a clip, and it starts empty (`0x0f15`, `xor esi, esi`).

### Which clips spawn — `0x280`, one per row, and the scan that stops at eight

At each walk, `0x280` scans the headers **from the last to the first** (`0x0300`, counting down)
with a mask of the rows already taken:

```
0x035d  bt  esi, row          ; the row already has a clip: skip
0x036e  rel = step - cell*16  ; js: not started, skip
0x0393  cmp rel, length       ; not below the length: finished, skip
        ... spawn every note-head record at step == rel ...
0x05d9  esi |= 1 << row       ; the clip takes its row
0x05dc  cmp esi, 0xff ; jne   ; ❗ rows 0..7 all taken: stop scanning
```

❗ **The headers are sorted by board position, not kept in the file's order.** The eboot's
instrument walk `v0x1c49e0` — over `PMicrochip.components` (`v0x1c4c1c`), or over the board's
child Things (`[thing+0x78]` first child, `[thing+0x80]` next sibling, `v0x1c4a64`) while the board
is open — writes each `PInstrument`'s `gridX` at `+0x58`, `gridY` at `+0x5c` and its length at
`+0x60`, then sorts the list (`v0x1c4d62`, a tail-jump to `v0xb39cf0`) with the comparator
`v0x1c6220`: `gridX`, then `gridY`, each by `setb`, so **ascending and unsigned** — a negative
column sorts last. `v0x1c5670` fills the headers in that order (`v0x1c5ae7`–`v0x1c5b7f`, the clip
index advancing only when `v0x1c4420` succeeds). The scan from the last header is therefore
**latest column first, and the lowest row last within a column**. Whether `v0xb39cf0` keeps two
clips anchored on one cell of one row in the walk's order is unread; `clipHeaderOrder` in
`render.ts` keeps the file's.

So **one clip sounds per row** — where two overlap, the later column wins — and, a quirk, **once
rows 0..7 are all taken the scan ends**, so a clip on row 8 or below that the scan has not reached
yet never spawns: one whose header sorts before all eight of the clips holding rows 0..7 — an
earlier column — while no clip past row 7 sorts after them. A clip in the same column as they are,
on a row past 7, is scanned before them, its bit keeps the mask off `0xff`, and every row plays.

✔ Census over the 149 corpus sequencers with tracks (2026-10-13): the sort changes which notes
spawn in 12, 953,325 of 953,791 notes spawning against 953,176 in the file's order; song 726268
(`Abrupt`) loses rows 9 and 10 from bar 109 in the file's order and keeps them in the eboot's. The
module and the render, both given the sorted headers, agree to −101.9 dB on 179190 (20 s) and
−117.7 dB on 726268 (62 s, across bar 109). ⚠️ **179190 is not an example of the drop**: it was
read as one on 2026-10-11, when the harness handed the module the file's order (*62* in
[answered-questions.md](answered-questions.md)); sorted, its row 8 plays from step 128.

The scan needs each clip's length. `v0x1c49e0` computes it from the chip's drawn width
(`v0x1c4cee`–`v0x1c4d1f`): `n = floor(scaleX / scaleY + 0.5)` from the component's `+0x24` and
`+0x28`, then `16·(n + 1)`, with `n = 0` coming out 32 too (`lea edx, [rcx + 0xfffffff]` and the
`<< 4` wrap). The open board takes the same ratio off the child's matrix, `m00 / m11` with two
Newton steps on `vrcpps` (`v0x1c4afc`–`v0x1c4b75`). `scaleX` is a multiple of `scaleY` on every
one of 3,724 measured components, `ceil((highest + 1) / 16) − 1` of them (`CHIP_WIDTHS` in
`write-plan.ts`), which makes the length the editor's rule from the highest record; the render
takes that rule (*`PInstrument + 0x60`* in [open-questions.md](open-questions.md)), and it is
what decides when a finished clip lets its row go.

**The channel is a band of the board** (`v0x1608d0` writes it; `v0x1c7909`–`v0x1c793c` the divisor;
`v0x1c452a` the `<< 4` that indexes the array): `rows = floor(boardHeight/105 + 0.5)`,
`divisor = max(rows / NumChannels, 1)`, `channel = clamp(row / divisor, 0, NumChannels−1)`. The
plugin's `mod 8` at `0x3afc` is a bounds guard on that clamped value, not the mapping. ⚠️ No amount
of corpus work could have settled this: 308 of 338 sequencers set `NumChannels` to 1, where every
row lands on channel 0 under banding, wrapping and a direct index alike.

### The instrument record — `0x5f0` bytes, and where `Params` lives

`imul rdx, rax, 0x5f0` indexes instruments; `imul rbx, rax, 0x98` indexes slots from offset 0. The
eboot's builder — entry `v0x2a1144` (⚠️ `v0x2a1190` is mid-function and disassembles as garbage;
it has no direct callers, being reached through a vtable) — maps the `RInstrument` onto it:

```
memcpy(r14+0x4e8, rbx+0x110, 0xd8)     ; the 27 Params, 216 bytes
r14+0x4c0 .. r14+0x4e3  <- rbx+0xe8    ; Splitnotes, nine int32
r14+0x4e4               <- rbx+0x10c   ; Numstack
slots: rbx+0x48 + 0x10*i  ->  r14+0x84 + 0x98*i
```

| offset | what |
|---|---|
| `+0x000` | **eight slots of `0x98`** (152 bytes), ending at `+0x4c0` |
| `+0x4c0` | `Splitnotes[0]` — never read by the zone walk |
| `+0x4c4` … `+0x4e3` | `Splitnotes[1..8]`, the eight bounds |
| `+0x4e4` | `Numstack` — the `cmp` the stack loop does |
| `+0x4e8` | `Params`, 27 `(x, y)` float pairs, to `+0x5bf`; the next field starts at exactly `+0x5c0` |
| `+0x5c0` | `Arpeggio`, 32 bytes; `+0x5e0` `Arpeggiate`; `+0x5e4` the instrument id, used to dedupe the table |

`Params[11].x`, the amplitude attack, is read at `+0x540` (`0x1f8c`) and `0x4e8 + 11·8 = 0x540`.
**Eight slots** falls out of the arithmetic here and independently out of the serialised resource.

### The slot — 152 bytes, three mip levels

| offset | type | what |
|---|---|---|
| `+0x00`, `+0x28`, `+0x50` | 40 B each | **mip 0 (full rate), mip 1 (÷2), mip 2 (÷4)**; `+0x00` of each is its decoded length, data pointers at its `+0x08` and `+0x10` |
| `+0x78` | i32 | **the playable length in frames** — past it the sampler reads silence (`0x37be`) and, once a chunk is out, layer 0 frees the record (`0x304d`); what `Params[2]` scales (`0x1ad1`); `<= 0` switches the slot to a saw oscillator |
| `+0x7c` | i32 | **loop start** |
| `+0x80` | i32 | **loop length**; `<= 0` means no loop |
| `+0x84` | i32 | the root note — the first field the eboot's builder copies (`v0x2a1220`) |
| `+0x88` | f32 | the native tempo |
| `+0x8c` | f32 | fine tune, in **semitones** |
| `+0x90` | u8 | **pitched**: when 0 the ratio is forced to exactly 1.0 |
| `+0x91` | u8 | **tempo-synced** |
| `+0x94` | u8 | **stereo** (a ×4 stride over ×2) |

The records arrive **filled from the eboot** — nothing in the PRX initialises `+0x78`. The mip
builder `0x12e0` (a function with no frame pointer, found by aligning on `cmp dword ptr [rdi +
0x78], r8d`) only *clamps*: if the decoded length `[rdi]` is smaller than `+0x78` it lowers `+0x78`
to it and zeroes `+0x7c`/`+0x80`, because a loop cannot survive a buffer that turned out shorter.
A minimum, never a maximum, and `rdi` is one slot throughout. Then it builds the copies: each is a
**plain average of adjacent frames of the same channel** (`src[2i]` and `src[2i|2]` on an
interleaved stereo buffer), and ⚠️ **the arithmetic is int16 and rounds toward zero** — `(a + b)`
then a signed halve that keeps the low 16 bits — so every output lands back on the sample grid.
`decimateBy2` in `packages/lbp-tracker-lib/src/audio/mipmap.ts` does it the engine's way; `(a + b) *
0.5` in floats differs by under an LSB, which the brief still cares about.

**Looping** is a plain modulo (`0x3769`–`0x377a`): if `pos > loopStart + loopLength` then
`pos = (pos − loopStart) mod loopLength + loopStart`. The region is **`[loopStart, loopStart +
loopLength)`**, half-open, and the loader below fills both from `smpl` as written: `dwStart`, and
`min(dwEnd + 1, frames) − dwStart`. ❌ `loopRegion()` returned `[dwStart − 1, dwEnd + 1)` until
2026-09-08 on a smoothness measurement ([game-assets.md](game-assets.md)); the engine's region is
a frame shorter and its join is the literal one (*43* in
[answered-questions.md](answered-questions.md)).

### The loader — `v0xb3e520` in the eboot, and what it does to the loop

Found from the `RIFF`/`WAVE`/`smpl`/`fmt `/`data` immediates in the code (the string copies at
`v0xefbd1e`… belong to FMOD's own codecs, which the sequencer never uses); outside FMOD's range,
writes exactly the slot's fields, and ends by calling `v0x3fc2b0`, the eboot's copy of the mip
builder `0x12e0`. `rbx` is the slot, `rsi` a stream:

- Zeroes `+0x00`, `+0x10`, `+0x18`, `+0x78`, `+0x7c`, `+0x80`; checks `RIFF` and `WAVE`; walks
  the chunks.
- **`data`** (`v0xb3e697`): `+0x78 = size / 2` samples; allocates `(size/2 | 0xf) + 0x11`
  int16s — the data rounded up to 16 plus 16 of slack — reads the PCM verbatim, and zero-fills 16
  frames past it (`v0xb3e950`–`v0xb3e97e`); stereo halves `+0x78` into frames (`v0xb3e989`).
- **`smpl`** (`v0xb3e700`): per loop, `+0x7c = dwStart` (clamped to `frames − 1`), `+0x80 =
  min(dwEnd + 1, frames) − start`; then **copies frames `[start, start + 16)` over
  `[end, end + 16)`** (`v0xb3e77c`–`v0xb3e868`, both channels when stereo). That patch is why the
  sampler's unwrapped second tap (`0x3780` wraps only *past* `end`) lands on loop-start material:
  the audible join is `d[dwEnd] → d[dwStart]`. `patchLoop` / `engineSample` in
  `packages/lbp-tracker-lib/src/wav.ts`.
- **`fmt `** (`v0xb3e880`): reads four bytes — `wFormatTag`, `nChannels` — and keeps only
  `+0x94 = (nChannels == 2)`. ❗ **The sample rate is never read, and nothing resamples**: a
  frame is a frame at the plugin's 48 kHz whatever the file says. 42 of the 216 shipped `.smp`
  are 44.1 kHz — `ukulele`, `record_static` and five kits — and play 8.8% fast, +1.47 semitones,
  in the game. The tracker does the same since 2026-09-08; it corrected them before (*43*).

## The voice record — 208 bytes

| offset | type | what |
|---|---|---|
| `+0x00` | u8 | the **instrument** index (`0x3b1e`, from `[clip+0x430]`; the zone is at `+0xcc`); **`0xff` means the voice is free** |
| `+0x04` | f32 | `channelVolume × clip Level` — one factor of the pool score, rewritten at every walk |
| `+0x08` | f32 | pitch in **semitones** |
| `+0x0c` | f32 | volume as the last walk left it: the current control point's velocity, caught up along the slide — the other factor of the pool score |
| `+0x10` | i32 | **the gate**: 0 while the note is held, 1 once its chain has ended |
| `+0x14` | i32 | a marker, written as 10000 when the record is claimed; the caller skips `0x3930` while it is `> 0` |
| `+0x18` | f32 | the clip's pan, written per block from `[clip+0x424]` |
| `+0x1c`, `+0x24` | f32 | the **echo** send and the **reverb** send — set by the walk, the echo send a step behind the modulation (*The gate and the ramps*) |
| `+0x20` | f32 | the drive (`Params[26]`), clamped to 0..1 — set by the walk a step behind the modulation, like the echo send |
| `+0x28` | f32 | the note's **modulation**, `bits 24..27 / 15` — the value that picks a point inside every `Params` range |
| `+0x2c`, `+0x30`, `+0x34` | f32 | **slide rates** per unit time for volume, pitch and the modulation |
| `+0x38` | i32 | which clip this voice reads |
| `+0x3c` | u16 | the **record cursor** within that clip |
| `+0x3e`, `+0x3f` | u8, u8 | the start and end sub-steps, in thirds (`v0x4558 = 0.333333`) |
| `+0x40 + 8i` | **f64** | **playback position in frames** for stack layer `i`, `i = 0..4` |
| `+0x68 + 4i` | f32 | per-layer detune, a ratio near 1 |
| `+0x7c + 4i` | f32 | per-layer pan spread, centred on 0 |
| `+0x90`, `+0x94` | f32 | envelope A and envelope B levels, cleared together at note start |
| `+0x98`, `+0x9c`, `+0xa0` | f32 | three LFO phases |
| `+0xa4` … `+0xc8` | 10 × f32 | the two Moog ladders, five states each: L's `b1`…`b4`, `b0`, then R's (*The filter*) |
| `+0xcc` | i32 | the zone, written once per note from the zone walk |

**Every byte from `+0x40` to `+0xcc` has an owner, and five layers tile the three arrays with no
slack** (`+0x40..+0x67`, `+0x68..+0x7b`, `+0x7c..+0x8f`), so **`Numstack` is at most 5** — `choir`
and `synth_strings`, the corpus's largest, are exactly 5.

### Note start — `0x19e0`, and the stack loop `0x1a70`

`0x19e0` **zeroes the whole record** (`call 0xe0` = memset at `0x1a0d`, `0xd0` bytes), then writes the zone,
the modulation, the clip index and the cursor, opens the gate, and tail-jumps into the stack loop.
⚠️ A stolen voice is therefore wiped — envelope, position, phases — and the new note starts from
silence: `Voice.renderChunk`'s hard stop is what the game does, and a fade would be an invention.
**Do not add one.**

**The zone walk** (`0x0555`–`0x0577`, verbatim again at `0x09f0`–`0x0a14`):

```
ecx = bextr(noteWord, 0x708)          ; bits 8..14, the RAW note, not the quantised one
eax = 0
loop:
  r8d = 0
  if (int)eax > 7:  goto done         ; a fixed eight bounds
  cmp  [rdx + rax*4 + 0x4c4], ecx     ; splitNotes[i + 1] vs note, signed
  eax += 1
  if   bound > note:  goto loop       ; STRICT: a note on a bound takes the zone above it
  eax -= 1
  r8d = eax
done:
```

The zone goes straight into the slot array with no remapping (`imul rax, rax, 0x98` at `0x1aca`).
`resolveSlot` in `packages/lbp-tracker-lib/src/instrument.ts` is checked against this loop over
every instrument the game ships and every note — 68 × 128 = 8,704 comparisons, no disagreement
(`test/instrument.test.ts`). ⚠️ The walk indexes from `+0x4c4` = `Splitnotes[1]`; transcribing it as
indexing from `[0]` makes the engine appear to contradict a million-note corpus (*19* in
[answered-questions.md](answered-questions.md)).

**The stack loop**, `Numstack` times:

```
for i in 0 .. Numstack-1:
    r01 = rand() * 2^-30                            ; 0x1ae1 call 0x140, then v0x4540; U(0,1) exactly -- RAND_MAX below
    voice.position[i]  = eval(Params[2]) * slot[zone].length * r01     ; +0x40 + 8i, a double
    r = eval(Params[0]);  voice.detune[i] = 1 + 0.05 * (r01' * 2r - r)  ; +0x68 + 4i; 0.05 and 1 at v0x4544/v0x4548
    r = eval(Params[1]);  voice.spread[i] = 0.5 * (r01'' * 2r - r)      ; +0x7c + 4i
voice.position[0] = 0                               ; 0x1bda -- LAYER 0's START IS CLEARED
voice.envelopeA = voice.envelopeB = 0               ; one qword clears +0x90 and +0x94
voice.lfoPhase[0..2] = rand() * 2*pi/2^30           ; 0x1bfa/0x1c18/0x1c36, v0x4550; three U(0, 2pi) phases, once per NOTE
```

where `eval(P) = P.x + mod · (P.y − P.x)`. So `Params[2]`, the random start, is **inert on any
instrument with `Numstack` 1** — 18 of the 27 that set it, including six drum kits at a flat
`1.000` — while `Params[0]` and `Params[1]` **do** apply to layer 0 (nothing clears `+0x68` or
`+0x7c`): `baiyon_city_guildford` (`Numstack` 1, detune `0.406..0.394`, spread `0.631..0.000`)
spreads its 616 notes in `Zero` over pan 0.317..0.685 and ±230 cents. ⚠️ The stack loop reads the
length of the note's **own zone**, not slot 0's (`0x1aa0` reloads `[r14 + 0xcc]` each iteration),
and the length is the slot's `+0x78`, the **sample's** frame count (`0x1ad1`) — not the buffer,
which the loader's loop patch makes up to 16 frames longer; the product is float32 throughout and
only widened to the record's double at `0x1b03`. Scaling the buffer's length put `electric_piano`'s
second layer up to 16 frames late at full modulation, −8.6 dB against the module (2026-10-11).
The three LFO phases carry no layer index: a stacked voice's layers share one base phase and differ
only by `Params[17|20|23] · 2π/Numstack · layer` — a fan **re-evaluated every chunk** at the chunk's
start modulation (`0x22e5`–`0x236d`) and added layer by layer to the stored phase
(`0x287b`–`0x28bb`), so a modulation glide turns the layers against each other while it plays
(`electric_piano`, layer spreads 0 → 0.66 and 0 → 0.82: +4.1 dB against the module when the fan
was fixed at the note's start). All three phases are float32 and **never wrapped**: the stored one
grows by `f(f(seconds · rate) · 100)` (50 for the third) a chunk, `seconds` being
`f(N · 2.0833333e-05)` (`0x20ce`, `0x2263`–`0x22cf`), and each layer's is the previous layer's plus
the fan, rounded (`0x287b`). The detune is float32 in the loop's order too, `f(f(f(u · f(r + r)) −
r) · 0.05) + 1` (`0x1b0e`–`0x1b61`): the module printed `mosquito`'s (`Params[0]` 0.09, `rand()`
pinned) as 0.998199999332428, which double arithmetic misses by 7e-10 — a hundredth of the held
rate's drift in *The pitch*, below, and still the module's own number.

**`RAND_MAX` is `2^30 − 1`**, measured out of the game's own `sce_module/libc.prx` rather than
assumed: `rand` at vaddr `0x17000` is a 37-byte 64-bit LCG (`state = state · 0x5851f42d4c957f2d + 1`,
`return (state >> 32) & 0x3fffffff`), so the multiplier `9.3132257e-10 = 2^-30` at `v0x4540` makes
`rand() · 2^-30` exactly `U(0, 1)` and `5.85167e-09 · 2^30 = 2π` (`v0x4550`) a uniform phase. ⚠️ The plausible
wrong answer was FreeBSD's `2^31 − 1`, which would make the pitch spread `U(−d, +3d)` and put half
of every kit's hits past the end of their own sample.

## The clock — steps, sub-chunks and the block grid

Inside a block, `0x0be3`–`0x0c2e` and `0x0bf2`–`0x0c1f`:

```
L         = 720000 / tempo                       ; frames per step at 48 kHz
L        += L * swing * 0.5 * table[floor(position) & 1]    ; table at v0x44f0 = [1, -1], 0x0be2
N         = min(trunc((1 - frac(4*position)) * L + 1), frames left in the block)   ; the 4 at v0x44bc, 0x0bf2
position += N / L                                 ; [state+0x1a4c], in STEPS
```

- **`720000 / tempo`** at the engine's default tempo of 125 is 5,760 frames, and
  `48000 · 60 / (125 · 4)` is 5,760 too: **four steps to the beat**, at a 48 kHz output rate,
  measured rather than assumed.
- **Swing**: an even step stretches to `L · (1 + swing/2)` and the odd step after it squeezes to
  `L · (1 − swing/2)`, so the pair still lasts `2L` and swing never drifts against the bar; at
  `swing = 1` the ratio is 3:1, and the field is clamped just below 1. `swing.ts` implements it and
  every note position, duration and automation point goes through `swungFrame`. Because
  `floor(position)` cannot change inside a step, the position advances linearly at that step's own
  swung rate, and a triplet at `k + s/3` sounds `L(k)·s/3` frames into step `k` — **a triplet inside
  a stretched step stretches with it**, which is exactly what `swungFrame` does.
- ⚠️ **The `frac(4·position)` bound is not a musical boundary** — it lines up with neither steps
  nor thirds; it guarantees a chunk advances **at most one step**, which the note window needs
  (`0x1c9b` handles a wrap by adding 1 and cannot handle two). Simulated over a second it gives
  chunk lengths of 1, 127, 129, 255 and 256.
- The position is in steps, proved from the scheduler side too: `0x0d13` shifts a clip's cell index
  left by 4 and compares `cell · 16` against it, so **a board cell is 16 steps**.

❗ **A note begins at the top of a chunk.** `0xa90` renders a chunk first (`0x0c84`, every record)
and only then, if `floor(position)` changed inside it, walks the notes (`0x0e8d`–`0x0f1c`: `0x3930`
per record, then `0x280` to start new ones), so a note on a step is first rendered at the top of
the chunk *after* the one that crossed its step — 0 to 256 frames late. `0x1cc6`–`0x1cdc` computes
the in-chunk onset offset as `trunc((start − frac(position)) / N)` with `start = voice[+0x3e]/3 < 2`
and `N` the chunk's frames — a divide where a multiply belongs — which is 0 for every chunk longer
than one frame, so a note on a sub-step is rendered from the top of the first chunk whose end
passes it (`0x1cb9`), up to a chunk *early*. The onset grid is therefore the 256-frame block,
5.33 ms at 48 kHz. ✔ **Measured on the module running** (`tools/prxsynth.py`, 2026-10-11): at
180 bpm (4,000 frames a step) notes on steps 0, 2, 4, 6, 8, 10 start at frames 256, 8,192, 16,128,
24,064, 32,000, 40,192 — the song's first step waits for the restart's chunk — and the read size
FMOD asks for changes nothing (1,024 and 256 give the same frames), so the grid is the song's.
`engine-clock.ts` transcribes the clock in float32, and ✔ **since 2026-10-12 it is the default,
the owner's choice** (*3 / 3b* in [answered-questions.md](answered-questions.md)). The render places
every onset, gate, walk and theft on it, and a record's voice ends its segments at the chunks the
clock splits (`VoiceSpec.engineGrid`): the ramps are straight between chunk ends, and a two-octave
glide sampled at other ends drifts in phase. The live player runs the same clock under its
transport (*The live player* in [tracker-architecture.md](tracker-architecture.md)). Off
(`engineClock: false`), onsets and gates sit on their own frame and the voice is the double one,
kept for an A/B. And it does the record's own arithmetic
(`VoiceSpec.engine`, `engine-record.ts`): its slides read off the clock's float32 playhead (*The
gate and the ramps*) and its rate formed in float32 (*The pitch*).

### The gate and the ramps — `0x3930`, the note walk

The function start is `0x3930` (found by the largest `E8` target at or below its stores; it ends in
a clean epilogue at `0x3f23`) — ⚠️ steering called it `0x38e0` for a while, a stale label. It is
called for a note as it starts (`0x05bb`, after `0x19e0`) and then once per step, after the chunk
that crossed it (`0x0eef`) — ⚠️ not once per block, which this section's heading said until
2026-10-05. Per voice it walks the clip's chain:

```
0x3a0a  edx = word [rbx + 0x3c]     ; the record cursor
0x3a0e  r11 = rdi + rdx*4 + 0x20    ; the records
0x3a13  eax <<= 4                   ; gridX * 16, the clip's step offset
0x3a31  r12d -= eax                 ; the playhead, relative to the clip
0x3a3e  edx = [r11] & 0x7f          ; this record's step
0x3a41  cmp r12d, edx ; jle         ; playhead <= step: not reached
0x3a46  test ah, 0x80               ; bit 15, the end-of-chain flag
0x3a49  je  advance                 ; not the end: advance the cursor and go again
0x3a4b  [rbx+0x10] = 1              ; the end: close the gate
0x3aa5  bextr eax, ecx, 0x107 ; ecx >>= 30 ; cl &= 1 ; eax <<= cl   ; subStep = bit7 << bit30
0x3ab2  [rbx + 0x3f] = al           ; the END sub-step
0x3ab5  [rbx + 0x10] = 0            ; ... and the gate is re-opened for the last third
```

and `0x1c60` closes it for good once the playhead's fraction passes `[+0x3f]/3` (`0x2988`–`0x29b1`).
✔ **The gate therefore closes at `lastStep + 1 + endSubStep/3`**, which is exactly `startPosition +
(endPosition − startPosition + 1)`: `durationSteps` is right to the third of a step, and the
sub-step decoding is confirmed from the playback side as well as the editor's.

❗ **Unless the records bunch.** The close needs a walk past the last record's step that finds the
cursor already on it, and one walk moves the cursor one record (`0x3a41`–`0x3a6a`): record `i` is
reached at `w(i) = max(w(i − 1), step(i − 1)) + 1` from the spawn's step, and the gate closes at
`max(w(last), step(last)) + 1`. A note at 6, 6⅓, 6⅔ and 8 has its cursor on the end record at walk
9 and its gate closed at walk 10 — measured on the module, `g1` first at playhead 10.000
(`gsub` in `prx-scene.ts`, 2026-10-11) — a step after `durationSteps`. A gap lets the cursor catch
up: 6, 6⅓, 8 closes at 9. `closingWalk` in `engine-record.ts`; `render.ts` lengthens such a note
by the walks lost, on either clock.

❗ **And the closed gate is first read at the top of the next chunk.** `0x1c60` loads `[+0x10]` once
per chunk, at `0x1f65`, before both envelope calls; the walk that closes it on a step (`0x3a4b`)
runs after the chunk that crossed the step, and the close on a sub-step (`0x29b1`) comes after the
same chunk's envelope calls. So the release starts at a chunk's top, 0 to 256 frames after the
gate's moment, and — the envelope being evaluated at the chunk's two ends and ramped between — **a
release shorter than the chunk lasts the whole chunk**: at modulation 0, `triangle_wave`'s 38
frames, `square_wave`'s 16, `saw_wave`'s 32 all fade over 256 frames, 5.3 ms, in a whole block. The
attack after an onset the same way: `triangle_wave`'s 12 frames rise over the note's first chunk.
Where the step clock splits a block (*The clock*, above) that chunk is shorter. `Voice` keeps these
ramps by starting its segment grid at the note's first frame and again at the gate (*60* in
[answered-questions.md](answered-questions.md)); by default it also holds such a release to 20 ms,
which the engine does not (*61* in [open-questions.md](open-questions.md)).

The same function reads the **current and the next** record and sets **three slide rates** from one
span (`0x3e1e`–`0x3e8a`, `v0x45ac = 1/3`): `[+0x2c] = (nextVolume − volume)/span`,
`[+0x30] = (nextPitch − pitch)/span`, `[+0x34] = (nextMod − mod)/span`, and zeroes all three when
there is no next record (`0x3f06`, `0x3f0e`). When the playhead is already partway between two
records it catches all three up by `rate × elapsed` (`0x3edd`–`0x3eff`). So a note glides
**linearly in semitones** between its control points — the engine ramps `voice.pitch` and only
afterwards feeds it to `exp2f`, so interpolating the playback rate instead sags in the middle of
every bend — holds flat otherwise, and **ramps the modulation exactly as it ramps volume and
pitch**. The slides are per unit of **steps**: the span is in thirds (`v0x45ac`) and the renderer's
`t` is the chunk's advance in steps (`N / L`, `0x0c28`), so under swing a glide bends at every step
boundary in frame time. `render.ts` cuts every ramp at the integer steps it crosses, which makes
its frame-linear segments the engine's step-linear ones (2026-09-08; 13 of 338 corpus sequencers
swing). ⚠️ `+0x28` was read as a pan for a day and its third ramp as a `panSlide`; it is the
modulation, and a renderer that holds it at the note's opening value is wrong on the 3.45% of
notes that move it — 30,170 of the 34,449 that do move some parameter by 0.35 or more, and 26 of
the 27 parameters move on some note.

❗ **The slides change only at a walk, so the chunk that crosses a record runs the old slide past
it.** Both ends of a chunk read `+0x08`/`+0x30` (and `+0x0c`/`+0x2c`, `+0x28`/`+0x34`) as the last
walk left them (`0x1d8c`, `0x1e2c`), with the elapsed time taken from the playhead; the walk for
the record's step runs after that chunk. So a glide of 24 semitones in a step ends the crossing
chunk at 51.16 for 51, and the next chunk starts on the record's own 51. Measured on `Vision`
(song 15853, 130 bpm): a pitch ramp stopped on the record's frame left a constant phase offset
behind it, −27 dB against the module; anchored to the walk, −65 dB (`AutomationPoint.from`, on the
engine's clock only).

❗ **And the elapsed time is the float32 playhead's fraction, not the frames since the record.**
`0xa90` hands `0x1c60` the fraction of the playhead at the chunk's top and at its end (`0x0c35`,
`0x0c48`, from the float32 `[state+0x1a4c]`), plus 1 on the end's when the chunk crossed a step
(`0x1c9b`); `0x1ce7`–`0x1d03` take `[+0x3e]/3` off both — the spawn's sub-step, which every walk
clears (`0x3969`, the word with `+0x3f`) and only the spawn's sets again (`0x3a6e`–`0x3a8c`, on
the fourth argument: 1 from the spawn at `0x05a7`, 0 from the step's walk at `0x0ee5`) — and
floor the start's at 0. Then, all float32: the pitch at both ends is `f(t · [+0x30]) + [+0x08]`
(`0x1d8c`, `0x1e2c`); the volume and the modulation are that at the start and the start plus
`f(dt · slide)` at the end (`0x1ec0`–`0x1f59`, `0x20a6`–`0x20ae`), `dt` the chunk's advance. The
float32 playhead does not advance by `N / L`: at step 141 of a 130 bpm song a 256-frame chunk moves
it 0.0462189 steps where `N / L` is 0.0462222, so `t` read off frames is 2e-6 steps away from the
module's, and on a two-octave glide that is a rate error of 3e-6. `Vision`'s clip 64 (three
75 → 51 glides in single steps) drifted 0.05 frames in a step and sat at −40 dB of its loudest
window; reading `t` the module's way it is −117 dB (the song is *62* in
[answered-questions.md](answered-questions.md)).

The walk's own values are float32 too (`0x3c2e`–`0x3c81`, `0x3d96`–`0x3e8a`): the velocity times
`v0x45a0`, the pitch converted from the integer, the nibble times `v0x45a4`, the span
`pos(next) − pos(cur)` with `pos = step + sub · v0x45ac`, its reciprocal times each difference, and
the catch-up `e = walk + (sub · v0x45b0 − step)` (`0x3eab`–`0x3ed9`) — in **the clip's own steps**
(`0x3a31` subtracts `cell · 16`): a third off step 141 rounds to a spacing of 1.5e-5, off the same
record's clip step 29 to 1.9e-6. The module printed the slide over a third of a step from 48 to 60
as 35.99998. `engineWalks` in `engine-record.ts` transcribes it for the three fields, the spawn
first.

❗ **The drive and the echo send are a step behind the modulation.** `0x3930` computes `+0x1c`
(`Params[25]`, `0x3b54`) and `+0x20` (`Params[26]`, `0x3b93`) from `+0x28` **before** it writes
this step's modulation there (`0x3c81`, or the catch-up at `0x3eff`); `0x19e0` seeds `+0x28` with
the first record's (`0x1a1a`). So in step `k` they hold the modulation of step `k − 1`, flat, and
the chunk reads both as constants. Following the ramp instead put `electric_harpsichord`'s
modulation glide (drive 0.39 → 0) at −12.8 dB against the module; held, −100.5 dB
(`morph.held` in `mixer.ts`). The walk that closes the gate still sets them; every walk after it
returns early (`0x395f` → `0x3f06`) and both stay where they were.

It also rewrites both pool-score factors at every step: `[+0x04]` from the channel volume times the
clip's `Level` (`0x3b12`), `[+0x0c]` from **the current control point's** velocity (`0x3c29`,
`bextr eax, [note], 0x810`), caught up along the volume slide (`0x3edd`–`0x3ee5`). A released voice
(`0x3963` → `0x3f06`) skips the update and keeps the score it had. Which point is current, and how
far the catch-up runs, are read off the walk's **whole step** — `vroundss … 1` at `0x398e`, kept
at `[rbp-0x2c]`, and the catch-up's elapsed time is that integer less the record's position
(`0x3eab`–`0x3ed9`):

- the record cursor moves **at most one record per walk** (`0x3a41`–`0x3a6a`: one compare, one
  `inc`, no loop), and the current point is the one before the cursor while the playhead is below
  the cursor's step (`0x3c03`–`0x3c1c`);
- so a record on a sub-step is current from its whole step's walk, at its own velocity with no
  catch-up — a third or two early, where a ramp sampled at that step would still be between it and
  the point before;
- and a note with two records inside one step trails its ramp by a walk: three records at
  `k`, `k + ⅓`, `k + ⅔` give, at the walk of `k + 1`, the velocity of `k + ⅓`.

The walk that closes the gate still writes both factors (it has passed the check at `0x395f`), from
the note's last record; every walk after it skips. `walkVelocities` in `polyphony.ts` transcribes
this for `[+0x0c]`, and *The voice pool*, below, is what reads it.

## The per-voice renderer — `0x1c60`, once per record per chunk

Called from `0xa90`'s loop over the 32 records (`0x0c51`–`0x0c97`: `ebx = 0x28; … add rbx, 0xd0; cmp
rbx, 0x1a28`). Everything modulation-driven is evaluated **twice per chunk, at its start and its
end** — the two envelopes (`0x203f`/`0x2089`), the pitch ratio (`0x1dc2`/`0x1e63`, the second with
the slide added), the three LFOs (two `call 0x130` each), the filter's cutoff and resonance
(`0x29c2`, then `0x2a54` onward with `xmm15`, the end modulation) — and each layer's rate, gain and
pan become a `{value, step}` pair (`0x2876`, `0x25a5`, `0x274f`) that the per-sample loop steps
every frame (`0x2d5d`, `0x2d78`, `0x2d8f`). ❗ **Inside a chunk the game applies a linear ramp
between the two evaluations, not a value held flat.** Only the drive and the two sends are chunk
constants (`0x1ee0`; `0x2f3f`–`0x2f89`), set by the walk (*The gate and the ramps*).

❗ **But "at its end" is not "at the end modulation" for everything.** `[rbp-0x9f0]` is the elapsed
steps at the chunk's start (`0x1cfb`) and `[rbp-0xaa4] = +0x28 + elapsed · +0x34` is the **start**
modulation (`0x1f4a`); the end one is formed later, at `0x20ae`. Read off every load of either
(2026-10-11):

| what | start of the chunk | end of the chunk |
|---|---|---|
| the two ADSRs' four parameters | **both calls** (`0x1f8c`–`0x2017` → `0x203f`, `0x2089`; `0x213d`–`0x21c9` → `0x21ed`, `0x2227`) | — |
| the filter's key tracking ratio | **both ends**: `[rbp-0xa90]`, loaded once at `0x2a15`, multiplied at `0x2a26` and `0x2a8c` | — |
| the three LFO rates, the layer fan | `0x2253`, `0x228f`, `0x22bb`; `0x22f9`–`0x235d` | — |
| `Params[24]`, the level | `0x23b0` | `0x23e0` |
| the LFO depths | LFO 2 `0x24c4`, LFO 3 `0x25dd` | LFO 2 `0x2543`, LFO 3 `0x26b2`, LFO 1 `0x2812` |
| cutoff, resonance, key amount, envelope amount | `0x29c2`–`0x2a36` | `0x2a54`–`0x2aa5` (`xmm15`) |

The ADSRs were evaluated at the end for the second call here until 2026-10-11: a falling sustain
ran a segment ahead, −19.5 dB on `square_wave`'s modulation glide, −73.5 dB once fixed, and eight
more glides fell below −60 dB with it. The key tracking took the end ratio: a phase lead that
followed a pitch glide's slope, −42 dB on `sine_wave`, −99 dB once fixed. ❌ This paragraph said "a staircase held for a 256-frame
block" until 2026-09-08 — *44* in [answered-questions.md](answered-questions.md). `Voice` in
`packages/lbp-tracker-lib/src/audio/mixer.ts` does the same per *segment* — a block of the voice's
own grid, which starts at its first frame and again at its gate, cut short at its own events — and
re-derives at both ends from the *interpolated modulation*: `evaluateParam` is affine in it, but the
ADSR squares its times and the ladder squares its cutoff, so interpolating *those* would not be the
same arithmetic.

### The record's accumulator, its clip, and where the ladder sits

The per-sample loop (`0x2b70`–`0x2df9`) is a loop over the layers with the loop over the frames
inside it, and every layer accumulates into **one interleaved L/R buffer on the stack**
(`[rbp-0x9c0]`, 512 floats): `L[i] += (1 − pan)·gain·x` at `0x2d2e`, `R[i] += pan·gain·x` at
`0x2d47`, after the drive (`0x2cab`). After the last layer, `0x2e00`–`0x2e2d` **clamps that buffer
to ±1** (`vmaxps −1`, `vminps +1`, all 512 floats); then the ten ladder states are loaded from the
record (`0x2e2f`–`0x2e90`, `+0xa4`..`+0xc8`), the bypass is decided on the block-start cutoff
(`0x2e99`, `0.99 < freq`), and the two ladders run on that buffer's L and R (`0x31c6`/`0x31d3`) —
**one pair per record, after the gain, the pan and the sum of the layers, and after a hard clip
nothing outside the plugin sees**. The clip is also why the ladder never leaves its `[−1, 1]`
domain. The filtered or bypassed buffer then goes to the output lanes and the sends (`0x2f00`,
`0x32fc`). So the order is: sample → drive → gain → pan → sum of layers → clip → ladder → out.
`Voice.renderSegment` keeps it. ❌ Until 2026-09-08 the tracker filtered each layer on its own,
before the gain and the pan, with a ladder pair per layer — the same thing for a linear filter and
not for this one, on the 13 shipped instruments that are both stacked and filtered (*45*).

### The note word, decoded with `bextr`

| bits | what |
|---|---|
| 0..6 | step within the clip, compared against `currentStep − header.start × 16` |
| 7 | the sub-step's low bit, **shifted left by bit 30** → 0, 1 or 2 |
| 8..14 | the note — the file's `y`, which the eboot copies through with only bits 28..29 cleared |
| 15 | end of the note's chain |
| 16..23 | velocity → `voice.volume = v × 1/127` (`0x3c32`, `v0x45a0`) |
| 24..27 | the modulation → `× 1/15` |
| 28..29 | always 0 at runtime — the eboot's clip filler clears them |
| 30 | the sub-step shift |

The modulation is not a rounding-level thing: across 3,199,788 corpus records the nibble is 0 on
80.74% and **15 on 10.20%**, mostly a two-position switch. On `ghost.rinst` `Params[4]` runs 0.90 to
0.53, so a full-modulation note has *little* resonance where an unmodulated one has a lot.

### The pitch — the scale quantiser, the root, and `exp2f`

```
voice.pitch = quantise(note, clip.scale) + clip.root - 12         ; 0x3c4e and 0x3db5, `lea eax, [rax + rcx - 0xc]`
quantise(n, s):                                                    ; 0x240 -- ⚠️ NOT 0x250, which is mid-function
    if (unsigned)(s - 1) > 4:  return n                            ; out of range -> chromatic
    return (n / 12) * 12 + TABLE[s][n mod 12]                      ; signed division; the octave is preserved
```

`TABLE` is at module vaddr **`0x80c0`** — read off the **addend of the `R_X86_64_RELATIVE`
relocation** on the pointer slot at `0x8020` (reloc record at file `0x5888`), not computed from the
segment mapping, which put it 48 bytes early on a row of zeros and named every scale one place
late. Six rows of twelve `int32`; the seventh reads as garbage:

| scale | row | tones |
|---|---|---|
| 0 | `0 1 2 3 4 5 6 7 8 9 10 11` | chromatic — the identity, and never reached |
| 1 | `0 0 2 2 4 5 5 7 7 9 9 11` | **major** |
| 2 | `0 0 2 3 3 5 5 7 8 8 10 10` | **natural minor** |
| 3 | `0 0 0 3 3 5 5 7 7 7 10 10` | **minor pentatonic** |
| 4 | `0 0 3 3 5 5 6 6 7 7 10 10` | **blues** |
| 5 | `0 0 2 2 4 4 6 7 7 9 9 11` | **lydian** |

⚠️ **It is not a downward snap**: the blues row sends position 2 *up* to 3, and ties do not break
consistently (position 4 goes up to 5 while 11 goes down to 10). **Use the tables; do not replace
them with a rule.** `scale.ts`. The root comes from the eboot (`v0x160806`: `key < 12 ? key + 12 :
key`), so the transposition is `key mod 12` with C at 12 and 0 the untouched default; the scale
snaps **first**, then the key adds — quantising after the transposition would land on a different
note. ⚠️ **No key reaches the quantiser at all** — it takes exactly `edi` = note and `esi` = scale —
which is why `blockRoot` sat for a session as a named unknown whose answer was two instructions
away in the *other* binary.

Then the rate (`0x1d71`–`0x1db7`, the `1/12` at `v0x455c`, an imported `exp2f` at stub `0x150`):

```
if (!slot.pitched)  ratio = 1.0
else                ratio = exp2f((t·pitchSlide + voice.pitch + slot.fineTune − slot.rootNote) · (1/12))
if (slot.tempoSynced)  ratio *= Tempo / slot.nativeTempo
```

⚠️ **The test is made at both ends** (`0x1d79` for the start, `0x1e27` for the end, both on
`slot+0x90`), so an unpitched slot ignores the pitch *slide* as well as the pitch: a glide on a
kit or on `baiyon_bass_01`'s unpitched zones moves nothing. `render.ts` ramped it anyway until
2026-10-11 — +6.8 dB against the module on `baiyon_bass_01`'s pitch glide, −140 dB once dropped.

❗ **All of it float32, and on a held note the rounding is a drift.** The sum runs
`((t·slide + pitch) + fineTune) − (float)root`, times the float32 twelfth `0.083333336`, into the
console's `exp2f`; the tempo ratio is `f(Tempo / nativeTempo)` (`0x1e0a`). Each layer's rate is then
`f(ratio · f(detune + f(sinf(phase) · f(Params[16] · 0.05))))` at each end (`0x2755`–`0x27c1`,
`0x27d7`–`0x285a`), widened to double (`0x27c5`, `0x285e`) and stepped by `(double)(1.0f / N)`
(`0x2467`); only the per-frame sums are double (`0x2d59`, `0x2d5d`). A held note rounds the same way
every chunk, so the double rate is a constant relative error: `mosquito` at 58 on a root of 72 ran
0.0056 frames ahead of the module in four seconds, and transcribed it lands on the module's
84461.685867 to 1e-5. ⚠️ Rounding a double rate to float32 at the end is not the same number —
the module's sits an ulp lower because `exp2f`'s result and the detune were rounded first; tried,
it moved `pulse_wave` and not `mosquito`. On the engine's clock the voice does all of it
(`EngineRecord` in `audio/mixer.ts`); what that did to the songs is *62* in
[answered-questions.md](answered-questions.md). The console's `exp2f` and `_FSin` agree with `Math.fround` of the double result on
19,988 and 19,993 of 20,000 random arguments and are one ulp off on the rest
(`tools/prxrun.py`).

### The sampler is LINEAR, and it mipmaps by octave — `0x3780`

`0x3780` is the sample read (`mov ecx, [rdi + 0x78]` is its second instruction; ⚠️ `0x3740`, an
older label, is mid-function). ⚠️ **It wraps the integer index, never the position**
(`0x379d`–`0x37b9`): only an index past `start + len` is taken `mod len`, and then an index at or
past the slot's frame count `+0x78` reads **silence** (`0x37be`, `jge 0x3928`). The record's double
only grows. So a loop that ends on the sample's last frame meets index `frames` exactly once, on
the first pass, and plays one sample of 0 there — never again, because past it the index wraps.
✔ 18 of the 79 looped `.smp` end their loop on their last frame (counted off `data` and `smpl`,
2026-10-13): the `kenny_*` waveforms, `synth_strings`, `buzz_bass`, `rude_bass_c3`, three `uke_*`,
`musicbox_e4`, `ss_glock_b5`, `eg_c_muted_b5`, `record_static_loop`, `silence` and
`harp_fsharp4`. The last is heard: every harp note from 49 to 64 clicks at its first wrap, 5,769
frames in at note 51 — Indigo's opening arpeggio (4451115), the module and the render alike at
−105.8 dB. The tracker closes that gap by default, a deviation (*61* in
[open-questions.md](open-questions.md)). The float32 fraction also coarsens on long notes. `readMipped` does both (`LoopSpan.frames`;
measured against the module running, 2026-10-11). Then it selects the mip on the rate it was
handed — the ramped, per-sample rate, so a glide across an octave changes copy mid-note:

| ratio | compared at | mip | position scale |
|---|---|---|---|
| `>= 4.0` (`v0x4584`) | `0x37d4` | `slot + 0x50` | `× 0.25` (`v0x4588`, `0x3829`) |
| `>= 2.0` (`v0x458c`) | `0x37de` | `slot + 0x28` | `× 0.5` (`v0x4590`, `0x3850`) |
| otherwise | | `slot + 0x00` | `× 1` |

The fraction is carried into the mip (`(frac + (pos mod 4)) / 4` for the ÷4 level), so a note two
octaves above its slot's root reads a pre-decimated copy rather than skipping frames. The
interpolation (`0x389b`–`0x38ef`, the `1/32768` at `v0x4594`) is **two taps, plain linear**:
`a = d[i]/32768, b = d[i+1]/32768, out = a + (b − a)·frac`; the stereo path is bilinear — it lerps
L and R by a blend the caller passes, and the two frames by `frac`. **That blend is the note's
modulation**, ramped per sample (`[rbp-0xaa4]` → `[rbp-0x9d0]` at `0x2c48`, stepped at `0x2da6`):
a stereo `.smp` plays as **one** channel morphing from L to R with the modulation, and is then
panned like any mono sample. None of the 216 shipped samples is stereo; the tracker's stereo path
reads and pans each channel on its own, a convenience for its own buffers and not the engine's
behaviour. When a slot has no data (`length <= 0`) the reader synthesises `frac(pos × 0.01) × 2 −
1`, a **saw oscillator** fallback (`0x37fb`–`0x380b`, the `−1` at `v0x459c`); no shipped slot is
empty and the tracker skips an instrument whose sample is missing instead.

⚠️ **The position reaches the sampler as a float32.** The record keeps it as a double (`+0x40 +
8i`, stepped by `vaddsd` at `0x2d59`), but the call at `0x2c72` converts it with `vcvtsd2ss` and
`0x3780` truncates, floors and subtracts in single precision, so the interpolation fraction has a
float's precision at that position — a 256th of a frame between 32,768 and 65,535, a 32nd past
131,072 — a small, real roughness on long samples. `readMipped` passes the position through
`Math.fround` for the same one (2026-09-08). The velocity is read as eight bits × `1/127`
(`0x3c29`), so a record could ask for 2.0; none of 3,199,788 corpus records is above 127 and the
editor writes seven bits.

How much of the keyboard the mips cover, from every instrument's own splits and pitch formula:
55 of 68 instruments ever land on a mip over notes 0..87 (17.3% of note-slots), 68 of 68 over
0..127 (41.7%) — concentrated in the 21 single-slot instruments (`woodpecker` reaches rate 383); a
dense multisample like the piano keeps the rate near 1 across the middle.

⚠️ **`sinc8` is the wrong default for a faithful tracker, and `linear` is the target.** The SNR
table in `packages/lbp-tracker-lib/src/audio/interpolate.ts` still stands — linear is 19 dB at
4 kHz at rate 0.5, a 16% amplitude error — and the game simply lives with that roughness; the
mipmapping is what keeps it from being as bad as the table implies. `DEFAULT_INTERPOLATOR` is
`'linear'`; `sinc8` is kept for A/B.

### `Params` — every one a range, and all 27 named

Every use has the shape `value = Params[i].x + mod · (Params[i].y − Params[i].x)`, with `mod` the
voice's `+0x28`. A sweep from every function start collecting every operand that resolves into the
array finds **60 reads covering all 27 parameters**, always `.x` first and `.y` second, and the
`vsubss` after each is `y − x` for every one — ⚠️ the four filter parameters are loaded into
`xmm8`…`xmm14` in one batch at `0x2945`–`0x297d` and combined much later, so "the `vsubss`
immediately after the `.y` load" finds only 23 of 27. Where `.x == .y` — most instruments, most
params — the parameter is simply fixed.

| indices | section | detail |
|---|---|---|
| 0..2 | unison stack | detune spread, pan spread, random start (above) |
| 3..6 | Moog ladder | cutoff (squared), resonance, key tracking, envelope amount |
| 7..10 | envelope B | the filter ADSR |
| 11..14 | envelope A | the amplitude ADSR |
| 15..23 | three LFOs | (rate, depth, layer spread) each |
| 24..26 | output | level, send, drive |

Named in `packages/lbp-tracker-lib/src/params.ts`.

**The two ADSRs** — `0x16b0`, `(bool gate, float *level, float dt, a, d, s, r)`, called
twice per envelope per block (once with a near-zero `dt` and once with the block's, for a start and
an end value to ramp between — ⚠️ and the first call **advances the state too**, by
`frames / 48,000,000` units against the second's `frames / 192,000`, so the engine's envelopes run
a 250th faster than its clock and an attack of zero stands at full level from the first frame).
❗ **Both calls take the same four parameters, at the chunk's START modulation** (the table in
*The per-voice renderer*); `0x16b0` itself is `Envelope.advance`'s arithmetic, branch for branch,
the decay included (`stored + dt/D`, clamped at `2 − s`, so a sustain that falls under a held note
is approached at the decay's rate). It runs in float32 with the two `dt`s as the module's floats
(`v0x4560` is `f(1/48e6)`, `v0x4564` is `f(1/192000)`) and the times squared inside it
(`0x16e6`, `0x1712`, `0x1750`); `Envelope.advance32` is it exactly, and shows the one branch
`advance` takes differently: a standing start goes to full only from exactly 0, with no attack and a decay not below 0
(`0x171a`–`0x1736`). On the engine's clock envelope B runs `advance32` — what that is worth is
under *The filter* — and envelope A still runs `advance` in double:

| envelope | level | A | D | S | R | passed at |
|---|---|---|---|---|---|---|
| A — amplitude | `voice + 0x90` | `Params[11]` | `Params[12]` | `Params[13]` | `Params[14]` | `0x1fa3`, `0x1fed` |
| B — filter | `voice + 0x94` | `Params[7]` | `Params[8]` | `Params[9]` | `Params[10]` | `0x2193`, `0x21cd` |

The gate is `voice[+0x10] == 0`. **The stages are linear in level and the stage time is the
parameter squared**: the release branch (`0x1750`–`0x1792`) computes `release²`, un-mirrors the
stored level (values above 1 encode the rising phase, hence `2 − x`), then `level −= dt / release²`
and clamps at 0, which ends the voice. `dt = frames · 5.20833e-06` = `frames / 192000`,
i.e. quarter-seconds at 48 kHz, so a stage time is **`param² × 4` seconds**
(`ENVELOPE_SECONDS_PER_UNIT = 4` in `envelope.ts`; ⚠️ the other `dt` constant, `1/48,000,000` at
`v0x4560` (`0x201f`), feeds the first call of each pair and is read as a sampling of the current
level).
`Envelope.advance` is verified identical, including the mirrored storage. The corpus says which is
which without the disassembly: `Params[13].x` (sustain) separates 18 struck from 15 sustained
instruments with Cohen's *d* = −3.54 — exactly `1.000` on `strings_ensemble`, `choir`, `brass`,
`clarinet`, `concertina`, `sine_wave`, `saw_wave`, exactly `0.000` on `glockenspiel`, `marimba`,
`kalimba`, `harp`, `strings_pizz`, `musicbox`, `vibraphone`, `tubular_bells`, `0.070` on the piano.
`Params[12]` (decay) is largest on `vibraphone` 0.894, `tubular_bells` 0.850, `marimba` 0.756.

**The filter** — a 4-pole Moog ladder, the Stilson/Smith "Moog VCF, variation 1" from musicdsp.org
reproduced constant for constant, **two of them interleaved, one per output channel, on the
record's summed and clipped L/R** (*The record's accumulator*, above) — the ten floats at voice
`+0xa4`…`+0xc8`: L's `b1`…`b4` then `b0` at `+0xa4`…`+0xb4`, R's in the same order at
`+0xb8`…`+0xc8` (loaded at `0x2e2f`–`0x2e90`, stored back at `0x2fc3`). ❗ **Every operation is
float32**, one `vmulps`/`vaddps`/`vsubps` on a broadcast scalar, and the reference's decimals are
the module's floats: `0.8f` (`v0x4630`), `0.5` (`v0x4640`), `5.6f` (`v0x4650`), `−1` (`v0x4610`) and,
for the cube, ⚠️ `0.166667f` (`v0x4660`, `0x3e2aaac1`) — the reference's decimal, 22 ulps above a
sixth. In the module's order — the coefficients at `0x3124`–`0x317c`, L's ladder at
`0x31c6`–`0x327d`, R's at `0x3289`–`0x32ec`, and the ramp's copies of all three at
`0x346b`–`0x35e3`:

```
t = 1 − freq ;  p = freq + (freq·0.8)·t ;  f = (p + p) + −1 ;  q = res·((t·0.5)·((1 − t) + (t·t)·5.6) + 1)
x  = in − q·b4
b1 = p·(b0 + x) − f·b1 ;  b2 = p·(b1 + b1') − f·b2 ;  b3 = p·(b2 + b2') − f·b3 ;  b4 = p·(b3 + b3') − f·b4
b4 = b4 − (b4·(b4·b4))·0.166667                     ; b1' is the new b1, and so on down
b0 = x
```

driven, twice per block (`0x29c2`–`0x2a50` from the start modulation, `0x2a54`–`0x2aa5` from the
end's), by

```
keytrack  = (pitchRatio + −1) · Params[5] + 1         ; pitchRatio: [rbp-0xa90], the chunk's START ratio, at both ends
envFactor = (1 − Params[6]) + envelopeB · Params[6]   ; envelopeB: [rbp-0xb70], at the end [rbp-0xb60]
freq = clamp(envFactor · (Params[3]² · keytrack), 0, 1)
res  = clamp(envFactor · Params[4], 0, 1)             ; the resonance takes the ENVELOPE, not the pitch (0x2a50)
```

each `Params[i]` being `x + mod·(y − x)` in float32 (`param32`), and `envFactor` formed as written,
not as `1 + Params[6]·(envelopeB − 1)`, which is the same number only in exact arithmetic.

⚠️ The key-tracking and envelope terms are the same shape, built from the same
`vsubps/vmulps/vaddps` triple, and nothing in the arithmetic distinguishes them; what settles it is
the identity of `X`, traced back to its writer (*6b* in [answered-questions.md](answered-questions.md)).
The clamps are the engine's too (`0x2aa9`–`0x2af2`, `vminps 1` then `vmaxps 0`), and they are the
only ones: ⚠️ `Params[3]` is squared as it evaluates (`0x29ec`–`0x29ff`), so a cutoff below 0 comes
back positive. Inside modulation 0..1 no shipped instrument evaluates there; a slide over a third
of a step takes the modulation past 1 by the next walk (*The gate and the ramps*), and `saw_wave`
at 2.8 has cutoff −0.62, which the module squares to 0.38. Clamped first, as `Voice` did until
2026-10-11, it was 0, and the `gover` phrase of `prx-scene.ts` sat at −11.7 dB against the module;
squared, −100.1 dB, and seven more instruments with it. ❗ **And there is a bypass**: `0x2e99`–`0x2ed7`
take the unfiltered path, a loop at `0x2f00`–`0x2f9b` touching none of the ladder's constants, when
`0.99f < freqStart && 0 <= freqEnd` — `0.99f` (`v0x4620`) a hair above 0.99, the second half
always true of a clamped cutoff. It is audible, because the ladder is not transparent at
`freq = 1` (a unit impulse comes out at 0.833 and rings for half a second): `piano.rinst` sits on
the bypass side at and above its base note. `FILTER_BYPASS_CUTOFF` in `moog.ts`. Past the bypass,
`0x30d8` compares the block's two ends: equal, and `0x310b` runs the ladder with one set of
coefficients; different, and `0x33d6` onward re-derives them **per sample** from a ramp. Its step
is `(end − start) · (1.0f / N)`, a float32 reciprocal of the chunk's frame count (`0x33eb`–`0x3415`;
`N` is `[rbp-0xb30]`, converted at `0x1f74`), and `freq` and `res` take it **in float32, after
each sample's ladders** (`0x36d9`, `0x36ea`). ❗ **So a slow sweep stands still inside a chunk**: a
step under half an ulp of the cutoff is lost at every add — at a cutoff of 0.0144 an ulp is
9.3e-10 — and the cutoff catches up at the next chunk's start.

❗ **What that float32 is worth, part by part** (2026-10-11, engine clock, worst window against the
loudest; each row puts one part back in double and keeps the rest float32; the four middle
columns are the `gover` phrase):

| in double | `woodpecker` notes | `synth_strings` | `mosquito` | `electric_piano` | `ray_gun` | `square_wave` chord |
|---|---|---|---|---|---|---|
| nothing | −104.2 | −108.6 | −115.5 | −111.6 | −114.0 | −114.9 |
| the ramp's add | **−78.1** | **−58.5** | **−62.6** | **−71.7** | **−66.6** | **−90.8** |
| envelope B (`0x16b0`) | −104.2 | **−71.3** | **−72.2** | **−74.8** | **−85.6** | **−86.2** |
| the two ends | −104.2 | **−86.2** | **−68.0** | **−75.1** | −100.3 | −114.9 |
| the ladder | −104.2 | −110.2 | −113.9 | −115.7 | −114.1 | −114.9 |
| the coefficients | −104.2 | −109.3 | −110.0 | −111.7 | −114.0 | −114.9 |
| `1/6` for `0.166667f` | −104.2 | −110.4 | −115.6 | −112.0 | −114.1 | −114.9 |

The step's own reciprocal changes nothing — a double `(end − start)/N` accumulated in float32
measures the same — so the ramp's row is its add. A resonant ladder turns a cutoff wrong by a part
in 10⁵ into a phase drift of its ringing, which is why the error rode on `Params[4]` and read as
the ladder's. All of it in double, as `Voice` ran until 2026-10-11, `woodpecker` was −77.9, the four
`gover` scenes −57.3 … −71.6 and `square_wave`'s chord −90.6. Over the 201 one-instrument scenes
83 moved by more than 0.5 dB the right way and 2 the wrong way, by under 2 dB (`ghost` notes, whose
worst window is not the filter's: −101.0 dB with the filter taken out); the worst is now `noise`
notes at −85.6, and that is not the filter's either (−81.3 with it taken out). Of the 16 songs, 24870 went from
−105.5 to −115.5 and 15855 from −107.1 to −111.5, the rest within 0.4 dB. The ladder and its
coefficients alone in double give up at most 11.6 dB, all of it under −107 (`dubstep_kit` chord
−136.4 → −124.8, `mosquito` `gover` −115.5 → −109.8).

`Voice` runs all of it in float32 on the engine's clock (`VoiceSpec.engine`: `Envelope.advance32`
for envelope B, `filterEnds32`, `rampStep32` and the float32 add, `ladderCoefficients32Into`,
`MoogLadder32`) and the same formulas in double off it, bit for bit as before: on the default
clock the block grid's differences are the larger, and ten resonant scenes measure the same to
0.1 dB with the float32 ladder or without. ⚠️ **The ladder is the expensive part and the part that
is worth least.** `Math.fround` puts a conversion pair on every operation of a serial chain: a
stereo sample of the ladder goes from 20 to 55 ns, 25 to 72 on a ramp (i9-14900HX), and the 16
songs' 320 s render on the engine's clock in 8.2 s instead of 5.1 (+60%); float32 envelope B,
ends and ramp around the double ladder cost 5.35 s (+4%).

Corpus: cutoff wide open in 38/68; resonance zero in 60/68 (`ghost` 0.90, `saw_wave`
0.76, `space_piano` 0.65, `noise` 0.58); key tracking near-binary (1.0 in 41, 0.0 in 17); envelope
amount ≈0.98 on `square_wave`, `pulse_wave`, `e_guitar_distorted`, `robot`, `electric_piano`,
`noise`; the filter ADSR inert in 33/68 — and 27 of the 28 with amount 0 also have an inert
envelope B, the redundancy the two off-switches predict.

**The three LFOs** — the stride-3 tell at `0x21e5`–`0x22ea`, where `Params[15]`, `[18]`, `[21]` are
added to the three phases:

| LFO | phase | rate | scale | depth | layer spread | destination |
|---|---|---|---|---|---|---|
| 1 | `+0x98` | `Params[15]` | ×100 | `Params[16]` | `Params[17]` | **pitch**: `rate = pitchRatio · (detune[i] + 0.05 · depth · osc)` (`0x2770`–`0x27eb`) — vibrato and unison detune share the 0.05 |
| 2 | `+0x9c` | `Params[18]` | ×100 | `Params[19]` | `Params[20]` | **amplitude**: `gain = baseGain · (1 + depth · osc)` — tremolo |
| 3 | `+0xa0` | `Params[21]` | ×50 | `Params[22]` | `Params[23]` | **pan**: `v = \|osc·depth + clipPan + spread[i]\|`, folded to `[0, 1]` as a triangle (`0x25fc`–`0x2634`), straight into the pan law |

The layer spread is `Params[17|20|23] · 2π/Numstack` (`0x2306`–`0x2346`), fanning a stacked voice's
layers around the cycle. The corpus confirms which member is which: depths are zero in 62, 65 and
62 of 68, rates in 1, 0 and 0. The oscillator at stub `0x130` is libc's `_FSin` (NID `ZtjspkJQ+vw`,
sine/cosine with an integer selector in `edi`, zero for sine — 368 call sites in the eboot use the
same idiom), pinned by parsing the PRX's import table rather than inferred. ⚠️ **The oscillator runs twice per
layer per chunk, not per sample**: the six `call 0x130` in the per-layer loop (`0x24a0`–`0x28e3`,
*before* the per-sample loop at `0x2b70`–`0x2df9`) are **two per LFO** — at the phase (`0x24df`,
`0x25f9`, `0x27a0`) and at the phase plus the chunk's increment (`0x2557`, `0x26c6`, `0x282e`) —
and each pair becomes a `{value, step}` the sample loop ramps (`0x25a5`/`0x274f`/`0x2876` write
them; `0x2d78`, `0x2d8f`, `0x2d5d` step them). The three stored phases advance **once**, after the
loop (`0x28f1`, `0x2915`, `0x293b`), by `rate × scale × frames / 48000` (`0x2263`–`0x22cf`, the
`1/48000` at `0x20ce`) — a velocity in radians per second, not an increment per block. ❌ This file
read "the layer's rate is written as a double the sample loop reads as a constant" until
2026-09-08; the double at `[r14-8]` is the start value and the one at `[r14]` is the step (*44* in
[answered-questions.md](answered-questions.md)). `Voice.startSegment` in `mixer.ts` does the same;
evaluating the sine per sample cost 1.19 `Math.sin` calls per voice-frame and was 10% of a render.
Three layers of pan compose — the clip's own (`voice+0x18`), the unison spread, and LFO 3 — and
`lfo.ts` + `mixer.ts` do exactly that. **There is no branch on the depth**: every record's pan goes
through the fold, so a layer spread past 1 turns back rather than clamping, and the fold's input is
the pan as written — feeding it `2 × pan` put every centred voice on the right wall for a week
(*8*).

**The output stage**:

| param | role | corpus |
|---|---|---|
| `Params[24]` | **output level**, entering the gain chain with `sqrt(1/Numstack)` (the equal-power stacking correction) and a factor of 2 | never zero, 61 distinct values in 68 — the trim that balances the set; loudest `triangle_wave` 0.67, quietest `ray_gun` 0.07 |
| `Params[25]` | the **echo send** — `voice+0x1c = clamp01(bipolar(Params[25], 2·echoSend − 1))` | zero on 33 of 68, never above 0.23 |
| `Params[26]` | the **drive** — a soft clip on the sampler's output | zero on 64 of 68: `e_guitar_power` 0.73, `e_guitar_distorted` 0.57/0.70, `space_piano` 0.51, `electric_harpsichord` 0.39 |

The drive (`0x1ee0`–`0x1f1f`, then `0x2c88`–`0x2cf1`): `d = clamp(Params[26], −0.95, 0.95)`,
`k = 2d/(1 − d)`, and per layer on the sample read, before the gain and the pan,
`f(x) = (1 + k)·x / (1 + k·|x|)` — the standard soft clip. `k = 0` is an exact bypass, the rails
`f(±1) = ±1` are fixed points, and the reciprocals are `vrcpps` plus one Newton step, which
JavaScript cannot reproduce bit for bit, so `mixer.ts` divides. `e_guitar_power`'s `k = 5.442` is a
gain of 6.4× on small signals, and it carries the lowest output level in the game (0.088) — two
errors cancelling is why implementing the level without the drive made it quiet *and* clean rather
than obviously wrong. 50,383 corpus notes (2.73%) have a non-zero *evaluated* drive.

⚠️ **The echo send's placement field is a bipolar offset, not a blend**: `0x3ca1` applies it as
`v + o·v` when `o < 0` and `v + o·(1 − v)` when `o >= 0`, so 0.5 leaves the instrument's own send
untouched, 0 mutes it and 1 forces unity. Most placements are exactly 0, so the modulation's effect
on the send is inert in practice — 68 notes in 5 sequencers of the whole corpus. **Do not cite
`Params` swings as audible weight without the placement.** The reverb send, `voice+0x24`, is the
placement's `reverbSend` alone (`[clip+0x42c]`), untouched by the modulation.

### The pan law is LINEAR, not equal-power

`0x2d39`–`0x2dda`: `L += (1 − p)·gain·sample`, `R += p·gain·sample`. Amplitudes sum to 1 rather than
powers, so a sound crossing the centre dips about 3 dB relative to an equal-power law — the
worse-sounding law, and the game's. `panGains` in `voice.ts` had been equal-power for most of the
project's life; five tests depended on the old `sqrt(1/2)` centre factor. FMOD's own narrowing of
the image sits *above* this, in [lbp-audio-engine.md](lbp-audio-engine.md).

### The output lanes and the sends — `0x2f00`–`0x2f8f`

```
out4[4i+0] += L                 out4[4i+2] += L * voice[0x24]      ; the reverb send bus
out4[4i+1] += R                 out4[4i+3] += R * voice[0x24]
                                out2[2i+0] += L * voice[0x1c]      ; the echo's own input
                                out2[2i+1] += R * voice[0x1c]
```

`out4` is the DSP's 4-channel output buffer; `out2` is a stack `alloca` inside the block function,
so the echo is internal and the reverb send leaves the plugin on channels 2-3. **Both sends are
post-fader and post-pan.**

## The voice pool — 32, steal the quietest

**32 is an immediate** (`cmp rbx, 0x1a28` against records of `0xd0` from `0x28`), the PRX out of
`CUSA00063` is the PS4 build, and the eboot links it directly (it appears only in the import
tables, never as a runtime-registered plugin), so nothing can raise it. One state block is one
whole sequencer — it holds the clip count, the clip arrays, the eight channel volumes and the 32
records — so **`C4K3 S0NG`'s 244 clips share one pool of 32**, and the game walks every
`MusicSequencer` Thing when one starts (`v0x1c5773`), so even two sounding sequencers could not
give one more.

The allocator, `0x1600`–`0x1692`:

```
xmm0 = 1.0 ; edx = 0                    ; best score so far, best index -- ⚠️ 1.0 and 0, not infinity
loop over 32 records:
  if byte [rec] == 0xff: return rec      ; a free record wins immediately
  score = [rec + 0x04] * [rec + 0x0c]    ; channelVolume × clip Level × the current point's velocity/127
  keep the lowest
return the quietest
```

No channel comparison, no instrument comparison, no reservation: anything can steal anything.
⚠️ A pool where every voice scores 1.0 or more loses voice 0 rather than the quietest;
`polyphony.ts` reproduces that and a test pins it. The `[+0x14]` fast path at `0x1610` (take a
record whose `+0x14 > 0` before asking whether it is free) is **dead**: both callers (`0x4ef`,
`0x96b`) pass `dil = 0`.

❗ **The score a held record is ranked by is its current one, not its claim's.** `0xa90` walks every
record (`0x3930` at `0x0eef`) and only then spawns the step's notes (`0x280` at `0x0f1c`, which
calls the allocator at `0x04ef`), so a note on a step meets the scores that step's walk has just
written — the note's volume read at that whole step (*The gate and the ramps*, above), and its last
point's from the walk that closed its gate on. A note fading out becomes the cheapest thing in the
pool as it fades. A note claimed in the same walk is ranked by its claim: the walk at note start
(`0x05bb`) leaves its first point's velocity, the playhead being on that point's step.

**A record is freed when the sound ends, not when the note does** (measured six ways, *29* in
[answered-questions.md](answered-questions.md)): when the envelope's level at the chunk's *end* —
the second call's return, `0x20e0` — has reached zero (`0x2117` sets the flag, `0x307f` reads it
once the chunk is rendered, `0x3093` writes `[rec] = 0xff`), or when an **unlooped** sample's
position passes its frame count (`0x3035`–`0x3069`), or when the chunk-end **volume ramp** is not
positive (`0x209a`/`0x20de`: the velocity ramp at `t_end`, not the envelope — so a note that opens
at 0 and *holds* it is freed after one block and never sounds, 3,132 corpus notes, while a fade-in
from 0 lives because its chunk-end ramp is positive; and a note that fades to 0 before its end is
freed there), or when `channelVolume × Level` is not positive (`0x20ea`). `Voice.silentAfter` and
`silentAt` in `render.ts` are the last two (2026-09-08). ⚠️ The envelope's end value frees the
record **in any stage**: a struck instrument (sustain 0, 18 of 68) gives its record back once its
decay has run, with the gate still open, and its ladder stops with it. The mixer freed only a
finished release until 2026-10-11 — `woodpecker`'s ladder rang a block past the module's silence,
−50 dB → −81 dB — and the pool plan now ends such a note at attack plus decay. A one-shot
therefore plays to the end of its sample whatever its note says; a gated note rings through its
release still holding its record. **One record plays every layer of its note** — the per-layer loop
is inside `0x1c60`, once per record — so a stacked note is one record, not `Numstack`
(`C4K3 S0NG`: 3,634 notes cut short counting per layer, 1,526 per note).

❗ **A sample that runs out frees its record after the chunk, and the chunk plays whole.**
`0x3035`–`0x3069` run once per record per chunk, after the output lanes and the store of the
ladder states at `0x2fc3`, where every ladder path rejoins (`0x33d1`, `0x3701`, `0x3738`,
`0x3772`): layer 0's position converted to float32 (`0x303b`) against `+0x78` converted too
(`0x3052`), **strictly** greater (`jbe 0x307f`), on a slot whose loop length `+0x80` is zero
(`0x305c`) and whose length is positive (`0x3067`); then `[+0x04]` is zeroed (`0x306b`) and the
record freed (`0x3093`). Until then the chunk runs to its end: layer 0 reads silence past its last
frame (`0x37be`), the other layers read on at their own positions, and the clip and the ladder run
on the sum, so a filtered one-shot's ladder rings to the chunk's end, a stacked one's later layers
sound there, and a position landing on the count exactly holds the record a chunk more. No later
layer frees it. A step's walk runs after the first chunk whose end reaches the step (*The clock*),
so it finds the record free when the chunk it ran out in began before that step — the pool's
`freedBy` on the engine's clock (`engine-clock.ts`), which takes the sample's length over the
note's rate and leaves out layer 0's detune, drawn after the pool has run. `Voice` stopped every
layer and the ladder at layer 0's last frame until 2026-10-11; rendered whole and freed after
(`Voice.ranOut`), against
the module on the engine's clock, worst window against the loudest, dB (the module runs from
`tools/prxsynth.py`, the scenes and songs from `prx-scene.ts` with `CLOCK=1`):

| scene | before | after |
|---|---|---|
| `bb_kit_2` notes / chord | −63.3 / −68.5 | −108.3 / −112.8 |
| `hand_percussion` glide / notes / chord | −68.6 / −72.1 / −74.3 | −104.8 / −101.9 / −107.2 |
| `dubstep_kit` notes | −68.7 | −125.8 |
| `baiyon_tinkle_01` / `baiyon_shiny_01` glide | −61.2 / −71.0 | −113.7 / −110.9 |
| `ektara` notes | −78.0 | −111.0 |
| 281831 (`Avian`), `8bit_kit_1` alone, 27 s | −67.1 | −123.7 |
| 281831, every track, 27 s / 175 s | −78.1 / −78.1 | −114.6 / −104.8 |
| 24870, 20 s | −103.3 | −105.5 |

Of the 201 one-instrument scenes, 28 improve and none worsens; on the other songs of *62* in
[answered-questions.md](answered-questions.md), 731173 over 100 s, 743527 over 180 s and
`C4K3 S0NG` over 28 s the whole render and the worst window against the loudest move by 0.1 dB or
less. The pool is sensitive to the free: taking it a block
later puts 731173 at −22.3 dB over 100 s, where the chunk above and the plain `step + frames / rate`
make the same decisions on all 20 renders.

❗ **Nothing fades a freed record's output.** The ten ladder states at `+0xa4`…`+0xc8` are left as
they were — `0x19e0`'s memset clears them only when the record is claimed again — and the ladder
runs after the gain (*The record's accumulator*, above), so whatever it holds when the record is
freed stops in one frame. With envelope B shutting the cutoff during the release the ladder all
but freezes and holds a value: `e_perc_1` at full modulation drops +0.0100 to zero 1,281 frames
after the gate on *Rhombitruncated*'s first bongo hit. What the tracker does about it by default is
*61* in [open-questions.md](open-questions.md).

**The skip at `0x04d4`** — a record is not allocated when `channelVolume × [clip+0x420]` is not
positive — tests the clip's `Level`, **not the note's velocity**: 0 of 74,864 corpus clips set
`Level` to zero and 0 notes sit on a muted channel, so it never fires on real data, and the 701
`C4K3 S0NG` notes that open at velocity 0 and rise (`Northern Lights`-style fade-ins) get a record
exactly as they do here. ⚠️ Reading it as "the note's opening volume" would delete them.

**The order a step's notes take records in** is the scan's (*Which clips spawn*): clip by clip
from the last header, record by record inside each, every note at the walk of its whole step,
sub-step or not. With the pool full that order decides who steals whom, and with records free it
decides which index each takes, which decides the next steal's ties. `Influx` (song 68746) reaches
32 records at step 128: allocated in schedule order the render was −34.6 dB against the module;
in the scan's, −74.8 dB (`PooledNote.rank`; on the engine's clock only, 2026-10-11).

**The walk's score, measured on the module** (2026-10-11, `CLOCK=1`, the release tail on as the
module has it). Scored once at its opening velocity, a fading note was the dearest thing a pool
held when the engine's cheapest; scored per walk (`PooledNote.walks`, `scoreAt`), the render picks
the module's victims:

| song, span | claim only | per walk |
|---|---|---|
| `C4K3 S0NG`, 25.8–28 s (*29* in [open-questions.md](open-questions.md)) | −14.6 dB | **−67.7 dB** |
| `C4K3 S0NG`, 0–28 s | −20.8 dB | −63.0 dB |
| `Vitriol` (731173), 0–100 s | −23.5 dB | −59.8 dB |
| `Umbra` (743527), 0–180 s | −29.1 dB | −64.6 dB |
| `Avian` (281831), 0–175 s | −52.6 dB | −59.7 dB |

The 16 songs of *62* in [answered-questions.md](answered-questions.md) render bit for bit as before
over their first 20 s; over their whole length three of them steal a different note somewhere —
the three above — and the other 13 make the same decisions on either clock, tail on or off.
Our final walk scores on the `C4K3` bar are the module's records' to four places (0.0266, 0.0443,
0.0531, 0.1004).

What ships: `allocateVoices` and `LiveVoicePool` in `polyphony.ts` with the engine's per-walk score
and pool, `VOICES_UNLIMITED` to switch the cap off, and `RenderOptions.releaseTail` **defaulting
off** — the one place the pool knowingly departs from the engine, a decision recorded in
[open-questions.md](open-questions.md).

## The echo — a stereo delay in beats, with a hard clip

Not an FMOD DSP. `0xa90` sets it up at `0x0f6a` and calls the kernel at `0x0680`/`0x07c0`, and its
ring is the 768,000-byte allocation at `[state+0x1b18]`: **192,000 floats**, interleaved stereo,
96,000 frames, 2.0 s at 48 kHz.

```
0x0f6a  steps  = (int)floor(stored * 16 + 0.5)      ; stored = [state+0x1a30] = EchoTime * 0.5
0x0f8e  fps    = (int)(720000 / tempo)              ; frames in one step
0x0fa4  len    = (steps * fps) & ~0xf
0x0faa  len    = clamp(len, 16, 192000)
0x0fcb  cursor = (cursor + 2*n) % len                ; n frames per block -> 2n floats
```

`0x0680` reads `min(2n, len − cursor)` **floats** from the ring at `cursor`, processes them as
`[L, R, L, R, …]`, and writes back **at the same cursor** (`0x08d3`). One cursor for read and write
means the delay is one full trip round the ring, so **delay in frames = `len / 2` = `round(EchoTime
× 8) / 2` steps = `EchoTime` beats exactly**. The decisive number is the clamp: 192,000 is the
ring's float count, not its frame count. ⚠️ Three readings preceded this — `EchoTime × 0.5`
*seconds*, then beats for the wrong reason, then eight steps per unit read off `stored * 16` — and
the lesson is narrow: `stored * 16` is a *length*, and a length means nothing until you know what
it counts.

The kernel, `0x07c0`, per frame:

```
dL, dR = ring[2i], ring[2i+1]
s3 += (dL - s3) * k ;  s2 += (dR - s2) * k          ; k = 1 - [state+0x1a40]  -- pass-through, below
s1 += (s3 - s1) * k ;  s0 += (s2 - s0) * k
wL, wR = EchoMix * s1, EchoMix * s0
out4[4i+0..3] = clamp(out4[4i+0..3] + {wL, wR, wL, wR}, -1, +1)
ring[2i], ring[2i+1] = fb*s1 + send[2i], fb*s0 + send[2i+1]    ; fb = clamp(EchoFeedback, 0, 0.95)
```

- **The wet is added to all four output channels**, and channels 2-3 are the reverb send: **the
  echo feeds the reverb.**
- **The output is hard-clipped to ±1**, all four lanes, once per frame (`0x0889`–`0x0891`). This is
  the only nonlinearity in the plugin's output, it sits *inside* the plugin two DSPs before the end
  of the chain, and the reverb is fed a clipped signal. `clipToUnit` in `effects.ts`; ⚠️ its frame
  counter has to watch all four lanes, and a fold gain applied upstream of it once engaged it on
  material the game passes untouched (*39*).
- ⚠️ **Two features in the code the game never reaches**: the cascaded one-pole damping
  (`[state+0x1a40]`) and ping-pong (`[state+0x1a3c] > 0.5` swaps L and R on the write-back). `0x11fd`
  and `0x1207` initialise both to zero and nothing writes them — a byte scan of the whole eboot
  finds no store to `+0x1a3c`, and both state-upload paths (`v0x1c5cf8`, `v0x1c62b7`) skip them.
  With `[+0x1a40] = 0` the coefficient is 1 and the one-poles are pass-through. Do not "find" a
  filter in that loop later and wire it up.

| field | state | law |
|---|---|---|
| `EchoTime` | `+0x1a30`, stored as `× 0.5` | the delay, in **beats** |
| `EchoFeedback` | `+0x1a34` | clamped to `[0, 0.95]` at `0x0793`–`0x079b` |
| `EchoMix` | `+0x1a38` | a plain wet gain; the dry is not attenuated |

## The imports, pinned

Parsed from the fSELF rather than guessed: its ELF header is at file `0x120`; `PT_SCE_DYNLIBDATA` is
type `0x61000000` (⚠️ not `0x6fffff00`, which is `PT_SCE_COMMENT`); the dynlibdata blob is at file
`0x54a0` with `PT_DYNAMIC` inside it at `0x5938`; every `DT_SCE_*` value is an offset into that blob
(`STRTAB 0x18`, `SYMTAB 0x160` with 14 symbols, `JMPREL 0x2b0` with 9 entries, `RELA 0x388`). A PLT
stub's `push N` is its `JMPREL` index, whose `r_info >> 32` is the symbol index.

| stub | symbol | what |
|---|---|---|
| `0xe0` | `8zTFvBIAIN8` | `memset` |
| `0x120` | `Ou3iL1abvng` | `__stack_chk_fail` |
| `0x130` | `ZtjspkJQ+vw` | `_FSin` — sine/cosine |
| `0x140` | `cpCOXWMgha0` | `rand` |
| `0x150` | `wuAQt-j+p4o` | `exp2f` |

`libkernel` is library 1, `libc` library 2, and the `#B#C` group is libc — the game's own
`sce_module/libc.prx`. `tools/prxnid.py` does this for any of the PRXs.
