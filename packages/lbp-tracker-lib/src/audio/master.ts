/**
 * A master bus: a glue compressor and a brickwall limiter, **ours, not the
 * game's**.
 *
 * ❗ **Nothing in LBP does this.** The sequencer's own output stage is the
 * plugin's hard clip, `SMS Reverb` and `SMS WaveHammer`, and all three are
 * modelled elsewhere (`compressor.ts`, `effects.ts`,
 * steering/lbp-audio-engine.md). This runs *after* all of that, past the
 * stereo fold, where nothing of the game's is left to be faithful to: it is
 * the last thing before the speakers and it exists because a composer asked
 * for a mix that holds together, not because the PS4 does it. ❗ The page's
 * default since 2026-10-12, the owner's choice once the game's own bus had
 * been re-read and heard beside it: a deliberate deviation, question 42 in
 * steering/open-questions.md. The library's default stays the game's.
 *
 * The two stages:
 *
 *   1. **Glue.** A peak detector on `max(|l|, |r|)` drives a soft-knee
 *      compressor at 2.5:1. `amount` moves the threshold from -6 dBFS down to
 *      -22 dBFS and adds the makeup that the ratio takes back out, so turning
 *      it up squeezes the mix rather than just making it quieter.
 *   2. **Limiter.** A lookahead peak limiter with a hard ceiling. The signal is
 *      delayed by the lookahead while the gain is computed on what is coming,
 *      so the gain is already down when the peak arrives and nothing is
 *      clipped flat.
 *
 * ⚠️ **The gain applied to a sample is the smallest the lookahead window asks
 * for, not the newest.** Taking the newest and letting it release upwards is
 * the obvious way to write this and it is wrong: the peak is still inside the
 * delay line while the gain climbs back, so it comes out over the ceiling --
 * measured at +0.19 dB before this was a sliding minimum. A monotonic deque
 * keeps that minimum in constant time.
 *
 * ⚠️ And the gain may only ever fall at once and rise slowly. A release that
 * also applies downwards turns every transient into a click.
 */

/** Decibels to a linear gain. */
const dbToGain = (db: number): number => 10 ** (db / 20);

export interface MasterSettings {
  /** 0..10, the UI's one knob: how much glue. 0 is the compressor bypassed. */
  readonly amount: number;
  /** The limiter's hard ceiling in dBFS. Nothing leaves above it. */
  readonly ceilingDb: number;
}

export const MASTER_DEFAULTS: MasterSettings = { amount: 4, ceilingDb: -0.3 };

/**
 * The glue's fixed shape: the knob moves the threshold, not these. Exported for
 * the Ableton export, which sets Live's Compressor to the same (`als-master.ts`).
 */
export const GLUE = { ratio: 2.5, kneeDb: 6, attackMs: 10, releaseMs: 150 } as const;
const RATIO = GLUE.ratio;
const KNEE_DB = GLUE.kneeDb;
/** How far the threshold travels across the knob's range. */
const THRESHOLD_TOP_DB = -6;
const THRESHOLD_SPAN_DB = 16;
/**
 * The level the makeup is worked out at.
 *
 * ⚠️ **Not 0 dBFS.** Taking back what the ratio removes *at full scale* assumes
 * the mix already peaks there; a real one does not, and the makeup then adds
 * more than the compressor took. Measured on `Ascetic` with the knob at 4:
 * against full scale the peaks went 0.52 to 0.97, +5.4 dB, with the limiter
 * holding the ceiling flat through the loud bars. -6 dBFS is where a mix that
 * has been through the game's own output stage actually sits.
 */
const MAKEUP_REFERENCE_DB = -6;
/** The limiter. 2 ms of lookahead is 96 frames at 48 kHz. */
export const LIMITER = { lookaheadMs: 2, releaseMs: 80 } as const;

/**
 * Where the knob puts the glue's threshold, and the makeup that goes with it.
 * The makeup takes back what the ratio removes from a signal at
 * `MAKEUP_REFERENCE_DB`, so turning the knob up squeezes the mix rather than
 * just making it quieter; at 0 there is none.
 */
export function glueLevels(amount: number): { thresholdDb: number; makeupDb: number } {
  const knob = Math.max(0, Math.min(10, amount));
  const thresholdDb = THRESHOLD_TOP_DB - (knob / 10) * THRESHOLD_SPAN_DB;
  const makeupDb = knob === 0 ? 0 : Math.max(0, MAKEUP_REFERENCE_DB - thresholdDb) * (1 - 1 / RATIO);
  return { thresholdDb, makeupDb };
}

/**
 * The brickwall half on its own: a lookahead peak limiter with a hard ceiling,
 * delaying the signal by `LIMITER.lookaheadMs`. `MasterBus` ends in one, and so
 * does the AGC after the game's bus (`agc.ts`). One frame in, and the frame
 * that went in `lookahead` frames ago out, in `left` and `right`.
 */
export class Limiter {
  /** The frame out of the last `process`. */
  left = 0;
  right = 0;
  private limitRelease = 0;
  /** The limiter's gain, which falls at once and recovers slowly. */
  private limitGain = 1;
  /** The last `lookahead` target gains, and a deque of their indices, smallest first. */
  private targets: Float32Array;
  private deque: Int32Array;
  private head = 0;
  private tail = 0;
  private frame = 0;
  private ceiling: number;
  /** The lookahead delay lines, and where the next sample goes. */
  private delayL: Float32Array;
  private delayR: Float32Array;
  private at = 0;
  private readonly lookahead: number;

  constructor(sampleRate: number, ceilingDb: number = MASTER_DEFAULTS.ceilingDb) {
    this.lookahead = Math.max(1, Math.round((LIMITER.lookaheadMs / 1000) * sampleRate));
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    // ⚠️ `lookahead + 1` entries, not `lookahead`: the window has to include the
    // frame that is leaving the delay line this very sample, or its own peak is
    // the one thing the minimum never sees.
    this.targets = new Float32Array(this.lookahead + 1);
    this.targets.fill(1);
    this.deque = new Int32Array(this.lookahead + 2);
    this.limitRelease = Math.exp(-1 / ((LIMITER.releaseMs / 1000) * sampleRate));
    this.ceiling = dbToGain(ceilingDb);
  }

  setCeiling(ceilingDb: number): void {
    this.ceiling = dbToGain(ceilingDb);
  }

  reset(): void {
    this.limitGain = 1;
    this.at = 0;
    this.frame = 0;
    this.head = 0;
    this.tail = 0;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.targets.fill(1);
    this.left = 0;
    this.right = 0;
  }

  /**
   * The smallest target gain in the lookahead window, kept in constant time.
   *
   * The deque holds frame numbers whose targets rise from front to back, so
   * the front is always the window's minimum: anything behind a smaller,
   * newer value can never be the answer again and is dropped as it arrives.
   */
  private windowMin(target: number): number {
    const size = this.lookahead + 1;
    const ring = this.deque.length;
    this.targets[this.frame % size] = target;
    while (this.tail > this.head
      && this.targets[this.deque[(this.tail - 1) % ring] % size] >= target) this.tail -= 1;
    this.deque[this.tail % ring] = this.frame;
    this.tail += 1;
    // Frames older than the window are behind the sample now leaving the delay.
    while (this.deque[this.head % ring] < this.frame - this.lookahead) this.head += 1;
    const min = this.targets[this.deque[this.head % ring] % size];
    this.frame += 1;
    return min;
  }

  /** One frame in; the frame `lookahead` frames old out, in `left` and `right`. */
  process(left: number, right: number): void {
    // --- into the delay, and out with what went in `lookahead` frames ago
    const outL = this.delayL[this.at];
    const outR = this.delayR[this.at];
    this.delayL[this.at] = left;
    this.delayR[this.at] = right;
    this.at = (this.at + 1) % this.lookahead;

    // --- the limiter, on the smallest gain the window asks for
    const ahead = Math.max(Math.abs(left), Math.abs(right));
    const need = this.windowMin(ahead > this.ceiling ? this.ceiling / ahead : 1);
    // ⚠️ Down at once, up slowly. See the note at the top of the file.
    this.limitGain = need < this.limitGain
      ? need
      : need + (this.limitGain - need) * this.limitRelease;

    this.left = outL * this.limitGain;
    this.right = outR * this.limitGain;
  }
}

export class MasterBus {
  private thresholdDb = THRESHOLD_TOP_DB;
  private makeup = 1;
  private attack = 0;
  private release = 0;
  /** The compressor's smoothed gain reduction, as a linear gain. */
  private env = 1;
  private readonly limiter: Limiter;

  constructor(sampleRate: number, settings: MasterSettings = MASTER_DEFAULTS) {
    this.limiter = new Limiter(sampleRate, settings.ceilingDb);
    this.attack = Math.exp(-1 / ((GLUE.attackMs / 1000) * sampleRate));
    this.release = Math.exp(-1 / ((GLUE.releaseMs / 1000) * sampleRate));
    this.set(settings);
  }

  set(settings: MasterSettings): void {
    const { thresholdDb, makeupDb } = glueLevels(settings.amount);
    this.thresholdDb = thresholdDb;
    this.makeup = dbToGain(makeupDb);
    this.limiter.setCeiling(settings.ceilingDb);
  }

  reset(): void {
    this.env = 1;
    this.limiter.reset();
  }

  /** The gain the compressor asks for at this input level, as a linear gain. */
  private compressorGain(peak: number): number {
    if (peak <= 0) return 1;
    const db = 20 * Math.log10(peak);
    const over = db - this.thresholdDb;
    if (over <= -KNEE_DB / 2) return 1;
    // A quadratic knee: the ratio comes in over KNEE_DB rather than at a corner.
    const reduction = over >= KNEE_DB / 2
      ? over - over / RATIO
      : ((1 - 1 / RATIO) * (over + KNEE_DB / 2) ** 2) / (2 * KNEE_DB);
    return dbToGain(-reduction);
  }

  /**
   * One frame in, one frame out -- **delayed by the lookahead**, which is what
   * lets the limiter see a peak before it plays it.
   */
  process(left: number, right: number): { left: number; right: number } {
    // --- the glue, on the signal as it arrives
    const peak = Math.max(Math.abs(left), Math.abs(right));
    const want = this.compressorGain(peak);
    // Falling gain uses the attack, rising uses the release: a compressor
    // clamps down quickly and lets go slowly, not the other way about.
    const coeff = want < this.env ? this.attack : this.release;
    this.env = want + (this.env - want) * coeff;
    const glueL = left * this.env * this.makeup;
    const glueR = right * this.env * this.makeup;
    this.limiter.process(glueL, glueR);
    return { left: this.limiter.left, right: this.limiter.right };
  }
}
