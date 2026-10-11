"""Run the game's own fmodextinput.prx on a scene from packages/lbp-tracker-lib/dev/prx-scene.ts.

    prxsynth.py <scene.json> <out.f32> [<scene.json> <out.f32> ...]
    prxsynth.py <list.txt>          one "scene.json|out.f32" pair per line

Writes the DSP's four lanes, interleaved float32: 0-1 dry plus echo, 2-3 the reverb send.
packages/lbp-tracker-lib/dev/prx-compare.ts compares lanes 0-1 with ours.

The state block is laid out as the eboot lays it (v0x1c5670 playback start, v0x1607c0 clips,
v0x1608d0 headers, v0x2a1144 instruments), each sample loaded as v0xb3e520 loads it and its mips
built by the eboot's own v0x3fc2b0. The playhead starts at 0 with a restart pending, as a song does.

Environment, for looking inside a run (each prints after every read in a frame range "a,b"):
    READ=n           frames per read call (default 1024; the module works in 256-frame blocks
                     whatever it is asked for, so the output does not depend on it)
    VOICES=a,b       the live records: instrument, gate, clip, record cursor, envelope A, pitch
                     in semitones and the pool score (+0x04 x +0x0c)
    POSV=a,b         every live record's pitch, pitch slide and gate, and its five layers' sample
                     positions (+0x40 + 8i; a layer past Numstack stays 0)
    --trace          record 0 in detail, between TRACE_FROM and TRACE_TO
"""
import json
import os
import struct
import sys

import ebconf  # noqa: E402
import prxrun  # noqa: E402

img = prxrun.standard(rand_constant=0x13333333, size=0x40000000)
syn = img.load('input')
assert not syn.unresolved, syn.unresolved
eb = img.load_eboot()
DSP_READ = syn.exports['wycAbBCjLI4']  # the DSP's read callback
EB = ebconf.data()
D = ebconf.DELTA
echo_bias = struct.unpack_from('<f', EB, 0xe5c1b8 + D)[0]
assert echo_bias == -1.0, echo_bias


def w(addr, fmt, *v):
    struct.pack_into(fmt, img.buf, addr - img.mem, *v)




def run(scene, dst, tap=None):
    """`tap(out, frames)`, when given, sees each block the module wrote: `tools/prxchain.py`."""
    # ---- instruments --------------------------------------------------------------------------
    def load_slot(slot, path):
        """v0xb3e520, transcribed: the chunk walk, data, smpl (loop + 16-frame patch), fmt."""
        raw = open(path, 'rb').read()
        assert raw[:4] == b'RIFF' and raw[8:12] == b'WAVE'
        end = 8 + struct.unpack_from('<I', raw, 4)[0]
        pos = 12
        data = None
        while pos < end:
            cid, size = raw[pos:pos + 4], struct.unpack_from('<I', raw, pos + 4)[0]
            body = pos + 8
            if cid == b'data':
                n = size >> 1
                need = (n | 0xf) + 0x11
                data = img.alloc(need * 2, 64)
                img.write(data, raw[body:body + 2 * n])          # the 16 after it stay zero
                w(slot + 0x00, '<i', need)
                w(slot + 0x08, '<Q', data)
                w(slot + 0x10, '<Q', data)
                w(slot + 0x18, '<II', need, need)
                w(slot + 0x78, '<i', n)
                if img.buf[slot - img.mem + 0x94]:
                    w(slot + 0x78, '<i', int(n / 2))
            elif cid == b'smpl':
                loops = struct.unpack_from('<I', raw, body + 0x1c)[0]
                for k in range(loops):
                    start, stop = struct.unpack_from('<II', raw, body + 0x24 + 0x18 * k + 8)
                    frames = struct.unpack_from('<i', img.buf, slot - img.mem + 0x78)[0]
                    s = start
                    if s >= frames:
                        s = frames - 1
                    e1 = min(stop + 1, frames)
                    w(slot + 0x7c, '<i', s)
                    w(slot + 0x80, '<i', e1 - s)
                    assert not img.buf[slot - img.mem + 0x94], 'stereo loop patch not transcribed'
                    for i in range(16):
                        v = struct.unpack_from('<h', img.buf, data - img.mem + 2 * (s + i))[0]
                        struct.pack_into('<h', img.buf, data - img.mem + 2 * (e1 + i), v)
            elif cid == b'fmt ':
                ch = struct.unpack_from('<H', raw, body + 2)[0]
                img.buf[slot - img.mem + 0x94] = 1 if ch == 2 else 0
            size += size & 1
            pos = body + size
        # mips: room for the eboot's builder so it never reaches the allocator
        need = struct.unpack_from('<i', img.buf, slot - img.mem)[0]
        for vec, cap in ((0x38, need // 2 + 16), (0x60, need // 4 + 16)):
            w(slot + vec, '<Q', img.alloc(cap * 2, 64))
            w(slot + vec + 0xc, '<I', cap)
        img.call(eb.addr(0x3fc2b0), slot)
        if '--debug' in sys.argv:
            f = lambda o, fmt='<i': struct.unpack_from(fmt, img.buf, slot - img.mem + o)[0]
            for m in (0, 0x28, 0x50):
                ptr8, ptr10 = f(m + 8, '<Q'), f(m + 0x10, '<Q')
                vals = struct.unpack_from('<6h', img.buf, ptr8 - img.mem) if ptr8 else ()
                print('mip@%#x len %d ptr8 %#x ptr10 %#x first %s' % (m, f(m), ptr8, ptr10, vals))
            print('frames', f(0x78), 'loop', f(0x7c), f(0x80), 'stereo', img.buf[slot - img.mem + 0x94])


    insts = img.alloc(0x5f0 * max(1, len(scene['instruments'])), 64)
    for k, ins in enumerate(scene['instruments']):
        rec = insts + 0x5f0 * k
        for i, s in enumerate(ins['slots'][:8]):
            slot = rec + 0x98 * i
            w(slot + 0x84, '<i', s['root'])
            w(slot + 0x88, '<f', s['tempo'])
            w(slot + 0x8c, '<f', s['fineTune'])
            img.buf[slot - img.mem + 0x90] = 1 if s['pitched'] else 0
            img.buf[slot - img.mem + 0x91] = 1 if s['synced'] else 0
            if s['smp']:
                load_slot(slot, s['smp'])
        for i, v in enumerate(ins['splitNotes'][:9]):
            w(rec + 0x4c0 + 4 * i, '<i', v)
        w(rec + 0x4e4, '<i', ins['numStack'])
        for i, (x, y) in enumerate(ins['params'][:27]):
            w(rec + 0x4e8 + 8 * i, '<ff', x, y)
        img.buf[rec - img.mem + 0x5e0] = 1 if ins['arpeggiate'] else 0
        w(rec + 0x5e4, '<i', ins['guid'] & 0x7fffffff)

    # ---- clips and headers ---------------------------------------------------------------------
    clips = scene['clips']
    carr = img.alloc(0x470 * max(1, len(clips)), 64)
    harr = img.alloc(16 * max(1, len(clips)), 64)
    for k, c in enumerate(clips):
        cp = carr + 0x470 * k
        words = c['words'][:256]
        w(cp + 0x00, '<i', len(words))
        w(cp + 0x0c, '<i', c['scale'])
        w(cp + 0x10, '<i', c['root'])
        w(cp + 0x1c, '<i', c['length'])
        for i, word in enumerate(words):
            w(cp + 0x20 + 4 * i, '<I', word)
        f32 = lambda x: struct.unpack('<f', struct.pack('<f', x))[0]
        w(cp + 0x420, '<ffff', c['level'], c['pan'], f32(f32(c['echoSend']) + f32(c['echoSend'])) + echo_bias, c['reverbSend'])
        w(cp + 0x430, '<i', c['inst'])
        w(harr + 16 * k, '<iiii', c['cell'], c['channel'], c['length'], c['row'])

    # ---- the state block, as playback start leaves it ------------------------------------------
    st = img.alloc(0x1c00, 64)
    w(st + 0x08, '<QQ', insts, insts)
    for v in range(32):
        r = st + 0x28 + 0xd0 * v
        img.buf[r - img.mem] = 0xff
    w(st + 0x1a28, '<fffff', scene['tempo'], min(scene['swing'], 0.99), scene['echoTime'] * 0.5,
      scene['echoFeedback'], scene['echoMix'])
    w(st + 0x1a44, '<ii', 1, 1)                       # playing, restart pending
    w(st + 0x1a4c, '<ff', 0.0, 0.0)                   # playhead and its copy, in steps
    w(st + 0x1a58, '<i', -1)                          # no chip loop
    for i in range(8):
        vol = scene['volumes'][i] * 0.75 if i < len(scene['volumes']) else 0.75
        w(st + 0x1a68 + 12 * i, '<fii', vol, 0, 0)
    w(st + 0x1ad0, '<QQ', carr, carr)
    w(st + 0x1af0, '<i', len(clips))
    w(st + 0x1af8, '<QQ', harr, harr)
    w(st + 0x1b18, '<Q', img.alloc(768000, 64))
    w(st + 0x1b38, '<i', -1)                          # no audition note
    dsp = img.alloc(0x40)
    w(dsp + 8, '<Q', st)

    BLOCK = int(os.environ.get('READ', 256 if '--trace' in sys.argv else 1024))
    outb = img.alloc(BLOCK * 16, 64)
    inb = img.alloc(BLOCK * 16, 64)
    with open(dst, 'wb') as fh:
        for b in range(0, scene['frames'], BLOCK):
            rc = img.call(DSP_READ, dsp, inb, outb, BLOCK, 4, 4)[0] & 0xffffffff
            if rc:
                raise SystemExit('read returned %d' % rc)
            fh.write(img.read(outb, BLOCK * 16))
            if tap:
                tap(outb, BLOCK)
            lo, hi = int(os.environ.get('TRACE_FROM', 2800)), int(os.environ.get('TRACE_TO', 3800))
            if '--trace' in sys.argv and lo <= b <= hi:
                r0 = st + 0x28
                g = lambda o, f='<f': struct.unpack_from(f, img.buf, r0 - img.mem + o)[0]
                print('after frames %d..%d: inst %d gate %d pos %.6f envA %.5f envB %.5f vol %.4f pitch %.5f slide %.6f mod %.5f playhead %.5f' % (
                    b, b + BLOCK, img.buf[r0 - img.mem], g(0x10, '<i'), g(0x40, '<d'), g(0x90), g(0x94), g(0x0c), g(0x08), g(0x30), g(0x28),
                    struct.unpack_from('<f', img.buf, st - img.mem + 0x1a4c)[0]))
            if os.environ.get('POSV') and int(os.environ['POSV'].split(',')[0]) <= b <= int(os.environ['POSV'].split(',')[1]):
                for v in range(32):
                    r0 = st + 0x28 + 0xd0 * v
                    if img.buf[r0 - img.mem] != 0xff:
                        gf = lambda o, f='<f': struct.unpack_from(f, img.buf, r0 - img.mem + o)[0]
                        print('after %d: v%d pitch %.4f slide %.5f gate %d pos %s' % (b + BLOCK, v, gf(0x08), gf(0x30), struct.unpack_from('<i', img.buf, r0 - img.mem + 0x10)[0], ' '.join('%.6f' % gf(0x40 + 8 * i, '<d') for i in range(5))))
            if os.environ.get('VOICES') and int(os.environ['VOICES'].split(',')[0]) <= b <= int(os.environ['VOICES'].split(',')[1]):
                recs = []
                for v in range(32):
                    r0 = st + 0x28 + 0xd0 * v
                    inst = img.buf[r0 - img.mem]
                    if inst != 0xff:
                        gi = lambda o, f='<i': struct.unpack_from(f, img.buf, r0 - img.mem + o)[0]
                        recs.append('%d:i%d g%d c%d r%d e%.2f p%.2f s%.4f' % (
                            v, inst, gi(0x10), gi(0x38), gi(0x3c, '<H'), gi(0x90, '<f'), gi(0x08, '<f'),
                            gi(0x04, '<f') * gi(0x0c, '<f')))
                ph = struct.unpack_from('<f', img.buf, st - img.mem + 0x1a4c)[0]
                print('after %d (p %.3f): %d live: %s' % (b + BLOCK, ph, len(recs), ' '.join(recs)))
    print('%d frames through fmodextinput.prx' % scene['frames'])


def pairs(argv):
    """`(scene.json, out)` pairs from the command line or a list file."""
    args = [a for a in argv if not a.startswith('--')]
    if args[0].endswith('.txt'):
        return [tuple(l.split('|')) for l in open(args[0]).read().splitlines() if l.strip()]
    return [(args[i], args[i + 1]) for i in range(0, len(args), 2)]


if __name__ == '__main__':
    mark = img.cursor
    for src, dst in pairs(sys.argv[1:]):
        img.cursor = mark
        sc = json.load(open(src))
        assert sc['rand'] == 0x13333333
        try:
            run(sc, dst)
        except SystemExit as e:
            print('FAILED', src, e)
