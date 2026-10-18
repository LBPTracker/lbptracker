/**
 * FMOD FSB4 bank reader.
 *
 * Port of tools/fsb.py. The layout was derived from LBP3's own banks -- see
 * steering/game-assets.md for the measurements.
 *
 * ⚠️ FSB4 is LITTLE-endian. LBP's own serialised resources are big-endian
 * (../cwlib-ts/src/resource.ts). The two formats sit next to each other in this
 * project and reading one with the other's byte order is a mistake that
 * produces plausible-looking garbage rather than an error.
 *
 * Sample headers carry their own size and are WALKED, never indexed.
 */

/** Mode bits LBP3 actually sets. Bits never seen set are deliberately unnamed. */
export const MODE = {
  LOOP_NORMAL: 0x00000002,
  MONO: 0x00000020,
  STEREO: 0x00000040,
  MPEG: 0x00000200,
  TWO_D: 0x00002000,
  HW2D: 0x00080000,
  THREE_D: 0x00100000,
  IMAADPCM: 0x00400000,
} as const;

export type Codec = 'ima_adpcm' | 'mpeg' | 'unknown';

export interface FsbSample {
  readonly index: number;
  readonly name: string;
  /** Frames per channel. */
  readonly lengthSamples: number;
  /** Compressed size in bytes. */
  readonly lengthBytes: number;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly mode: number;
  readonly freq: number;
  readonly volume: number;
  readonly pan: number;
  readonly priority: number;
  readonly channels: number;
  /** Byte offset of this sample's data within the bank. */
  readonly dataOffset: number;
  readonly codec: Codec;
  readonly looping: boolean;
}

export interface FsbBank {
  readonly sampleCount: number;
  readonly version: number;
  readonly mode: number;
  readonly samples: readonly FsbSample[];
  /** The whole bank, so sample data can be sliced lazily. */
  readonly bytes: Uint8Array;
}

export class FsbFormatError extends Error {}

const FILE_HEADER_SIZE = 0x30;

function codecOf(mode: number): Codec {
  if (mode & MODE.IMAADPCM) return 'ima_adpcm';
  if (mode & MODE.MPEG) return 'mpeg';
  return 'unknown';
}

function nameAt(bytes: Uint8Array, at: number): string {
  let end = at;
  const limit = at + 30;
  while (end < limit && bytes[end] !== 0) end += 1;
  let name = '';
  for (let i = at; i < end; i += 1) name += String.fromCharCode(bytes[i]);
  return name;
}

/** Parse a bank's headers. Sample data is not touched until `sampleData` is called. */
export function readBank(bytes: Uint8Array): FsbBank {
  if (bytes.length < FILE_HEADER_SIZE) {
    throw new FsbFormatError(`too short to be an FSB4 bank: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[0] !== 0x46 || bytes[1] !== 0x53 || bytes[2] !== 0x42 || bytes[3] !== 0x34
  ) {
    throw new FsbFormatError(
      `not an FSB4 bank (magic ${nameAt(bytes, 0).slice(0, 4)})`,
    );
  }

  const sampleCount = view.getUint32(0x04, true);
  const headerSize = view.getUint32(0x08, true);
  const version = view.getUint32(0x10, true);
  const mode = view.getUint32(0x14, true);

  if (FILE_HEADER_SIZE + headerSize > bytes.length) {
    throw new FsbFormatError(
      `sample header block (${headerSize} bytes) runs past the end of the bank`,
    );
  }

  const dataAt = FILE_HEADER_SIZE + headerSize;
  const samples: FsbSample[] = [];
  let off = FILE_HEADER_SIZE;
  let cursor = 0;

  while (samples.length < sampleCount && off + 2 <= dataAt) {
    const size = view.getUint16(off, true);
    if (size === 0) break;

    const sampleMode = view.getUint32(off + 32 + 16, true);
    samples.push({
      index: samples.length,
      name: nameAt(bytes, off + 2),
      lengthSamples: view.getUint32(off + 32, true),
      lengthBytes: view.getUint32(off + 36, true),
      loopStart: view.getUint32(off + 40, true),
      loopEnd: view.getUint32(off + 44, true),
      mode: sampleMode,
      freq: view.getInt32(off + 52, true),
      volume: view.getUint16(off + 56, true),
      pan: view.getInt16(off + 58, true),
      priority: view.getUint16(off + 60, true),
      channels: view.getUint16(off + 62, true),
      dataOffset: dataAt + cursor,
      codec: codecOf(sampleMode),
      looping: (sampleMode & MODE.LOOP_NORMAL) !== 0,
    });
    cursor += samples[samples.length - 1].lengthBytes;
    off += size;
  }

  return { sampleCount, version, mode, samples, bytes };
}

/** The sample's raw, still-encoded bytes. */
export function sampleData(bank: FsbBank, sample: FsbSample): Uint8Array {
  const end = sample.dataOffset + sample.lengthBytes;
  if (end > bank.bytes.length) {
    throw new FsbFormatError(
      `sample "${sample.name}" data runs past the end of the bank`,
    );
  }
  return bank.bytes.subarray(sample.dataOffset, end);
}

/**
 * Find a sample by name, most specific match first.
 *
 * ⚠️ **Substring matching is a trap here and it has already bitten.** The bank
 * stores names with their `.wav` suffix, so looking up "piano_C4" misses the
 * exact match and falls through to a substring search -- where
 * **"epiano_C4.wav" contains "piano_C4"** and comes first in bank order. That
 * silently loaded the electric piano into the acoustic piano's key zone.
 *
 * Hence the order: exact, exact + ".wav", prefix, and only then substring.
 * A prefix match distinguishes piano from epiano; a substring match cannot.
 *
 * Names are truncated to 30 characters in the header, so a long name will not
 * match in full -- that is a property of the format, not a bug here.
 */
export function findSample(
  bank: FsbBank,
  query: string,
): FsbSample | undefined {
  const exact = bank.samples.find((s) => s.name === query);
  if (exact) return exact;

  const withWav = bank.samples.find((s) => s.name === `${query}.wav`);
  if (withWav) return withWav;

  const needle = query.toLowerCase();
  const prefix = bank.samples.find((s) => s.name.toLowerCase().startsWith(needle));
  if (prefix) return prefix;

  return bank.samples.find((s) => s.name.toLowerCase().includes(needle));
}

/** Decode the mode bits to names, keeping any unrecognised bits visible as hex. */
export function modeNames(mode: number): string {
  const known = Object.entries(MODE).filter(([, bit]) => mode & bit);
  const covered = Object.values(MODE).reduce((a, b) => a | b, 0);
  const rest = mode & ~covered;
  const parts = known.map(([name]) => name);
  if (rest) parts.push(`0x${(rest >>> 0).toString(16).padStart(8, '0')}`);
  return parts.join('|') || '0';
}
