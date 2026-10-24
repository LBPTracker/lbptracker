/**
 * The song back into the game: a `.plan` file the LBP3 popit can hold.
 *
 * The writing is `@lbptracker/cwlib/sequencer/write-plan.ts`, which is where the Thing
 * graph and every measured constant live. This is the control around it: which
 * build to write for, the button, and the tally that says what came out.
 *
 * ❗ **The tally is what the file is checked by, before anybody launches a
 * game.** A plan is opaque -- there is no way to look at one and see whether it
 * will load -- so the two facts that decide it are put on screen: the revision
 * it claims to be, and its dependency table. Every entry being a **GUID** is
 * what makes the file self-contained; one hash in there would mean a resource
 * that has to travel beside it, and the file would arrive in the game with a
 * hole in it.
 *
 * ⚠️ **The build is not cosmetic.** LBP3's PS3 and PS4 releases write the same
 * `version` and different `subVersion`s, and a game reads its own. Getting it
 * wrong is a file that will not open rather than one that sounds wrong.
 */

import { writeMod } from '@lbptracker/cwlib/archives/mod.ts';
import { readDependencies } from '@lbptracker/cwlib/io/resource.ts';
import { LBP3_PS3, LBP3_PS4, writeSequencerPlan } from '@lbptracker/cwlib/sequencer/write-plan.ts';
import { webDeflate } from '@lbptracker/cwlib/platform/web.ts';

import { download } from '../song-file.ts';
import { currentSequencer, setStatus, state } from './session.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The builds a plan can be written for, and what to call them on screen. */
const BUILDS = [
  { value: 'ps3', label: 'PS3 (also RPCS3)', revision: LBP3_PS3 },
  { value: 'ps4', label: 'PS4 / PS5', revision: LBP3_PS4 },
] as const;

/** A file name for a plan: the song's name, made safe, plus the suffix. */
export function planFileName(name: string): string {
  return `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'song'}.plan`;
}

export function mountPlanExport(opts: {
  isActive: () => boolean;
  onShow: (listener: () => void) => void;
  log: (text: string, bad?: boolean) => void;
}): void {
  const button = $<HTMLButtonElement>('cv-planSave');
  const modButton = $<HTMLButtonElement>('cv-modSave');
  const build = $<HTMLSelectElement>('cv-planBuild');
  const summary = $<HTMLDivElement>('cv-planSummary');

  build.innerHTML = BUILDS
    .map((b) => `<option value="${b.value}">${b.label}</option>`)
    .join('');

  let bytes: Uint8Array | undefined;
  let fileName = 'song.plan';
  let title = 'song';
  let author = '';

  async function build_(): Promise<void> {
    const revision = (BUILDS.find((b) => b.value === build.value) ?? BUILDS[0]).revision;
    const sequencer = currentSequencer();
    try {
      bytes = await writeSequencerPlan(sequencer, webDeflate, { revision });
    } catch (error) {
      bytes = undefined;
      button.disabled = true;
      modButton.disabled = true;
      summary.innerHTML = `<span class="bad">${
        error instanceof Error ? error.message : String(error)}</span>`;
      return;
    }
    fileName = planFileName(sequencer.name);
    title = sequencer.name;
    author = sequencer.author ?? '';
    const dependencies = readDependencies(bytes);
    const hashes = dependencies.filter((d) => d.kind === 'sha1').length;
    const instruments = new Set(sequencer.tracks.map((t) => t.guid)).size;
    summary.innerHTML = [
      row('revision', `0x${revision.version.toString(16)} · sub 0x${revision.subVersion.toString(16)}`),
      row('chips', `${sequencer.tracks.length} · ${instruments} instrument${instruments === 1 ? '' : 's'}`),
      row('dependencies', `${dependencies.length}, ${
        hashes === 0 ? 'all GUIDs — nothing to ship beside it' : `${hashes} hashed`}`),
      row('size', `${(bytes.length / 1024).toFixed(1)} kB`),
    ].join('');
    button.disabled = false;
    modButton.disabled = false;
  }

  const row = (label: string, value: string) =>
    `<div class="row"><span class="hintline" style="min-width:8rem;margin:0">${label}</span><span>${value}</span></div>`;

  button.addEventListener('click', () => {
    if (!bytes) return;
    download(fileName, bytes, 'application/octet-stream');
    opts.log(`saved ${fileName}, ${(bytes.length / 1024).toFixed(1)} kB`);
    setStatus(`saved ${fileName}`);
  });

  // ❗ The same bytes as the .plan, wrapped the way ennuo's toolkit installs
  // things: the FileDB row gives the plan a path and a GUID out of the range no
  // game uses, and nothing else is in there because a sequencer plan depends on
  // nothing but GUIDs the game already has.
  modButton.addEventListener('click', () => {
    if (!bytes) return;
    const stem = fileName.replace(/.plan$/, '');
    void writeMod({
      ID: stem.toLowerCase(),
      title,
      ...(author ? { author } : {}),
      description: 'A music sequencer exported from LBP Tracker.',
    }, [{ path: `plans/lbptracker/${fileName}`, bytes }]).then((mod) => {
      download(`${stem}.mod`, mod, 'application/octet-stream');
      opts.log(`saved ${stem}.mod, ${(mod.length / 1024).toFixed(1)} kB`);
      setStatus(`saved ${stem}.mod`);
    });
  });

  build.addEventListener('change', () => void build_());
  // The song changed while the view is up: rebuild, but not on every pixel of a drag.
  let timer = 0;
  state.onChange(() => {
    if (!opts.isActive()) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void build_(), 250);
  });
  opts.onShow(() => void build_());
}
