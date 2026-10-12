r"""Run the sequencer's whole chain in the game's own modules, in series, on one scene.

    prxchain.py <scene.json> <dir> [<scene.json> <dir> ...]
    prxchain.py <list.txt>          one "scene.json|dir" pair per line

`fmodextinput.prx` on the scene exactly as `tools/prxsynth.py` runs it, then every block it writes
straight into `fmodsmsreverb.prx`, and what that writes into `fmodsmswavehammer.prx`: the order
`Channel::addDSP` builds behind the sequencer's DSP (eboot `v0x3e66cb`, `v0x3e67f9`, `v0x3e6976`;
*The sequencer's chain* in steering/lbp-audio-engine.md). All three run in one `prxrun` image
against the game's own libc. Writes into `<dir>`, four interleaved float32 lanes each:

    prx.f32           the synthesiser: 0-1 dry + echo, 2-3 the reverb send (prxsynth.py's file)
    prx-reverb.f32    after SMS Reverb: (dry + wet, dry + wet, 0, 0)
    prx-hammer.f32    after SMS WaveHammer, which is where the game's own code ends

The 7.1 matrix and the stereo fold after it are FMOD's mixer and the platform's, not modules;
`packages/lbp-tracker-lib/dev/prx-chain.ts` applies them as read and compares every boundary with
ours (`prx-scene.ts` with `CHAIN=1` writes our side).

**Both DSPs are made by the eboot's own code**, minus its allocator (`v0x16ce0`), whose blocks are
allocated here at the sizes it asks for:

- the reverb by its create `v0x3fcfe0`: preset row 2 into the slots with slot 0 pinned at -800
  (`v0x3fd1ad`-`v0x3fd1eb`), then `v0x3fcc00` and `v0x3fcd50` with the configure flag set;
- the WaveHammer by its create `v0x3fd6c0`: the 0x44-byte template at `v0x1062850` into the
  parameter block (`rep movsd` at `v0x3fd8da`), the stores of `v0x3fd8dc`-`v0x3fda47`, and the
  template marshalled into the kernel's config by the eboot's `setparameter` `v0x3fda80`, which
  repeats the create's marshal instruction for instruction and differs only in which dirty
  counters it bumps -- put back as the create leaves them;

and then the song starts as the sequencer's play (`v0x1c5670`) starts one: `applyReverbPreset`
(`v0x3fd4c0`, reached through `v0x3e7470` at `v0x1c5eeb`) for the scene's `ReverbSetting`,
transcribed as the ten `DSP::setParameter` calls it makes, each landing in the plugin's own
callback `v0x3fd3d0`, which reconfigures (`v0x3fd482`) -- then the first block.

Environment:
    READ=n   frames per read (default 1024). ⚠️ A multiple of 256: the WaveHammer traps otherwise
    WARM=n   frames of silence through the chain before the preset and the song (default 0). The
             chain is created on the first play and runs from then on (lbp-audio-engine.md), so 0
             is a session's first song and n a later one, after silence on the create's preset 2:
             the WaveHammer has settled, and ⚠️ a scene on any other preset gets the reverb a
             preset change leaves on a module that has run, which is not `Reverb`'s.
    REAPPLY=n  apply the preset again every n frames of the song (a multiple of READ), as
             `v0x1c6250` would if it ran while a song plays: it re-applies it at `v0x1c6405` with
             the tempo, swing and volumes, and who calls it, how often, is unread.
"""
import json
import os
import struct
import sys

import ebconf
import prxsynth

img, eb = prxsynth.img, prxsynth.eb
w = prxsynth.w
# ⚠️ The WaveHammer prints "Writing back storage 0x%p 0x%p %i" and "DONE" (`0xdd8`, `0xdf8`)
# whenever it rebuilds its table, and the game's `printf` and `puts` reach libkernel, which is not
# loaded: they trap. Nothing else on the path needs them.
img.overrides['hcuQgD53UxM'] = img.overrides['YQ0navp+YIc'] = img.stubs['ret0']
rev = img.load('reverb')
ham = img.load('hammer')
assert not rev.unresolved, rev.unresolved
assert not ham.unresolved, ham.unresolved
REVERB_READ = rev.exports['iO5jJEuFaSo']       # 0x23a0
HAMMER_READ = ham.exports['-UZ0JwaglR8']       # 0x19f0
EB, D = ebconf.data(), ebconf.DELTA
PRESETS, REMAP, TEMPLATE = 0x1062620, 0x1062830, 0x1062850


def preset_row(i):
    return struct.unpack_from('<11i', EB, PRESETS + D + 0x2c * i)


def make_reverb():
    inst, params, state = img.alloc(0x100, 128), img.alloc(0x100, 128), img.alloc(0x580, 128)
    delay, slots, dsp = img.alloc(0x4b000, 128), img.alloc(0x2c, 128), img.alloc(0x40)
    w(inst + 0xe0, '<Q', slots)
    w(inst + 0xf0, '<QQ', params, state)
    w(dsp + 8, '<Q', inst)
    img.write(slots, struct.pack('<11i', *preset_row(2)))
    w(slots, '<i', -800)
    img.call(eb.addr(0x3fcc00), params)
    img.call(eb.addr(0x3fcd50), params, slots, 1, delay)
    return dsp


def apply_preset(dsp, setting):
    row = preset_row(struct.unpack_from('<8i', EB, REMAP + D)[setting])
    for i in range(1, 11):
        # v0x3fd577 / v0x3fd5b2: slots 7 and 9 go as `byte != 0`, the rest `vcvtsi2ss`.
        v = float(1 if row[i] & 0xff else 0) if i in (7, 9) else float(row[i])
        img.call(eb.addr(0x3fd3d0), dsp, i, floats=(v,))


def make_hammer():
    inst, cfg, state = img.alloc(0x100, 128), img.alloc(0x80, 128), img.alloc(0x180, 128)
    b3e80, b1000, params = img.alloc(0x3e80, 128), img.alloc(0x1000, 128), img.alloc(0x44, 128)
    dsp = img.alloc(0x40)
    w(inst + 0xe0, '<Q', params)
    w(inst + 0xf0, '<QQ', cfg, state)
    w(dsp + 8, '<Q', inst)
    img.write(params, EB[TEMPLATE + D:TEMPLATE + D + 0x44])
    w(state + 0xf0, '<f', 1.0)
    w(state + 0x6c, '<f', 1.0)
    w(cfg + 4, '<ii', 2, 48000)
    w(state + 0x130, '<QQ', b1000, b3e80)
    img.call(eb.addr(0x3fda80), dsp)
    w(cfg + 0x40, '<HHHH', 0, 0, 1, 1)          # v0x3fda43: create bumps +0x44/+0x46, not +0x40/+0x42
    return dsp


def chain(scene, outdir):
    os.makedirs(outdir, exist_ok=True)
    if 'reverb' not in scene:
        raise SystemExit('scene has no reverb setting: write it again with prx-scene.ts')
    rdsp, hdsp = make_reverb(), make_hammer()
    block = int(os.environ.get('READ', 1024))
    if block % 256:
        raise SystemExit('READ must be a multiple of 256')
    mid, out = img.alloc(block * 16, 64), img.alloc(block * 16, 64)

    def step(src, n):
        for fn, dsp, a, b in ((REVERB_READ, rdsp, src, mid), (HAMMER_READ, hdsp, mid, out)):
            rc = img.call(fn, dsp, a, b, n, 4, 4)[0] & 0xffffffff
            if rc:
                raise SystemExit('read returned %d' % rc)

    silence = img.alloc(block * 16, 64)
    for _ in range(0, int(os.environ.get('WARM', 0)), block):
        step(silence, block)
    apply_preset(rdsp, scene['reverb'])
    with open(os.path.join(outdir, 'prx-reverb.f32'), 'wb') as fr, \
            open(os.path.join(outdir, 'prx-hammer.f32'), 'wb') as fh:
        reapply = int(os.environ.get('REAPPLY', 0))
        done = [0]

        def tap(src, n):
            if reapply and done[0] and done[0] % reapply == 0:
                apply_preset(rdsp, scene['reverb'])
            done[0] += n
            step(src, n)
            fr.write(img.read(mid, n * 16))
            fh.write(img.read(out, n * 16))
        prxsynth.run(scene, os.path.join(outdir, 'prx.f32'), tap=tap)
    print('  then fmodsmsreverb.prx (setting %d) and fmodsmswavehammer.prx' % scene['reverb'])


if __name__ == '__main__':
    mark = img.cursor
    for src, dst in prxsynth.pairs(sys.argv[1:]):
        img.cursor = mark
        sc = json.load(open(src))
        assert sc['rand'] == 0x13333333
        try:
            chain(sc, dst)
        except SystemExit as e:
            print('FAILED', src, e)
