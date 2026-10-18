/**
 * Opening a level out of the Internet Archive, by its root level's hash.
 *
 * The Mm servers were shut down in 2021 and the levels survive as an archive of
 * the official server's resource store (`archive.org/details/@tamiya99`),
 * indexed by Zaprit's LBP Search Facility, <https://zaprit.fish>. A listener
 * with no PS3 backup of their own finds a level there, copies the 40 hex digits
 * its page shows, and pastes them here.
 *
 * ❗ **This is deliberately the hash and nothing else.** The page briefly had a
 * search box that read the index through the dev server, because zaprit.fish
 * sends no CORS headers and a browser cannot ask it directly. That worked and
 * was removed: it made a listener's search go through a server that otherwise
 * only serves files, and it stopped working the moment the tracker was opened
 * anywhere but a dev machine. What is left needs no server at all.
 *
 * ✔ **Measured, 2026-09-05.** `archive.org` answers a level request from any
 * origin -- `view_archive.php` echoes whatever `Origin` is sent, verified from
 * `https://example.github.io` -- and `rootLevelUrl` below is a pure function of
 * the hash, so nothing has to be asked of anyone before the download. The
 * measurements that closed the other routes, including why the archive's own
 * 2.65 GB SQLite index cannot be read from a page, are in *The public archive*
 * in `../cwlib-ts/steering/lbp-modding-toolchain.md`.
 */

/** Where a listener finds a level and its hash. */
export const SEARCH_HOST = 'https://zaprit.fish';

/**
 * Where a root level's bytes are in the Internet Archive.
 *
 * ❗ **A pure function of the hash**, which is why the page can build it without
 * asking anyone. Reproduced from `SlotHandler` in LBPSearch's `handlers.go`:
 * the dump is sharded into `dry23r<first hex digit>` items holding
 * `dry<first two>.zip`, and inside the zip the file is at `aa/bb/<sha1>`.
 */
export function rootLevelUrl(sha1: string): string {
  const h = sha1.toLowerCase();
  const inZip = `${h.slice(0, 2)}%2F${h.slice(2, 4)}%2F${h}`;
  return `https://archive.org/download/dry23r${h[0]}/dry${h.slice(0, 2)}.zip/${inZip}`;
}

/**
 * What a listener pasted: a hash, a level's page, or something else.
 *
 * A level link is recognised only so the box can say what to do with it. It
 * cannot be followed: the hash lives on that page, the page has no CORS headers,
 * and following it is exactly the server round trip this box no longer makes.
 */
export type Pasted =
  | { readonly kind: 'hash'; readonly sha1: string }
  | { readonly kind: 'link'; readonly id: number }
  | { readonly kind: 'neither' };

export function readPaste(text: string): Pasted {
  const trimmed = text.trim();
  // ⚠️ **The hash is what the text ENDS with, not a run found inside it.** A
  // word boundary cannot find one in `…eb%2F8febe1f9…`: the character before it
  // is the `F` of `%2F`, itself a hex digit, so `\b` fails there and a
  // backtracking match lands on a 40-digit window that is off by two. Taking the
  // last segment handles the bare hash and a pasted archive.org URL alike.
  const tail = trimmed.split(/[/\?#=]|%2F/i).pop() ?? '';
  if (/^[0-9a-f]{40}$/i.test(tail)) return { kind: 'hash', sha1: tail.toLowerCase() };
  const link = /\/slot\/(\d+)/.exec(trimmed);
  if (link) return { kind: 'link', id: Number(link[1]) };
  return { kind: 'neither' };
}
