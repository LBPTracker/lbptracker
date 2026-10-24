/**
 * The one loader: what is on screen while a level is being opened.
 *
 * ❗ **Opening a level is seconds long and none of it used to be visible.** The
 * archive panel says "fetching 8febe1f9…" and "12 of 30 resources…" into its
 * own note, and the drop zone says "reading …" into its title -- but both live
 * inside `#fileDialog`, and the two routes that need the message most, a
 * `?level=` link and a drop straight onto the home screen, never open that
 * dialog. A level would arrive after ten silent seconds.
 *
 * ⚠️ **It is a modal `<dialog>`, and that is the point, not decoration.** The
 * file dialog is itself modal, so it sits in the browser's top layer and an
 * ordinary `<div>` overlay -- whatever its `z-index` -- renders *underneath*
 * it. A second `showModal()` stacks above the first, which is the only way a
 * message can be seen over an open picker.
 *
 * ❗ **The percentage is the steps' expected times, filled by what each step can
 * measure.** A job declares its steps with the seconds each usually takes
 * (`plan`); the bar is the share of that time already behind it. A step that
 * can count -- bytes of a download, resources of a walk, instruments loaded,
 * notes planned -- says how far it is (`progress`); one that cannot creeps
 * towards its end on the clock and never reaches it, so the bar neither stalls
 * nor lies by finishing early. The number never goes backwards.
 *
 * Jobs nest: the archive fetch starts one, and the read of what it brought back
 * starts another inside it (`openLevel` in `daw.ts`). ❗ **A job started inside
 * another fills the step its parent is in**, so the archive's "open" step is
 * exactly the read and the plan that follow, and the bar runs once from 0 to
 * 100 across both. The newest job's title and line are the ones shown, and the
 * loader goes away when the last one is done, so neither caller has to know
 * about the other.
 */

/** One stage of a job, and how long it usually takes: its share of the bar. */
export interface LoadingStep {
  readonly key: string;
  readonly seconds: number;
}

/** One thing being waited for. `done()` is safe to call twice. */
export interface LoadingJob {
  /** The stages ahead, in order. Called again, it keeps the step it is in. */
  plan(steps: readonly LoadingStep[]): void;
  /** Enter a stage of the plan, with the line that says what it is doing. */
  step(key: string, text: string): void;
  /** How far into the current stage, 0..1, or `null` for "cannot tell"; and a new line. */
  progress(fraction: number | null, text?: string): void;
  /** The line under the title: what is going on, counts, whatever is known. */
  note(text: string): void;
  done(): void;
}

interface Job {
  title: string;
  note: string;
  steps: LoadingStep[];
  at: number;
  /** Measured progress in the current step, or `null` to creep on the clock. */
  inner: number | null;
  enteredAt: number;
  parent?: { job: Job; at: number };
}

const jobs: Job[] = [];
let host: HTMLDialogElement | null = null;
let titleEl: HTMLElement;
let noteEl: HTMLElement;
let barEl: HTMLElement;
let pctEl: HTMLElement;
let meterEl: HTMLElement;
/** The highest share shown since the loader opened: the bar never goes back. */
let shown = 0;
let ticker = 0;

function mount(): HTMLDialogElement {
  if (host) return host;
  host = document.createElement('dialog');
  host.className = 'loading-dialog';
  host.setAttribute('aria-labelledby', 'loading-title');
  host.innerHTML = '<div class="loading-box">'
    + '<div class="loading-head">'
    + '<div class="spinner" aria-hidden="true"></div>'
    + '<strong class="loading-title" id="loading-title"></strong>'
    + '<span class="loading-pct"></span>'
    + '</div>'
    + '<div class="loading-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100">'
    + '<div class="loading-bar"></div></div>'
    + '<span class="loading-note" aria-live="polite"></span>'
    + '</div>';
  // ⚠️ A modal dialog closes on Escape, and this one has no business
  // disappearing: it is not a choice, and the work carries on either way.
  host.addEventListener('cancel', (event) => event.preventDefault());
  titleEl = host.querySelector('.loading-title')!;
  noteEl = host.querySelector('.loading-note')!;
  barEl = host.querySelector('.loading-bar')!;
  pctEl = host.querySelector('.loading-pct')!;
  meterEl = host.querySelector('.loading-meter')!;
  document.body.append(host);
  return host;
}

/**
 * How far a step without a count has got, from how long it has run: towards
 * 95% of itself, about 80% at its expected time, never all of it.
 */
const creep = (ms: number, seconds: number): number =>
  0.95 * (1 - Math.exp((-2 * ms) / 1000 / Math.max(0.05, seconds)));

/** A job's share done, 0..1, its newest child filling the step it is in. */
function shareOf(job: Job, now: number): number {
  const steps = job.steps.length > 0 ? job.steps : [{ key: '', seconds: 1 }];
  const at = Math.min(job.at, steps.length - 1);
  const total = steps.reduce((sum, s) => sum + s.seconds, 0);
  const before = steps.slice(0, at).reduce((sum, s) => sum + s.seconds, 0);
  const child = jobs.findLast((j) => j.parent?.job === job && j.parent.at === job.at);
  const inner = child
    ? shareOf(child, now)
    : job.inner ?? creep(now - job.enteredAt, steps[at].seconds);
  return (before + steps[at].seconds * Math.min(1, Math.max(0, inner))) / Math.max(1e-9, total);
}

function draw(): void {
  const top = jobs[jobs.length - 1];
  const el = mount();
  if (!top) {
    if (el.open) el.close();
    window.clearInterval(ticker);
    ticker = 0;
    shown = 0;
    return;
  }
  // The outermost job is the whole of the wait; the newest says what is happening now.
  const root = jobs.find((j) => !j.parent) ?? jobs[0];
  shown = Math.max(shown, shareOf(root, performance.now()));
  const pct = Math.floor(shown * 100);
  titleEl.textContent = top.title;
  noteEl.textContent = top.note;
  pctEl.textContent = `${pct}%`;
  barEl.style.width = `${(shown * 100).toFixed(1)}%`;
  meterEl.setAttribute('aria-valuenow', String(pct));
  // `showModal` throws on a dialog that is already open, and this is called on
  // every progress line.
  if (!el.open) el.showModal();
  // The clock keeps a step with nothing to count moving.
  if (!ticker) ticker = window.setInterval(draw, 120);
}

/** Show the loader for as long as one piece of work runs. */
export function loading(title: string, note = ''): LoadingJob {
  const top = jobs[jobs.length - 1];
  const job: Job = {
    title,
    note,
    steps: [],
    at: 0,
    inner: null,
    enteredAt: performance.now(),
    parent: top ? { job: top, at: top.at } : undefined,
  };
  jobs.push(job);
  draw();
  return {
    plan: (steps) => {
      const key = job.steps[job.at]?.key;
      job.steps = [...steps];
      const at = job.steps.findIndex((s) => s.key === key);
      job.at = Math.max(0, at);
      draw();
    },
    step: (key, text) => {
      const at = job.steps.findIndex((s) => s.key === key);
      if (at >= 0 && at !== job.at) {
        job.at = at;
        job.inner = null;
        job.enteredAt = performance.now();
      }
      job.note = text;
      draw();
    },
    progress: (fraction, text) => {
      job.inner = fraction;
      if (text !== undefined) job.note = text;
      draw();
    },
    note: (text: string) => {
      job.note = text;
      draw();
    },
    done: () => {
      const at = jobs.indexOf(job);
      if (at >= 0) jobs.splice(at, 1);
      draw();
    },
  };
}

/**
 * Let the page paint before a stretch of work that will not yield.
 *
 * ⚠️ **An `await` on work that is all on this thread paints nothing**: reading a
 * level and the voice pass are seconds of script with no task boundary, so the
 * loader would show the step before them for all of it. A frame and then a
 * task lets the line and the bar reach the screen first. The timeout is for a
 * hidden page, where `requestAnimationFrame` does not run.
 */
export function paint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => window.setTimeout(resolve, 0));
    window.setTimeout(resolve, 100);
  });
}

/** Bytes as a reader says them: `640 KB`, `1.2 MB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * A response's body, reporting the bytes as they arrive.
 *
 * `total` is `Content-Length` when the server sent one, which is readable from
 * another origin because it is a CORS-safelisted header; a compressed body can
 * overrun it, so a caller clamps.
 */
export async function bodyBytes(
  answer: Response,
  onBytes: (got: number, total: number | undefined) => void,
): Promise<Uint8Array> {
  const length = Number(answer.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  if (!answer.body) return new Uint8Array(await answer.arrayBuffer());
  const reader = answer.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  onBytes(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
