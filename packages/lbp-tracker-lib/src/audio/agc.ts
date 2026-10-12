/**
 * An automatic gain control after the game's master bus: **ours, not the
 * game's**, one of the page's four master buses since 2026-10-12 (*63* in
 * steering/open-questions.md).
 *
 * The game's bus plays its songs quietly -- −20 to −22 LUFS over four whole
 * corpus songs, 5 to 7 LU under our glue -- and this rides one gain for both
 * channels towards `AGC.targetLufs`, slowly: it means to be a normalisation
 * that needs no song in advance, settling on a song's level rather than
 * levelling its sections.
 *
 *   1. **Loudness**, as BS.1770 weighs it: each channel through the K filter
 *      (a high shelf and a high pass, designed at the context's own rate), the
 *      two powers summed, smoothed over `momentaryMs`.
 *   2. **The level the gain answers to**, a slow follower of that loudness in
 *      LUFS, every `STRIDE` frames: up in `riseS`, down in `fallS`, so a song
 *      that gets louder is turned down within seconds and one that gets
 *      quieter is lifted over most of a minute. Within `bandLu` it follows freely;
 *      further down it goes only once the loudness has sat there for
 *      `fallHoldS`, or for `quietHoldS` when it sits more than `relativeLu`
 *      under (BS.1770's relative gate), and never below `gateLufs` -- so a
 *      dip does not pump the gain, and the tail of a song
 *      that stops, which falls through every level on its way to silence, does
 *      not pull it up, while a song quieter than the last is still found. For
 *      the first `warmS` of sound, and again after `rewarmS` of silence, it
 *      follows much faster and holds nothing, so a song finds its level in its
 *      first seconds instead of fading in from where the last one left it.
 *   3. **The gain**, `target − level` in dB, between `minDb` and `maxDb`,
 *      smoothed over `gainMs` so it never steps.
 *   4. **Our limiter** (`Limiter` in `master.ts`), so a transient the gain lifts
 *      past full scale is held at the ceiling instead of clipping.
 *
 * Causal and stateful, like the WaveHammer before it: `render.ts` and the
 * worklet run the same instance over the same signal, so play and export
 * agree. Unlike normalising it needs nothing in advance, and unlike a gain it
 * changes the song's dynamics, slowly: a quiet section comes up towards the
 * target and a loud one goes down, and the limiter shaves what the gain lifts
 * past the ceiling.
 */

import { Limiter, MASTER_DEFAULTS } from './master.ts';

/** The AGC's settings. Time constants in seconds unless named `Ms`. */
export const AGC = {
  /** Where the gain takes a song: about where our glue leaves the corpus. */
  targetLufs: -16,
  momentaryMs: 400,
  /**
   * Measured on four whole songs, 2026-10-12 (*63* in
   * steering/open-questions.md): at 1.5 s and 6 s the AGC took `This Is
   * Halloween`'s loudness range from 10.4 LU to 2.9, a compressor's work; at
   * these the four keep 3.9 to 6.0 LU of their 4.1 to 10.4, and land at −16.1
   * to −16.5 LUFS.
   */
  riseS: 10,
  fallS: 40,
  /** For the first this many seconds of sound, the follower is faster: `warmRiseS`, `warmFallS`. */
  warmS: 6,
  warmRiseS: 0.5,
  warmFallS: 1,
  /**
   * This much silence, under `gateLufs` on a `silenceMs` detector, and the next
   * sound warms up again: a new song. ⚠️ Not on the momentary loudness, which
   * takes some 4 s to fall from a loud song to the gate.
   */
  rewarmS: 3,
  silenceMs: 50,
  /** Below this the follower holds: BS.1770's absolute gate is −70, a mix's silence sits well above it. */
  gateLufs: -50,
  /** Within this of the level, the follower follows freely, either way. */
  bandLu: 1,
  /** How long the loudness must sit further under the level before the level follows it down. */
  fallHoldS: 1,
  /** ...and how long when it sits more than `relativeLu` under: BS.1770's relative gate. */
  relativeLu: 10,
  quietHoldS: 4,
  /** The level assumed before any sound, the median of the four songs measured: +6 dB to start. */
  startLufs: -22,
  minDb: -12,
  maxDb: 18,
  gainMs: 50,
  ceilingDb: MASTER_DEFAULTS.ceilingDb,
} as const;

/** BS.1770's −0.691 dB: loudness from the K-weighted power of both channels summed. */
const lufsToPower = (lufs: number): number => 10 ** ((lufs + 0.691) / 10);
const powerToLufs = (power: number): number => 10 * Math.log10(power) - 0.691;
const dbToGain = (db: number): number => 10 ** (db / 20);
/** A one-pole's step for a time constant, at `rate` steps a second. */
const pole = (seconds: number, rate: number): number => 1 - Math.exp(-1 / (seconds * rate));
/** The follower runs every this many frames: a logarithm a frame is more than it needs. */
const STRIDE = 32;

/** One biquad's coefficients, normalised by `a0`. */
interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * The K filter at any rate, as libebur128 designs it from the filter's analogue
 * parameters: at 48 kHz it gives the coefficients BS.1770 tabulates
 * (`test/agc.test.ts`). The first stage is a high shelf, +4 dB above about
 * 1.7 kHz, the head's own boost; the second a high pass at 38 Hz, the RLB
 * curve's low end.
 */
export function kWeighting(rate: number): [Biquad, Biquad] {
  let k = Math.tan((Math.PI * 1681.974450955533) / rate);
  let q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  k = Math.tan((Math.PI * 38.13547087602444) / rate);
  q = 0.5003270373238773;
  a0 = 1 + k / q + k * k;
  const pass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  return [shelf, pass];
}

/** Two biquads in series, one channel's state. */
class KFilter {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private u1 = 0;
  private u2 = 0;
  private z1 = 0;
  private z2 = 0;

  private readonly s: Biquad;
  private readonly p: Biquad;

  constructor(shelf: Biquad, pass: Biquad) {
    this.s = shelf;
    this.p = pass;
  }

  step(x: number): number {
    const s = this.s;
    const y = s.b0 * x + s.b1 * this.x1 + s.b2 * this.x2 - s.a1 * this.y1 - s.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    const p = this.p;
    const z = p.b0 * y + p.b1 * this.u1 + p.b2 * this.u2 - p.a1 * this.z1 - p.a2 * this.z2;
    this.u2 = this.u1;
    this.u1 = y;
    this.z2 = this.z1;
    this.z1 = z;
    return z;
  }
}

export class Agc {
  /** The frame out of the last `process`, `LIMITER.lookaheadMs` late. */
  left = 0;
  right = 0;
  /** The gain applied to the last frame, before the limiter. */
  gain: number;
  private readonly kl: KFilter;
  private readonly kr: KFilter;
  private readonly limiter: Limiter;
  /** The K-weighted power of both channels, smoothed over `momentaryMs`, and over `silenceMs`. */
  private momentary = 0;
  private fast = 0;
  /** The level the gain answers to, in LUFS, and the gain it asks for. */
  private level: number = AGC.startLufs;
  private want: number;
  private stride = 0;
  /** Follower steps: of sound so far (the warm-up), in a row under the level, and of silence. */
  private heard = 0;
  private under = 0;
  private silent = 0;
  private readonly warmSteps: number;
  private readonly rewarm: number;
  private readonly fallHold: number;
  private readonly quietHold: number;
  private readonly cMomentary: number;
  private readonly cFast: number;
  private readonly cRise: number;
  private readonly cFall: number;
  private readonly cWarmRise: number;
  private readonly cWarmFall: number;
  private readonly cGain: number;
  private readonly gate = lufsToPower(AGC.gateLufs);

  constructor(sampleRate: number) {
    const [shelf, pass] = kWeighting(sampleRate);
    this.kl = new KFilter(shelf, pass);
    this.kr = new KFilter(shelf, pass);
    this.limiter = new Limiter(sampleRate, AGC.ceilingDb);
    const steps = sampleRate / STRIDE;
    this.warmSteps = AGC.warmS * steps;
    this.rewarm = AGC.rewarmS * steps;
    this.fallHold = AGC.fallHoldS * steps;
    this.quietHold = AGC.quietHoldS * steps;
    this.cMomentary = pole(AGC.momentaryMs / 1000, sampleRate);
    this.cFast = pole(AGC.silenceMs / 1000, sampleRate);
    this.cRise = pole(AGC.riseS, steps);
    this.cFall = pole(AGC.fallS, steps);
    this.cWarmRise = pole(AGC.warmRiseS, steps);
    this.cWarmFall = pole(AGC.warmFallS, steps);
    this.cGain = pole(AGC.gainMs / 1000, sampleRate);
    this.want = this.wanted();
    this.gain = this.want;
  }

  private wanted(): number {
    return dbToGain(Math.min(AGC.maxDb, Math.max(AGC.minDb, AGC.targetLufs - this.level)));
  }

  /** One follower step, every `STRIDE` frames. */
  private follow(): void {
    if (this.fast <= this.gate) {
      this.silent += 1;
      if (this.silent > this.rewarm) this.heard = 0;
    } else {
      this.silent = 0;
    }
    if (this.momentary <= this.gate) {
      this.under = 0;
      return;
    }
    const now = powerToLufs(this.momentary);
    const rising = now > this.level;
    // ⚠️ Counted only past the band: a level that has settled a hair above a
    // steady song would otherwise have used its hold up by the time the song
    // stopped, and followed the tail down.
    this.under = now > this.level - AGC.bandLu ? 0 : this.under + 1;
    // Warming up, a song is being found, not ridden: no holds.
    const warm = this.heard < this.warmSteps;
    const hold = now > this.level - AGC.relativeLu ? this.fallHold : this.quietHold;
    if (!warm && this.under > 0 && this.under <= hold) return;
    this.heard += 1;
    const c = rising ? (warm ? this.cWarmRise : this.cRise) : (warm ? this.cWarmFall : this.cFall);
    this.level += (now - this.level) * c;
    this.want = this.wanted();
  }

  /** One frame in; the frame `LIMITER.lookaheadMs` old out, in `left` and `right`. */
  process(left: number, right: number): void {
    const kl = this.kl.step(left);
    const kr = this.kr.step(right);
    const power = kl * kl + kr * kr;
    this.momentary += (power - this.momentary) * this.cMomentary;
    this.fast += (power - this.fast) * this.cFast;
    this.stride += 1;
    if (this.stride === STRIDE) {
      this.stride = 0;
      this.follow();
    }
    this.gain += (this.want - this.gain) * this.cGain;
    this.limiter.process(left * this.gain, right * this.gain);
    this.left = this.limiter.left;
    this.right = this.limiter.right;
  }
}
