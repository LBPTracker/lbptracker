r"""fmodsmsreverb.prx given a new preset after it has run: the vectors `reverb.test.ts` pins.

    prxrevswitch.py <dir> [A:B ...]      settings A then B; default every ordered pair of 0-5
    prxrevswitch.py <dir> reapply        settings 0-5 on steady noise, the preset applied again
                                         every 768 frames (R-s.f32) and never (U-s.f32)

Each scene is the module made by the eboot's own create (`v0x3fcfe0`, as `prxchain.py` makes it),
setting A applied before the first block -- a chain's first song -- then SWITCH frames of the
signal below, setting B applied as `applyReverbPreset` applies it (ten `setparameter` calls, each
reconfiguring at `v0x3fd482`), and the rest. Writes `in.f32` (the send, stereo) and `A-B.f32`
(lanes 0-1 of what the module writes back, stereo), and prints each scene's **digest**: the
stereo RMS of every 1024-frame window over the first 36, which is what `reverb.test.ts` holds
`Reverb.reconfigure` to.

The signal, which the test regenerates: an impulse (0.5, 0.25) at frame 256 -- the first block
silent, as every song the game starts leaves it -- LCG noise bursts at
1000-1299 and across the switch at SWITCH-400..SWITCH+399, an impulse at SWITCH+512 and a burst
at SWITCH+3000..+3499. The LCG is `s = s*1664525 + 1013904223 mod 2^32` from 12345, each value
`(s/2^32 - 0.5) * 0.6` in float32, left then right.

What a switch does is *SMS Reverb* in steering/lbp-audio-engine.md: the coefficients change, the
lengths do not, and a comb the first preset never built runs anyway.
"""
import array
import math
import os
import struct
import sys

import prxchain as C

img = C.img
mark = img.cursor
SWITCH = 2048
FRAMES = 256 * 300
WINDOW, WINDOWS = 1024, 36


def f32(v):
    return struct.unpack('<f', struct.pack('<f', v))[0]


def lcg(seed):
    while True:
        seed = (seed * 1664525 + 1013904223) & 0xffffffff
        yield f32((seed / 4294967296.0 - 0.5) * 0.6)


def signal():
    x = array.array('f', [0.0] * (FRAMES * 2))
    noise = lcg(12345)
    for at, n in ((256, 0), (1000, 300), (SWITCH - 400, 800), (SWITCH + 512, 0), (SWITCH + 3000, 500)):
        if not n:
            x[2 * at], x[2 * at + 1] = 0.5, 0.25
        for i in range(at, at + n):
            x[2 * i] = next(noise)
            x[2 * i + 1] = next(noise)
    return x


def scene(a, b, sig, every=None):
    """Setting `a`, then `b` at SWITCH -- or, with `every`, `b` again every that many frames."""
    img.cursor = mark
    d = C.make_reverb()
    C.apply_preset(d, a)
    inb, outb = img.alloc(256 * 16), img.alloc(256 * 16)
    out = array.array('f')
    for at in range(0, FRAMES, 256):
        if (every is None and at == SWITCH) or (every and at and at % every == 0):
            C.apply_preset(d, b)
        lanes = array.array('f', [0.0] * 1024)
        for i in range(256):
            lanes[4 * i + 2] = sig[2 * (at + i)]
            lanes[4 * i + 3] = sig[2 * (at + i) + 1]
        img.write(inb, lanes.tobytes())
        img.call(C.REVERB_READ, d, inb, outb, 256, 4, 4)
        got = array.array('f')
        got.frombytes(img.read(outb, 256 * 16))
        for i in range(256):
            out.append(got[4 * i])
            out.append(got[4 * i + 1])
    return out


def digest(out):
    return [math.sqrt(sum(out[j] ** 2 for j in range(2 * w * WINDOW, 2 * (w + 1) * WINDOW)) / WINDOW)
            for w in range(WINDOWS)]


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    dst = sys.argv[1]
    os.makedirs(dst, exist_ok=True)
    if sys.argv[2:] == ['reapply']:
        noise = lcg(99)
        sig = array.array('f', [0.0] * (FRAMES * 2))
        for i in range(FRAMES):
            sig[2 * i] = sig[2 * i + 1] = next(noise)
        open(os.path.join(dst, 'in-noise.f32'), 'wb').write(sig.tobytes())
        for s in range(6):
            open(os.path.join(dst, 'R-%d.f32' % s), 'wb').write(scene(s, s, sig, 768).tobytes())
            open(os.path.join(dst, 'U-%d.f32' % s), 'wb').write(scene(s, s, sig, 0).tobytes())
            print('setting %d written' % s)
        raise SystemExit
    pairs = [tuple(map(int, p.split(':'))) for p in sys.argv[2:]] or \
        [(a, b) for a in range(6) for b in range(6)]
    sig = signal()
    open(os.path.join(dst, 'in.f32'), 'wb').write(sig.tobytes())
    for a, b in pairs:
        out = scene(a, b, sig)
        open(os.path.join(dst, '%d-%d.f32' % (a, b)), 'wb').write(out.tobytes())
        print('%d -> %d: [%s]' % (a, b, ', '.join('%.5g' % v for v in digest(out))))
