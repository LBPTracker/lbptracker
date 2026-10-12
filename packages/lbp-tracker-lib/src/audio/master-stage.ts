/**
 * The end of the chain: **the game's master bus, or ours.**
 *
 * Everything before this is the sequencer's own plugin and `SMS Reverb`, which
 * `render.ts` offline and `mixer-worklet.ts` live each run frame for frame the
 * same way. What follows the reverb is a choice, and it is made here, once, so
 * the two paths cannot disagree about it.
 *
 * ## `'game'`: the game's
 *
 * What the sequencer's channel goes through after the reverb, and nothing else
 * (*The sequencer's chain* and *The output stage* in
 * steering/lbp-audio-engine.md):
 *
 *   1. **`SMS WaveHammer`** at the settings the game ships: −18 dB, 10:1, the
 *      limiter bypassed (`compressor.ts`, `WAVEHAMMER_SHIPPED`). `Channel::addDSP`
 *      put it after the reverb (eboot `v0x3e6976`), so it hears the sum.
 *   2. **The channel at unity.** `DSP::setDefaults` gives the sequencer's
 *      channel a volume of 1.0 (the `vmovss` at `v0x3e66e6` loads it from
 *      `v0xe7d544`), and every play sets it to 1.0 again (`v0x3e6d41`); only
 *      a fade-out moves it (`v0x3eb0a1`). The output driver sets all eight
 *      speakers to 0 dB (`v0xa577a0`).
 *   3. **FMOD's 7.1 speaker matrix as a stereo listener hears it**: the game
 *      sets 7.1 itself (`System::setSpeakerMode(6)`, eboot `v0x3e76d8`), the
 *      centre carries the pair's average at `k = 0.5` (`v0xa2599f`), and the
 *      stereo downmix folds it back into both fronts at `1/sqrt2` — the fold's
 *      gain *and* its narrowing, one linear operator (`FOLD_CENTRE` in
 *      `effects.ts`). The LFE, which FMOD also feeds the pair's average, is
 *      dropped. ⚠️ That downmix is the platform's, not the game's: these are
 *      shadPS4's coefficients (`0.7071f`, LFE unread), which the captures
 *      confirm; a real PS4's are unread.
 *
 * ## `'agc'`: the game's, then an automatic gain control
 *
 * The game's bus, then `agc.ts`: one gain ridden slowly towards −16 LUFS, and
 * our limiter after it, because the game's own level is low -- −20 to −22
 * LUFS over four whole songs, 5 to 7 LU under ours (*63* in
 * steering/open-questions.md). Causal, so it runs here in real time for the
 * render and the worklet alike, and needs nothing measured in advance. Not the
 * game's: the gain moves, slowly, and the limiter shaves what it lifts past
 * the ceiling.
 *
 * ## A `MasterSettings`: ours
 *
 * The fold's gain alone, which keeps the file's own image, no WaveHammer, and
 * then `master.ts`'s glue and limiter. ❗ Not the game's, and the page's
 * default since 2026-10-12: question 42 in steering/open-questions.md.
 *
 * ## `'none'`
 *
 * The fold's gain alone and nothing after it: what this tracker played by
 * default until 0.2.43, kept because the listening decisions in
 * steering/open-questions.md were judged against it.
 */

import { WAVEHAMMER_SHIPPED, WaveHammer } from './compressor.ts';
import { FOLD_CENTRE, FOLD_GAIN } from './effects.ts';
import { Agc } from './agc.ts';
import { MasterBus, type MasterSettings } from './master.ts';

/** Which master bus ends the chain. See the top of this file. */
export type MasterChoice = 'game' | 'agc' | 'none' | MasterSettings;

export class MasterStage {
  private readonly rate: number;
  /** Set exactly when the game's bus is chosen. */
  private hammer: WaveHammer | null = null;
  /** Set exactly when ours is chosen. */
  private ours: MasterBus | null = null;
  /** The AGC after the game's bus: set exactly when `'agc'` is chosen. */
  private agc: Agc | null = null;
  /** The last AGC, kept while another bus plays so picking it again resumes it. */
  private agcKept: Agc | null = null;
  /** The deepest gain `SMS WaveHammer` has applied, or 1 when it has not run. */
  deepest = 1;

  constructor(sampleRate: number, choice: MasterChoice = 'game') {
    this.rate = sampleRate;
    this.set(choice);
  }

  /** The gain the AGC applied last, before its limiter, or null when it is not chosen. */
  get agcGain(): number | null {
    return this.agc ? this.agc.gain : null;
  }

  /**
   * Choose again.
   *
   * ⚠️ **A choice of the same kind keeps its state.** The live page re-sends
   * the whole output stage whenever the tempo moves (the echo is in beats), and
   * a WaveHammer rebuilt there would drop its envelope back to unity in the
   * middle of the song. Only a change of kind builds anything, so this may
   * allocate: call it from a message handler, never from `process`. The game's
   * and `'agc'` are one kind: the same WaveHammer runs on, and the AGC is kept
   * aside while the game's plays alone.
   */
  set(choice: MasterChoice): void {
    if (choice === 'agc') this.agcKept ??= new Agc(this.rate);
    this.agc = choice === 'agc' ? this.agcKept : null;
    if (choice === 'game' || choice === 'agc') {
      this.hammer ??= new WaveHammer(WAVEHAMMER_SHIPPED, this.rate);
      this.ours = null;
    } else if (choice === 'none') {
      this.hammer = null;
      this.ours = null;
    } else {
      this.hammer = null;
      if (this.ours) this.ours.set(choice);
      else this.ours = new MasterBus(this.rate, choice);
    }
  }

  /**
   * Frames `[from, to)` of a stereo pair through the bus, in place.
   *
   * Each frame is read whole before either channel is written, so this is also
   * right when `left` and `right` are the same array -- a mono output, where
   * multiplying "both" channels in turn would apply every gain twice.
   */
  run(left: Float32Array, right: Float32Array, from = 0, to = left.length): void {
    const hammer = this.hammer;
    if (hammer) {
      const agc = this.agc;
      for (let i = from; i < to; i += 1) {
        // ⚠️ One gain for both channels: the WaveHammer is stereo-linked, its
        // detector taking the louder of the two (`0x1000`).
        const g = hammer.gainFor(left[i], right[i]);
        if (g < this.deepest) this.deepest = g;
        const l = left[i] * g;
        const r = right[i] * g;
        const centre = FOLD_CENTRE * (l + r);
        if (agc) {
          // Ours, and last: past the fold, where the game's chain has ended.
          agc.process(l + centre, r + centre);
          left[i] = agc.left;
          right[i] = agc.right;
        } else {
          left[i] = l + centre;
          right[i] = r + centre;
        }
      }
      return;
    }
    const ours = this.ours;
    for (let i = from; i < to; i += 1) {
      const l = left[i] * FOLD_GAIN;
      const r = right[i] * FOLD_GAIN;
      if (ours) {
        // Ours, and last: past the fold, where the game's chain has ended.
        const out = ours.process(l, r);
        left[i] = out.left;
        right[i] = out.right;
      } else {
        left[i] = l;
        right[i] = r;
      }
    }
  }
}
