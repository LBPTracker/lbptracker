/**
 * `SMS WaveHammer` — the compressor the game's chain ends in.
 *
 * The last of three DSPs on the sequencer's channel:
 * `Sequencer → SMS Reverb → SMS WaveHammer → the mixer`. `Channel::addDSP` is
 * called at eboot `v0x3e67f9` and `v0x3e6976`, and it inserts at the head, so
 * the last one added sits closest to the output.
 *
 * ✔ **Every constant here is measured, and the model is checked against the
 * module actually running.** `tools/runhammer.py` loads `fmodsmswavehammer.prx`
 * into a process and executes it; `tools/wavehammer.py` is the same arithmetic
 * in Python; the two agree to 1e-4 dB over a DC sweep from −40 to −0.9 dBFS, and
 * `packages/lbp-tracker-lib/test/compressor.test.ts` pins this file against vectors taken from the
 * harness. See *The end of the chain* in `steering/lbp-audio-engine.md`.
 *
 * ❗ **The name is a trap and this project fell into it three times.** Wave
 * Hammer is a compressor *and* a limiter; the game ships `LimitBypass = 1`, so
 * the limiter never runs. The three wrong readings — "it is a limiter", "the
 * game never configures it", "it collapses to a constant −18 dB" — are tabulated
 * in *37* in `steering/answered-questions.md`. The last one survived a
 * disassembly of every byte of the module and died the moment it was run.
 *
 * ## What it does, per sample
 *
 * 1. **Detector** (`0xa40` `0x1000`): a 64-sample sliding sum of squares per
 *    channel, kept incrementally against a ring, then `max` across the two.
 * 2. **Lookup** (`0x10f0`): divide by the window to get a mean square, then
 *    index a 4000-entry gain table spanning `[F, 1]` with linear interpolation.
 *    `F` is the knee bottom as a power ratio, so `x ≤ F` short-circuits to unity.
 * 3. **Envelope** (`0x1190`): a one-pole on the *gain* — the attack coefficient
 *    when the gain falls, release when it rises — then a second one-pole whose
 *    output is `s_prev + s_new`.
 * 4. **Apply** (`0x330`): `out = in · gain`, the same gain on both channels, so
 *    the compressor is stereo-linked.
 *
 * ⚠️ The engine runs this per 256-frame block and shares one ring index between
 * the two channels rather than keeping one each. That is only harmless because
 * `256 % 64 == 0` returns the index to where the other channel started; it is
 * equivalent to the per-channel rings below, and stops being equivalent if the
 * block size ever changes — which the read callback refuses to let happen.
 *
 * ❗ **All of it is float32, in the module's order, and has to be.** Every
 * `Math.fround` below is a `vmulss`, `vaddss`, `vsubss` or `vdivss` in the
 * module, and so are the ones that build its constants. Run in double, the
 * running sum of squares does not drift the way the module's does and the
 * envelope does not stall where the module's stalls; in float32 the stage is
 * bit-exact against the module on six songs except where the console's own
 * `powf` and `log10f` round a table entry differently (*And it was run* in
 * `steering/lbp-audio-engine.md`).
 */

const f = Math.fround;

/**
 * `v0x1b08` and `v0x1bac`, the factor that turns tenths of a dB into a power of
 * ten: 0x3ba3d70b, which is one ulp **above** `fround(0.005)`. The threshold and
 * the output gain both go through it.
 */
const TENTHS_TO_EXPONENT = 0.005000000353902578;

/**
 * The module's `powf` and `log10f` (`_FLog(1, ·)`), as the float nearest the
 * double result. ⚠️ The console's libc does not always round that way, and that
 * is the one thing this file does not reproduce: see `waveHammerTable`.
 */
const powf = (x: number, y: number): number => f(x ** y);
const log10f = (x: number): number => f(Math.log10(x));

/** How `SMS WaveHammer` is configured, in the plugin's own units. */
export interface WaveHammerParams {
  /** `CompThresh`, dB. The game ships −18. */
  readonly thresholdDb: number;
  /** `CompRatio`. The game ships 10. ⚠️ 50 and above is a hard limiter, not a steep ratio. */
  readonly ratio: number;
  /** `CompOutGain`, in **tenths** of a dB. The game ships −180. */
  readonly outGainTenths: number;
  /** `CompAttack`, ms. The game ships 10. */
  readonly attackMs: number;
  /** `CompRel`, ms. The game ships 250. */
  readonly releaseMs: number;
  /** `CompCoeffSet`, which picks the second smoother's pair. The game ships it set. */
  readonly coeffSet: boolean;
  /** `CompLongLook`, which doubles the detector's window to 128. The game ships it clear. */
  readonly longLook: boolean;
}

/**
 * The game's own settings, from the 0x44-byte template the create callback
 * copies over the plugin's parameter block (eboot `v0x1062850`, `rep movsd` at
 * `v0x3fd8cb`). It overrides eight of the sixteen declared defaults.
 *
 * ⚠️ The game never calls `DSP::setParameter` on this handle — all fifteen call
 * sites in the binary were enumerated (`tools/ebxref.py calls 0xa23970`) and
 * none of them is this DSP. That fact was once read as "the game does not
 * configure it", which is why the template took a session to find.
 */
export const WAVEHAMMER_SHIPPED: WaveHammerParams = {
  thresholdDb: -18,
  ratio: 10,
  outGainTenths: -180,
  attackMs: 10,
  releaseMs: 250,
  coeffSet: true,
  longLook: false,
};

/**
 * `0x6c8`–`0x733`: a one-pole coefficient as `0.1^(1/x)` with
 * `x = round(rate · ms · 1e-4)/8 − 3`, and zero when that is not positive.
 *
 * ⚠️ The `1e-4` is not a milliseconds-to-seconds conversion and the `/8` is not
 * a block size. Together they turn 10 ms at 48 kHz into `x = 3` and 250 ms into
 * `x = 147`, whose coefficients are exactly what the running module reports at
 * `[state+0xf8]` and `[state+0xfc]`. Neither factor is explained here; both are
 * measured, and the two agreements are what say the formula is read right.
 * ⚠️ In float32: `powf(0.1f, 1/3f)` is one ulp under the float nearest
 * `0.1^(1/3)`, and the module's attack is that one.
 */
export function waveHammerCoefficient(ms: number, sampleRate: number): number {
  const n = Math.trunc(f(f(sampleRate * f(ms * f(1e-4))) + 0.5));
  const x = f(f(n * 0.125) - 3);
  return x > 0 ? powf(f(0.1), f(1 / x)) : 0;
}

/**
 * The 4000-entry gain table `0xb78`–`0xd3e` builds, over the axis `[floor, 1]`
 * in mean-square level.
 *
 * The knee is the unique cubic Hermite matching value *and* slope at both ends —
 * unity gain at `T−3`, slope `1/R` at `T+3` — which is why `P(1) = 1`,
 * `K·A/6 = 1` and `K·B/6 = 1/R` hold identically in `R`. The whole table
 * therefore reduces to `gain_dB = −3(1−r)t²` for `t ≤ 1` and `3(1−2t)(1−r)`
 * above, with `t = (L − T + 3)/6`; `tools/wavehammer.py check` agrees that
 * closed form with a literal transcription of the assembly to 2.1e-14 dB.
 *
 * Built here as the module builds it: in float32, operation for operation, from
 * the template's tenths. ⚠️ Except for `powf` and `log10f`: with the console's
 * own, this order reproduces every entry the module builds; with ours, a few
 * hundred entries come out a few ulps apart (*And it was run* in
 * `steering/lbp-audio-engine.md`).
 *
 * ⚠️ `ratio ≥ 50` is **not** the same curve with a small `1/R`: `0xbc9` masks
 * the reciprocal to zero and `0xcb6` takes `out = T` outright.
 */
export function waveHammerTable(
  thresholdDb: number,
  ratio: number,
  floor: number,
): Float32Array {
  const ratioTenths = Math.round(ratio * 10);
  const t = f(Math.round(thresholdDb * 10) * f(0.1));
  const big = f(ratioTenths * f(0.1)) >= 50;
  const invR = f(10 / ratioTenths);
  const kneeTop = f(t + 3);
  const kneeBottom = f(t - 3);
  const k = big ? 3 : f(f(invR * 3) + 3);
  const a = f(6 / k);
  const b = big ? 0 : f(invR * a);
  const c3 = f(f(a + b) - 2);
  const c2 = f(f(f(a * -2) + 3) - b);
  const step = f(1 / 3999);
  const span = f(1 - floor);
  const out = new Float32Array(4000);
  for (let i = 0; i < 4000; i += 1) {
    const x = f(floor + f(span * f(i * step)));
    const level = f(log10f(x) * 10);
    let target: number;
    if (level > kneeTop) {
      target = big ? t : f(t + f(invR * f(level - t)));
    } else {
      const u = f(f(f(level - t) + 3) * f(1 / 6));
      const u2 = f(u * u);
      const cubic = f(f(u2 * c2) + f(u * f(u2 * c3)));
      target = f(kneeBottom + f(k * f(f(u * a) + cubic)));
    }
    out[i] = powf(10, f(f(target - level) * f(0.05)));
  }
  return out;
}

/**
 * The bottom of the table's axis: the knee bottom as a power ratio. `0x380`
 * turns the threshold, which the template holds in tenths of a dB, into an
 * amplitude, squares it and takes 3 dB off (`0x3f7`–`0x408`).
 */
export function waveHammerFloor(thresholdDb: number): number {
  const tenths = Math.round(thresholdDb * 10);
  const amplitude = f(tenths * 10) <= -9000 ? 0 : powf(10, f(tenths * TENTHS_TO_EXPONENT));
  return f(f(amplitude * amplitude) * f(10 ** -0.3));
}

export class WaveHammer {
  private readonly gains: Float32Array;
  private readonly floor: number;
  private readonly indexScale: number;
  private readonly invWindow: number;
  private readonly window: number;
  private readonly mask: number;
  /** `[state+0x104]`: the automatic make-up at `0xd44` times the manual gain. */
  private readonly constant: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly b0: number;
  private readonly a1: number;

  /**
   * Two rings of the last `window` squares, channel 0 then channel 1. The
   * module keeps the samples and squares the oldest again on its way out;
   * keeping its square is the same float.
   */
  private readonly ring: Float32Array;
  private at = 0;
  private sumL = 0;
  private sumR = 0;
  /** `[state+0xf0]`, which `create` and `0x39a` both set to 1.0. */
  private env = 1;
  /** `[state+0xf4]`, the coefficient last chosen. Zero until the first sample. */
  private coef = 0;
  /** `[state+0x114]`, how many samples the gain has been falling for. */
  private falling = 0;
  /**
   * `[state+0x12c]`, the second smoother's state.
   *
   * ⚠️ It is **not** zero at reset: `0x8f1`–`0x901` seed it with
   * `(1 − b0)/(1 + a1)` in float32, a hair under 0.5 for the shipped pair. That
   * is the smoother's own fixed point for a gain of 1, so the first sample comes
   * out near unity instead of near `b0`. Starting it at zero makes sample 0 read
   * 0.0126 where the running module reads 0.998561 — an 18 dB hole at the top of
   * every render.
   */
  private smooth: number;

  constructor(p: WaveHammerParams = WAVEHAMMER_SHIPPED, sampleRate = 48000) {
    this.window = p.longLook ? 128 : 64;
    this.mask = this.window - 1;
    this.invWindow = f(1 / this.window);
    this.ring = new Float32Array(this.window * 2);
    this.floor = waveHammerFloor(p.thresholdDb);
    this.indexScale = f(3999 / f(1 - this.floor));
    this.gains = waveHammerTable(p.thresholdDb, p.ratio, this.floor);
    // `0xd44`–`0xdad`.
    const manual =
      f(p.outGainTenths * 10) <= -9000 ? 0 : powf(10, f(p.outGainTenths * TENTHS_TO_EXPONENT));
    this.constant = f(f(f(0.995) / this.gains[3999]) * manual);
    this.attack = waveHammerCoefficient(p.attackMs, sampleRate);
    this.release = waveHammerCoefficient(p.releaseMs, sampleRate);
    // `0x8a4` / `0x8c7`: one qword holding two floats, chosen by `CompCoeffSet`.
    // ⚠️ Read the *second float*, not the qword as a double: `prxdis` prints an
    // `f64` beside every operand and 0.96715366 is that double, not `a1`.
    this.b0 = p.coeffSet ? 0.0140483807772398 : 0.06660577654838562;
    this.a1 = p.coeffSet ? 0.9719032645225525 : 0.8667884469032288;
    // Both pairs are chosen so the smoother has unity DC gain, `2·b0/(1−a1)`.
    // The module keeps `1 + a1` as a literal of its own (`v0x1b68`, `v0x1b70`),
    // which is this sum rounded.
    this.smooth = f(f(1 - this.b0) / f(1 + this.a1));
  }

  /** One frame in; the gain to apply to **both** channels out. */
  gainFor(left: number, right: number): number {
    // `0x1000`: the module's buffers are float32, and so is the running sum it
    // keeps against the ring, which therefore never quite cancels — and the
    // gain follows that drift.
    const l = f(left);
    const r = f(right);
    const ll = f(l * l);
    const rr = f(r * r);
    const other = this.window;
    const oldL = this.ring[this.at];
    const oldR = this.ring[other + this.at];
    this.ring[this.at] = ll;
    this.ring[other + this.at] = rr;
    this.at = (this.at + 1) & this.mask;
    this.sumL = f(f(this.sumL - oldL) + ll);
    this.sumR = f(f(this.sumR - oldR) + rr);

    // `0x10f0`. The module's `max` also takes in a zeroed scratch, which only
    // matters when both sums have drifted below zero: unity either way. The
    // division by the window is exact, the window being a power of two.
    const x = Math.max(this.sumL, this.sumR) * this.invWindow;
    // `0x1194`–`0x12a7`, starting with `table · constant`: exact at unity.
    let target = this.constant;
    if (x > this.floor) {
      const index = f(f(x - this.floor) * this.indexScale);
      let table: number;
      if (index >= 3999) {
        table = this.gains[3999];
      } else {
        const lo = index | 0;
        const g = this.gains[lo];
        // `index − lo` is exact in float32.
        table = f(g + f((index - lo) * f(this.gains[lo + 1] - g)));
      }
      target = f(table * this.constant);
    }

    let c: number;
    if (target >= this.env) {
      // The gain is rising, so the signal is getting quieter: release. `0x11d0`.
      if (this.falling === 0) {
        c = this.coef;
      } else {
        if (this.falling > 30) {
          // ⚠️ `0x121f` scales the count by `[state+0x120]`, and **nothing ever
          // writes that slot** — `CompRelMod` lands one word earlier at `+0x11c`
          // and is never read. Confirmed by running the module with `CompRelMod`
          // at 0, 50 and 100: `+0x11c` moves, `+0x120` stays zero and the output
          // does not change. So the count collapses to 30, the expression below
          // reduces to `release`, and the parameter is dead.
          if (this.falling >= 1001) this.falling = 1000;
          const scaled = f(((f((this.falling - 30) * 0) | 0) + 30) * f(1 / 30));
          c = f(this.release / f(this.release + f(f(1 - this.release) / scaled)));
        } else {
          c = this.release;
        }
        this.coef = c;
        this.falling = 0;
      }
    } else {
      // The gain is falling, so the signal is getting louder: attack. `0x11ac`.
      c = this.attack;
      this.coef = c;
      this.falling += 1;
    }

    // ⚠️ Float32 in the module's order is what makes the release stall: near
    // rest the second smoother's step is under half an ulp of its state, so
    // once it has compressed the gain stops short of `constant` for the rest of
    // the song. In double it recovers, and is 0.001 dB off the module from then
    // on (*And it was run* in steering/lbp-audio-engine.md).
    const u = f(f(this.env * c) + f(target * f(1 - c)));
    const previous = this.smooth;
    this.smooth = f(f(u * this.b0) + f(previous * this.a1));
    // ⚠️ `0x129a` writes `s_prev + s_new`, not `s_new`, and that sum is both the
    // gain applied and the value the next sample compares its target against.
    this.env = f(previous + this.smooth);
    return this.env;
  }
}
