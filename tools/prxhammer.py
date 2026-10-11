r"""`fmodsmswavehammer.prx` alone, made and run as `tools/prxchain.py` does, on the test's signal.

    prxhammer.py

The module made by the eboot's own create (`prxchain.make_hammer`) and run against the console's
own libc, so its `powf` and `log10f` are the game's. Prints what
`packages/lbp-tracker-lib/test/compressor.test.ts` pins:

- the gain at the frames `VECTORS` names, for that test's `signal()` (an LCG under a raised
  cosine), read as `out/in` on channel 0 -- so to about 5e-8, the rounding of `out`;
- then silence: `[state+0xf0]`, the gain itself, at each block end, and where it comes to rest;
- a fresh module on silence alone, and the first frame of a fresh module fed 1.0;
- the state the module computed for itself.

`tools/runhammer.py` is the older harness: it loads the module by hand and answers `powf` and
`_FLog` with the CRT's `pow` and `log10` through a shim, not the console's.
"""
import math
import struct

import prxchain as P

img = P.img
N = 256
FRAMES = 8 * N
SILENCE = 3 * 48000 // N
VECTORS = (0, 1, 7, 33, 64, 65, 100, 255, 256, 400, 700, 1023, 1024, 1200, 1500, 1900, 2047)


def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


def signal():
    """compressor.test.ts's `signal()`, in the same order: left then right per frame."""
    state, mask = 0x12345678, (1 << 64) - 1
    out = []
    for k in range(FRAMES):
        amp = 0.02 + 0.9 * (0.5 - 0.5 * math.cos(2 * math.pi * k / FRAMES))
        pair = []
        for _ in range(2):
            state = (state * 6364136223846793005 + 1442695040888963407) & mask
            pair.append(amp * ((state >> 33) / 2 ** 31 * 2 - 1))
        out.append(tuple(pair))
    return out


class Hammer:
    def __init__(self):
        self.dsp = P.make_hammer()
        inst, = struct.unpack('<Q', img.read(self.dsp + 8, 8))
        self.state, = struct.unpack('<Q', img.read(inst + 0xf8, 8))
        self.inp, self.out = img.alloc(N * 16, 64), img.alloc(N * 16, 64)

    def block(self, frames):
        img.write(self.inp, struct.pack('<%df' % (4 * N),
                                        *[v for l, r in frames for v in (l, r, 0.0, 0.0)]))
        rc = img.call(P.HAMMER_READ, self.dsp, self.inp, self.out, N, 4, 4)[0] & 0xffffffff
        if rc:
            raise SystemExit('read returned %d' % rc)
        return struct.unpack('<%df' % (4 * N), img.read(self.out, 16 * N))

    def f32(self, o):
        return struct.unpack('<f', img.read(self.state + o, 4))[0]

    def rest(self):
        """Blocks of silence: the gain at the end, and the block after which it last moved."""
        moved, last = 0, self.f32(0xf0)
        for b in range(SILENCE):
            self.block([(0.0, 0.0)] * N)
            env = self.f32(0xf0)
            if env != last:
                moved, last = b, env
        return last, moved


def main():
    h = Hammer()
    sig = signal()
    gains = []
    for b in range(FRAMES // N):
        chunk = sig[N * b:N * b + N]
        out = h.block(chunk)
        gains += [out[4 * i] / f32(l) for i, (l, _) in enumerate(chunk)]
    print('signal(), the gain at each VECTORS frame (out/in, channel 0):')
    for k in VECTORS:
        l, r = sig[k]
        print('  [%d, %.9g, %.9g, %.9g],' % (k, l, r, gains[k]))
    env, moved = h.rest()
    print('then silence: [state+0xf0] = %r, last moved in block %d of %d' % (env, moved, SILENCE))
    env, moved = Hammer().rest()
    print('silence alone, from reset: [state+0xf0] = %r, last moved in block %d' % (env, moved))
    first = Hammer().block([(1.0, 1.0)] + [(0.0, 0.0)] * (N - 1))[0]
    print('the first frame of a fresh module fed 1.0: %r' % first)
    print('state: ' + ', '.join('+%#x %r' % (o, h.f32(o))
                                for o in (0xc8, 0xe8, 0xf8, 0xfc, 0x104, 0x124, 0x128)))


if __name__ == '__main__':
    main()
