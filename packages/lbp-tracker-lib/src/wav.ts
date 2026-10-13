/**
 * Canonical 16-bit PCM WAV writer.
 *
 * Byte-for-byte identical to write_wav() in tools/fsb.py, deliberately: that
 * equality is what makes the golden test in packages/lbp-tracker-lib/test/fsb.test.ts a real check of
 * the decoder rather than a smoke test.
 *
 * WAV is little-endian, like FSB4 and unlike LBP's own resources.
 */

const HEADER_SIZE = 44;

export interface WavLoop {
  /** `smpl`'s loop start, verbatim. */
  readonly start: number;
  /** `smpl`'s loop end, verbatim. */
  readonly end: number;
  /** 0 = forward, 1 = alternating, 2 = backward. Only 0 is seen in LBP. */
  readonly type: number;
}

/**
 * The loop the engine plays, `[start, end)`: the loader's own reading of `smpl`.
 *
 * ✔ **Read out of the eboot's sample loader** (`v0xb3e520`, 2026-09-08, the
 * function that fills the plugin's slot -- `+0x78`, `+0x7c`, `+0x80`, `+0x94`
 * -- and calls its mip builder): `+0x7c` is `dwStart` as written, clamped to
 * the last frame; `+0x80` is `min(dwEnd + 1, frames) − start`, so `smpl`'s end
 * is inclusive and the region half-open. The loader then copies the loop's
 * first 16 frames to just past its end ({@link patchLoop}), which is what
 * makes the sampler's unwrapped second tap land on loop-start material: the
 * audible join is `d[dwEnd] → d[dwStart]`, the literal one.
 *
 * ❌ **Until 2026-09-08 this returned `[dwStart − 1, dwEnd + 1)`**, a region
 * one frame longer than the engine's, chosen by measuring which join was
 * smoothest over the corpus (`d[end] → d[start − 1]` at 0.59× the average
 * adjacent step against 3.28× for the literal one; steering/game-assets.md
 * keeps the table). Smoother, and not the game's: it lengthened every loop's
 * period by a frame -- a few cents flat on a 45 ms loop -- and bought a
 * smoothness the game does not have. If a sustained high piano note clicks
 * here and not in a capture of the game, this is the line to revisit.
 */
export function loopRegion(
  loop: WavLoop,
  frameCount: number,
): { start: number; end: number } {
  const start = Math.max(0, Math.min(loop.start, frameCount - 1));
  return { start, end: Math.max(start, Math.min(frameCount, loop.end + 1)) };
}

/** Frames the loader copies from the loop's start to just past its end. */
export const LOOP_PATCH_FRAMES = 16;

/**
 * The engine's loop patch: the loop's first 16 frames written over the 16
 * frames after its end, in a buffer with room for them.
 *
 * `v0xb3e77c`-`v0xb3e868` in the eboot, once the `smpl` chunk is read: for
 * `i` in 0..15, `data[end + i] = data[start + i]`, with `end` the exclusive
 * end. The buffer was allocated with 16 to 31 frames of slack and zero-filled
 * past the data (`v0xb3e950`-`v0xb3e97e`), so the copy always has room. The
 * sampler (`0x3780`) wraps only *past* `end` and leaves its second tap
 * unwrapped, so at the last frame of the loop it interpolates towards
 * `data[end]` -- and thanks to this patch that is the loop's first frame, not
 * whatever the file held after the loop. The mip copies are built from the
 * patched buffer, so their wraps see the same material.
 *
 * A copy, never in place: the decoded channels are shared with paths that read
 * the file as it is.
 */
export function patchLoop(
  channel: Float32Array,
  loop: { readonly start: number; readonly end: number },
): Float32Array {
  const out = new Float32Array(Math.max(channel.length, loop.end + LOOP_PATCH_FRAMES));
  out.set(channel);
  for (let i = 0; i < LOOP_PATCH_FRAMES; i += 1) {
    out[loop.end + i] = channel[loop.start + i] ?? 0;
  }
  return out;
}

/**
 * The samples whose loop is smoothed (`smoothLoop`), by sample GUID, with the
 * number of periods of the note each loop holds. **Ours, not the game's.**
 *
 * The harp's three samples pass from a plucked string that still beats --
 * `harp_fsharp4`'s level swings between 0.17 and 0.22 every ~1,300 frames --
 * into a loop of a few periods whose level is flat to a thousandth, and the
 * project's owner heard that passage as a jump on every note (Indigo's
 * opening arpeggio, 4451115). The periods are read off the notes the files
 * are named for, F#3, F#4 and F#5 at 48 kHz: 2,339, 1,169 and 260 frames are
 * 9, 9 and 4 periods of 259.9, 129.9 and 65.0. ⚠️ A longer loop taken from the
 * sustained part, crossfaded, and a plucked-string tail grown from the last
 * period were both tried and both judged worse by ear (2026-10-13).
 */
export const LOOP_SMOOTHING: ReadonlyMap<number, number> = new Map([
  [139000, 9], // harp_fsharp3
  [139002, 9], // harp_fsharp4
  [139001, 4], // harp_fsharp5
]);

/**
 * A loop made to repeat one shape and to be entered gradually. **Ours.**
 *
 * Inside `[start, end)` every period becomes the average of the loop's
 * `periods` -- read at fractional offsets, since a period need not be a whole
 * number of frames -- so the loop repeats one waveform rather than a pattern
 * of slightly different ones. Over the two loop lengths before `start`, the
 * recorded sound is crossfaded on a smooth curve into the loop's own
 * continuation backwards, which is in phase because the loop is whole
 * periods, so the string's beating dies away into the loop instead of
 * stopping where it starts. The attack before that is untouched. Works on the
 * unpatched channel; `engineSample` patches the result as the loader would.
 */
export function smoothLoop(
  channel: Float32Array,
  loop: { readonly start: number; readonly end: number },
  periods: number,
): Float32Array {
  const { start, end } = loop;
  const span = end - start;
  const out = new Float32Array(channel);
  if (span <= 1 || periods < 1) return out;
  const period = span / periods;
  // The loop read as a periodic signal at any offset from its start.
  const loopAt = (source: Float32Array, x: number): number => {
    const u = ((x % span) + span) % span;
    const i = Math.floor(u);
    const f = u - i;
    const a = source[start + i];
    const b = source[start + ((i + 1) % span)];
    return a + (b - a) * f;
  };
  for (let j = 0; j < span; j += 1) {
    let sum = 0;
    for (let m = 0; m < periods; m += 1) sum += loopAt(channel, j + m * period);
    out[start + j] = sum / periods;
  }
  const fade = Math.min(2 * span, start);
  for (let i = start - fade; i < start; i += 1) {
    const t = (i - (start - fade)) / fade;
    const w = t * t * (3 - 2 * t);
    out[i] = (1 - w) * channel[i] + w * loopAt(out, i - start);
  }
  return out;
}

/**
 * A decoded sample as the engine holds it: the loader's loop region, and the
 * channels with its 16-frame patch applied. What every `SampleBuffer` built
 * from a `.smp` should start from.
 *
 * Given the sample's GUID, it also returns `smoothed`, the same channels
 * through `smoothLoop` and patched, for a sample `LOOP_SMOOTHING` lists:
 * ours, read by a voice only with `declick` (`SampleBuffer.smoothed`).
 */
export function engineSample(wav: WavData, sampleGuid?: number): {
  readonly channels: Float32Array[];
  readonly loop: { readonly start: number; readonly end: number; readonly frames: number } | undefined;
  readonly smoothed?: Float32Array[];
} {
  const frames = wav.channels[0].length;
  const loop = wav.loop ? loopRegion(wav.loop, frames) : undefined;
  const looped = loop !== undefined && loop.end > loop.start;
  const channels = wav.channels.map((c) => (looped ? patchLoop(c, loop) : c));
  const periods = sampleGuid === undefined ? undefined : LOOP_SMOOTHING.get(sampleGuid);
  const smoothed = looped && periods !== undefined
    ? wav.channels.map((c) => patchLoop(smoothLoop(c, loop, periods), loop))
    : undefined;
  // `frames` rides on the loop because only a looped buffer is longer than the
  // sample: the patch puts 16 frames past the loop's end, and the sampler still
  // tests its index against the slot's own length (`readMipped`).
  return { channels, loop: looped ? { ...loop, frames } : undefined, ...(smoothed ? { smoothed } : {}) };
}

/**
 * Crossfade a loop so its seam stops repeating the region's own amplitude
 * contour.
 *
 * The shipped loops are spliced cleanly but each carries its own envelope --
 * `piano_c6`'s spans 1.70 dB peak to trough over 45 ms -- so repeating one
 * modulates the output at the wrap rate and is heard as a flutter. Fading the
 * end of the loop into the material that precedes `start` removes the seam
 * itself; it does not flatten the contour, but it stops the discontinuity in
 * the contour's *slope* at the wrap, which is the audible part.
 *
 * ⚠️ **MEASURED NOT TO HELP. Kept only so the dead end is not re-explored.**
 * On `piano_c6` at F5, the envelope modulation at the wrap rate goes
 * *up*, not down, as the crossfade lengthens:
 *
 * | crossfade | none | 2 ms | 5 ms | 10 ms | 20 ms |
 * |---|---|---|---|---|---|
 * | modulation | 5.75% | 5.72% | 5.91% | 6.79% | **9.51%** |
 *
 * That is the proof that the flutter is **not the seam**: smoothing the seam
 * changes nothing, and a long fade makes it worse by mixing in the louder
 * pre-loop material. The cause is the loop region's own 1.70 dB amplitude
 * contour, which no splice can flatten. See steering/game-assets.md.
 *
 * Returns new channel buffers, leaving the originals untouched.
 */
export function crossfadeLoop(
  channels: readonly Float32Array[],
  loop: { start: number; end: number },
  fadeFrames: number,
): Float32Array[] {
  const span = loop.end - loop.start;
  // The fade needs `fadeFrames` of material before the loop to blend with, and
  // must not swallow the loop itself.
  const n = Math.min(fadeFrames, loop.start, Math.floor(span / 2));
  if (n <= 0) return channels.map((c) => new Float32Array(c));

  return channels.map((source) => {
    const out = new Float32Array(source);
    for (let i = 0; i < n; i += 1) {
      // Equal-power blend across the last n frames of the loop.
      const t = (i + 1) / (n + 1);
      const a = Math.cos((t * Math.PI) / 2);
      const b = Math.sin((t * Math.PI) / 2);
      const tail = loop.end - n + i;      // approaching the seam
      const head = loop.start - n + i;    // what precedes the loop start
      out[tail] = source[tail] * a + source[head] * b;
    }
    return out;
  });
}

export interface WavData {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  /**
   * Loop points from the `smpl` chunk, if the file has one.
   *
   * ⚠️ **These matter, they are not DAW leftovers.** Every pitched sequencer
   * sample carries one, and without honouring it a note's length follows the
   * sample's length divided by the playback rate: notes below the slot's base
   * note ring far too long, notes above it cut off early. That is exactly the
   * symptom the instrument bench produced before this was read.
   */
  readonly loop?: WavLoop;
  /**
   * `smpl`'s MIDI unity note. ⚠️ **Not authoritative** — it reads 60 on every
   * piano sample regardless of the note actually recorded, so it is the DAW's
   * default. `RInstrument`'s `baseNote` is the real pitch reference.
   */
  readonly unityNote?: number;
}

export class WavFormatError extends Error {}

/**
 * Read a 16-bit PCM RIFF/WAVE file.
 *
 * This is the sequencer's actual sample format: the `.smp` resources in the
 * FARC archives are plain RIFF, 48000 Hz 16-bit mono for the instruments
 * measured so far. See steering/game-assets.md.
 *
 * Chunks are walked rather than assumed at fixed offsets -- a `fmt ` chunk can
 * be longer than 16 bytes and extra chunks can sit before `data`.
 */
export function readWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new WavFormatError('not a RIFF/WAVE file');
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Uint8Array | undefined;
  let loop: WavLoop | undefined;
  let unityNote: number | undefined;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    } else if (id === 'smpl' && size >= 36) {
      unityNote = view.getUint32(body + 12, true);
      const loops = view.getUint32(body + 28, true);
      if (loops > 0 && size >= 36 + 24) {
        loop = {
          type: view.getUint32(body + 36 + 4, true),
          start: view.getUint32(body + 36 + 8, true),
          end: view.getUint32(body + 36 + 12, true),
        };
      }
    }
    at = body + size + (size & 1); // chunks are word-aligned
  }

  if (!data) throw new WavFormatError('no data chunk');
  if (format !== 1) throw new WavFormatError(`format ${format} is not PCM`);
  if (bitsPerSample !== 16) {
    throw new WavFormatError(`${bitsPerSample}-bit is not supported, only 16`);
  }
  if (channels < 1) throw new WavFormatError('no channels');

  const frames = Math.floor(data.length / (2 * channels));
  const out: Float32Array[] = [];
  const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let ch = 0; ch < channels; ch += 1) {
    const buf = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      buf[i] = pcm.getInt16((i * channels + ch) * 2, true) / 32768;
    }
    out.push(buf);
  }
  // A loop that runs past the data is authoring debris, not a loop.
  if (loop && (loop.end >= frames || loop.start >= loop.end)) loop = undefined;

  return { channels: out, sampleRate, bitsPerSample, loop, unityNote };
}

export function writeWav(
  pcm: Int16Array,
  channels: number,
  sampleRate: number,
): Uint8Array {
  if (channels < 1) throw new RangeError(`channels must be >= 1, got ${channels}`);

  const bodyBytes = pcm.length * 2;
  const out = new Uint8Array(HEADER_SIZE + bodyBytes);
  const view = new DataView(out.buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bodyBytes, true);
  ascii(8, 'WAVE');

  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  ascii(36, 'data');
  view.setUint32(40, bodyBytes, true);

  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(HEADER_SIZE + i * 2, pcm[i], true);
  }
  return out;
}
