/**
 * The archive's zips, read by byte range: where an entry is, how many entries
 * fit in one request, and how to cut them back out of the answer.
 *
 * ❗ **The whole download rests on three measured facts** about the dry23 zips
 * on archive.org (`dry23r<c0>/dry<c0c1>.zip`, 256 of them, about 4.7 GB each,
 * 61,743,686 entries in all — measured 2026-10-30):
 *
 * 1. every entry is **stored**, never deflated, and named `aa/bb/<sha1>`, so
 *    an entry's bytes are its resource and its offset is all a reader needs;
 * 2. the item's servers answer a `Range` header with **several intervals at
 *    once** (`multipart/byteranges`), 200 entries in 7.5 s against 0.57 s for
 *    one, which is what makes one request worth fifty;
 * 3. `view_archive.php`, the per-file route `lbparchive.ts` uses, costs a
 *    redirect and about 2 s a file; a range on the raw zip costs 0.7 s a
 *    request, however many entries ride in it.
 *
 * Nothing here touches the network, so `node --test` checks all of it.
 */

/** An entry's name inside a zip: `aa/bb/` and forty hex digits. */
export const NAME_LEN = 46;
/** A local file header's fixed part. */
export const LOCAL_HEADER = 30;
/**
 * What a range asks for past an entry's name before its data: the local
 * header's extra field, which the central directory does not give. 64 covers
 * a zip64 extra; anything longer is fetched again, exactly (`cut`).
 */
export const LOCAL_SLACK = 64;
/** Two ranges closer than this are asked for as one. */
export const MERGE_GAP = 4096;

/** One entry, as the central directory places it. */
export interface Entry {
  readonly sha1: string;
  /** The local header's offset in the zip. */
  readonly offset: number;
  readonly size: number;
}

/** The zip a resource is in: its SHA-1's first byte. */
export const zipOf = (sha1: string): string => sha1.slice(0, 2);

/** The zip's address on the item that holds it, given the item's server and directory. */
export const zipPath = (zip: string): { item: string; file: string } => ({
  item: `dry23r${zip[0]}`,
  file: `dry${zip}.zip`,
});

/**
 * Where the central directory is, out of the zip's last 64 KiB.
 *
 * ⚠️ **The zips are zip64**: the plain end record says `0xffffffff`, and the
 * real offset is in the zip64 end record (`PK\x06\x06`).
 */
export function centralDirectory(tail: Uint8Array): { offset: number; size: number } {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const find = (sig: number) => {
    for (let i = tail.length - 4; i >= 0; i--) if (view.getUint32(i, true) === sig) return i;
    return -1;
  };
  const z64 = find(0x06064b50);
  if (z64 >= 0) {
    return { size: Number(view.getBigUint64(z64 + 40, true)), offset: Number(view.getBigUint64(z64 + 48, true)) };
  }
  const end = find(0x06054b50);
  if (end < 0) throw new Error('no end of central directory in the last 64 KiB');
  return { size: view.getUint32(end + 12, true), offset: view.getUint32(end + 16, true) };
}

/** Every resource entry in a central directory; directories and anything unexpected are skipped. */
export function readCentralDirectory(cd: Uint8Array): Entry[] {
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const text = new TextDecoder('latin1');
  const out: Entry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && view.getUint32(p, true) === 0x02014b50) {
    const method = view.getUint16(p + 10, true);
    let size = view.getUint32(p + 20, true);
    let usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let offset = view.getUint32(p + 42, true);
    const name = text.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // The zip64 extra holds, in this order, whichever of the three said 0xffffffff.
    for (let q = p + 46 + nameLen, end = q + extraLen; q + 4 <= end;) {
      const id = view.getUint16(q, true);
      const len = view.getUint16(q + 2, true);
      if (id === 1) {
        let at = q + 4;
        const next = () => {
          const v = Number(view.getBigUint64(at, true));
          at += 8;
          return v;
        };
        if (usize === 0xffffffff) usize = next();
        if (size === 0xffffffff) size = next();
        if (offset === 0xffffffff) offset = next();
      }
      q += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (method === 0 && nameLen === NAME_LEN) out.push({ sha1: name.slice(6), offset, size });
  }
  return out;
}

/** One request: the entries it carries and the ranges, merged, that carry them. */
export interface Batch {
  readonly entries: readonly Entry[];
  readonly ranges: readonly (readonly [start: number, end: number])[];
}

/**
 * Entries of one zip in requests: at most `maxRanges` intervals and
 * `maxBytes` each, neighbours closer than `MERGE_GAP` merged into one interval.
 * `entries` must be sorted by offset.
 */
export function batches(entries: readonly Entry[], maxRanges: number, maxBytes: number): Batch[] {
  const out: Batch[] = [];
  let batch: Entry[] = [];
  let ranges: [number, number][] = [];
  let bytes = 0;
  for (const entry of entries) {
    const end = entry.offset + LOCAL_HEADER + NAME_LEN + LOCAL_SLACK + entry.size - 1;
    if (batch.length && (ranges.length >= maxRanges || bytes + (end - entry.offset) > maxBytes)) {
      out.push({ entries: batch, ranges });
      batch = [];
      ranges = [];
      bytes = 0;
    }
    const last = ranges[ranges.length - 1];
    if (last && entry.offset - last[1] <= MERGE_GAP) {
      bytes += Math.max(0, end - last[1]);
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([entry.offset, end]);
      bytes += end - entry.offset + 1;
    }
    batch.push(entry);
  }
  if (batch.length) out.push({ entries: batch, ranges });
  return out;
}

/** What a server sent back for some ranges: each part's first byte in the zip, and its bytes. */
export type Part = readonly [start: number, bytes: Uint8Array];

/** A `multipart/byteranges` body cut into its parts, by their `Content-Range` lengths. */
export function readMultipart(body: Uint8Array, boundary: string): Part[] {
  const text = new TextDecoder('latin1');
  // A Node tool: `Buffer.indexOf` is native, and a body runs to 32 MB.
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  const crlf2 = Buffer.from('\r\n\r\n', 'latin1');
  const indexOf = (needle: Buffer, from: number) => buf.indexOf(needle, from);
  const parts: Part[] = [];
  let at = indexOf(delim, 0);
  while (at >= 0) {
    at += delim.length;
    if (body[at] === 0x2d && body[at + 1] === 0x2d) break; // the closing "--"
    const headEnd = indexOf(crlf2, at);
    if (headEnd < 0) break;
    const head = text.decode(body.subarray(at, headEnd));
    const m = /content-range:\s*bytes (\d+)-(\d+)\//i.exec(head);
    if (!m) throw new Error('a multipart part without Content-Range');
    const start = Number(m[1]);
    const length = Number(m[2]) - start + 1;
    const dataAt = headEnd + 4;
    parts.push([start, body.subarray(dataAt, dataAt + length)]);
    at = indexOf(delim, dataAt + length);
  }
  return parts;
}

/**
 * An entry's bytes out of the parts that should hold it.
 *
 * Returns the data; or `{ refetch }`, the exact interval to ask for again,
 * when the local extra field ran past `LOCAL_SLACK`; or `undefined` when no
 * part holds the entry's header, which is the server answering something else.
 */
export function cut(parts: readonly Part[], entry: Entry): Uint8Array | { refetch: readonly [number, number] } | undefined {
  for (const [start, bytes] of parts) {
    const rel = entry.offset - start;
    if (rel < 0 || rel + LOCAL_HEADER > bytes.length) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(rel, true) !== 0x04034b50) return undefined;
    const nameLen = view.getUint16(rel + 26, true);
    const extraLen = view.getUint16(rel + 28, true);
    const data = rel + LOCAL_HEADER + nameLen + extraLen;
    if (data + entry.size <= bytes.length) return bytes.subarray(data, data + entry.size);
    const from = entry.offset + LOCAL_HEADER + nameLen + extraLen;
    return { refetch: [from, from + entry.size - 1] };
  }
  return undefined;
}
