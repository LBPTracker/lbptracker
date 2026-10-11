r"""Load the game's PRX modules into this process and call their functions, as oracles.

    prxrun.py selftest        load input + reverb + libc, call libc's exp2f/expf/powf/rand, print

`runhammer.py` did this for one module with its relocations written by hand. This does it for any
of them from the module's own dynamic tables, and resolves each import against the exports of the
other loaded modules -- in practice **the game's own `sce_module/libc.prx`**, so `exp2f`, `expf`,
`powf` and `_FSin` are the console's arithmetic, not the CRT's. What no loaded module exports is
pointed at an `int3`, so an unexpected call crashes loudly instead of returning a plausible number.

    img = Image()
    libc = img.load('libc')
    syn = img.load('input')            # its imports resolve against libc
    ret = img.call(syn.addr(0x170), rdi=..., rsi=..., ...)

## How it works

Every module gets its own slice of one RWX allocation, its PT_LOAD segments copied to
`base + vaddr`, so rip-relative references need no fixing. Then the RELA and JMPREL tables:
`R_X86_64_RELATIVE` (8) is `base + addend`; `R_X86_64_64` (1), `GLOB_DAT` (6) and `JUMP_SLOT` (7)
name a symbol, looked up by NID among every loaded module's exports, then among `overrides`.

⚠️ **The modules are System V and this is Windows.** `call()` goes through a thunk that saves what
Windows treats as callee-saved and System V does not (`rsi`, `rdi`, `xmm6`-`xmm15`), loads up to
six integer and eight vector arguments plus any stack arguments, and keeps `rsp` 16-aligned at the
call. The thunk is disassembled with capstone at load and the listing compared against what it was
meant to be, because a wrong byte here faults somewhere unrelated.
"""
import ctypes
import struct
import sys

import capstone

import prxdis
import prxnid

TOTAL = 0x4000000                       # 64 MiB: libc is ~0xc0000, the rest is room for data
_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)

R_RELATIVE, R_64, R_GLOB_DAT, R_JUMP_SLOT = 8, 1, 6, 7
DT_RELA, DT_RELASZ = 0x6100002F, 0x61000031
DT_JMPREL, DT_PLTRELSZ = 0x61000029, 0x6100002D
DT_SYMTAB, DT_SYMTABSZ, DT_STRTAB = 0x61000039, 0x6100003F, 0x61000035


class Module:
    def __init__(self, image, name, base):
        self.image, self.name, self.base = image, name, base
        self.exports = {}                # NID -> absolute address
        self.unresolved = []

    def addr(self, vaddr):
        return self.image.mem + self.base + vaddr


class Image:
    def __init__(self, size=TOTAL):
        k32 = ctypes.windll.kernel32
        k32.VirtualAlloc.restype = ctypes.c_void_p
        k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_uint32]
        self.mem = k32.VirtualAlloc(None, size, 0x3000, 0x40)
        if not self.mem:
            raise SystemExit('VirtualAlloc failed')
        self.size = size
        self.buf = (ctypes.c_ubyte * size).from_address(self.mem)
        self.cursor = 0x10000            # 0..0x10000 is for thunks and stubs
        self.code = 0
        self.modules = {}
        self.overrides = {}              # raw-name prefix (NID or name) -> absolute address
        self.stubs = {}
        self._trap = self._emit(b'\xCC')
        self.stubs['ret0'] = self._emit(bytes.fromhex('31C0C3'))
        self.canary = self.alloc(16)
        struct.pack_into('<Q', self.buf, self.canary - self.mem, 0xDEADBEEFCAFEF00D)
        self._thunk = self._build_thunk()

    # -- memory -----------------------------------------------------------------
    def _emit(self, code):
        at = self.code
        ctypes.memmove(self.mem + at, code, len(code))
        self.code += (len(code) + 15) & ~15
        return self.mem + at

    def alloc(self, n, align=64):
        self.cursor = (self.cursor + align - 1) & ~(align - 1)
        at = self.cursor
        self.cursor += n
        if self.cursor > self.size:
            raise SystemExit('image full')
        ctypes.memset(self.mem + at, 0, n)
        return self.mem + at

    def write(self, addr, data):
        ctypes.memmove(addr, bytes(data), len(data))

    def read(self, addr, n):
        return ctypes.string_at(addr, n)

    def stub(self, name, code):
        self.stubs[name] = self._emit(code)
        return self.stubs[name]

    # -- loading ----------------------------------------------------------------
    def load(self, name):
        data, segs = prxdis.segments(prxdis.MODULES[name])
        top = max(v + m for v, m, _ in segs)
        base = (self.cursor + 0xFFFF) & ~0xFFFF
        self.cursor = base + top
        mod = Module(self, name, base)
        for vaddr, memsz, off in segs:
            chunk = data[off:off + memsz]
            ctypes.memmove(self.mem + base + vaddr, chunk, len(chunk))
        _data, blob, tags = prxnid.tables(prxdis.MODULES[name])
        strtab, symtab = blob + tags[DT_STRTAB], blob + tags[DT_SYMTAB]

        def sym(i):
            st_name, = struct.unpack_from('<I', data, symtab + i * 24)
            st_value, = struct.unpack_from('<Q', data, symtab + i * 24 + 8)
            p = strtab + st_name
            return data[p:data.index(b'\0', p)].decode('ascii', 'replace'), st_value

        for i in range(tags[DT_SYMTABSZ] // 24):
            raw, value = sym(i)
            if value:
                mod.exports[raw.split('#')[0]] = mod.addr(value)
        self.modules[name] = mod
        mod._relocs = []
        for table, size in ((DT_RELA, DT_RELASZ), (DT_JMPREL, DT_PLTRELSZ)):
            if table not in tags:
                continue
            at = blob + tags[table]
            for j in range(tags[size] // 24):
                r_off, r_info, r_add = struct.unpack_from('<QQq', data, at + j * 24)
                mod._relocs.append((r_off, r_info & 0xFFFFFFFF, r_info >> 32, r_add, sym))
        self._relocate(mod)
        return mod

    def load_eboot(self):
        """Map the eboot too, so its own setup code can be called rather than transcribed.

        Every PT_LOAD at `base + vaddr`, `.bss` left zero; every `R_X86_64_RELATIVE` applied; every
        symbol relocation resolved like a module's -- the libc imports to the game's own libc. Call
        an eboot function as `img.call(eb.addr(0x3fcd50), ...)`. ⚠️ Only leaf-ish code is safe:
        anything reaching the game's allocator, its threads or FMOD's globals finds a world that was
        never initialised.
        """
        import ebconf
        import ebdyn
        data = ebconf.data()
        e_phoff, = struct.unpack_from('<Q', data, 0x20)
        e_phentsize, e_phnum = struct.unpack_from('<HH', data, 0x36)
        segs = []
        for k in range(e_phnum):
            o = e_phoff + k * e_phentsize
            p_type, = struct.unpack_from('<I', data, o)
            p_off, p_vaddr, _, p_filesz, p_memsz = struct.unpack_from('<QQQQQ', data, o + 8)
            if p_type == 1:
                segs.append((p_vaddr, p_memsz, p_off, p_filesz))
        top = max(v + m for v, m, _, _ in segs)
        base = (self.cursor + 0xFFFF) & ~0xFFFF
        self.cursor = base + top
        if self.cursor > self.size:
            raise SystemExit('image too small for the eboot; pass a larger size to Image()')
        mod = Module(self, 'eboot', base)
        for vaddr, _memsz, off, filesz in segs:
            ctypes.memmove(self.mem + base + vaddr, data[off:off + filesz], filesz)
        _d, dl, t, s, _, _ = ebdyn.tables()
        symtab = dl + t['SYMTAB']

        def sym(i):
            st_name, = struct.unpack_from('<I', data, symtab + i * 24)
            return s(st_name), 0

        mod._relocs = []
        for table, size in (('RELA', 'RELASZ'), ('JMPREL', 'PLTRELSZ')):
            at = dl + t[table]
            for j in range(t[size] // 24):
                r_off, r_info, r_add = struct.unpack_from('<QQq', data, at + j * 24)
                mod._relocs.append((r_off, r_info & 0xFFFFFFFF, r_info >> 32, r_add, sym))
        self.modules['eboot'] = mod
        self._relocate(mod)
        return mod

    def resolve(self, raw):
        nid = raw.split('#')[0]
        for key in (raw, nid):
            if key in self.overrides:
                return self.overrides[key]
        for m in self.modules.values():
            if nid in m.exports:
                return m.exports[nid]
        return None

    def _relocate(self, mod):
        """Apply (or re-apply) a module's relocations; call again after changing overrides."""
        mod.unresolved = []
        for r_off, typ, idx, add, sym in mod._relocs:
            at = mod.base + r_off
            if typ == R_RELATIVE:
                struct.pack_into('<Q', self.buf, at, self.mem + mod.base + add)
                continue
            raw, _ = sym(idx)
            target = self.resolve(raw)
            if target is None:
                mod.unresolved.append(raw)
                target = self._trap
            if typ in (R_64, R_GLOB_DAT):
                struct.pack_into('<Q', self.buf, at, target + (add if typ == R_64 else 0))
            elif typ == R_JUMP_SLOT:
                struct.pack_into('<Q', self.buf, at, target)
            elif typ in (16, 17, 18):
                # DTPMOD64 / DTPOFF64 / TPOFF64: thread-local storage. Nothing the DSPs call
                # touches it, and `__tls_get_addr` is a trap, so a zero here cannot pass quietly.
                struct.pack_into('<Q', self.buf, at, 0)
            else:
                raise SystemExit('%s: relocation type %d at %#x' % (mod.name, typ, r_off))

    def relink(self):
        for m in self.modules.values():
            self._relocate(m)

    # -- calling ----------------------------------------------------------------
    def _build_thunk(self):
        """`thunk(ctx)` from Windows into System V. ctx is 0x98 bytes of 8-byte slots:

        0x00 target | 0x08 rdi 0x10 rsi 0x18 rdx 0x20 rcx 0x28 r8 0x30 r9 | 0x38..0x70 xmm0..7 |
        0x78 stack-arg count | 0x80 stack-arg pointer | 0x88 out rax | 0x90 out xmm0
        """
        h = bytes.fromhex
        c = bytearray()
        c += h('55 4889E5 53 57 56 4154 4155 4156 4157'.replace(' ', ''))   # rbp + 7 pushes
        c += h('4881ECA8000000')                                           # sub rsp, 0xa8
        saves = []
        for n in range(6, 16):
            rex = '44' if n >= 8 else ''
            modrm = '%02X' % (0x44 + ((n & 7) << 3))
            saves.append((rex, modrm, (n - 6) * 16))
        for rex, modrm, disp in saves:                                     # movaps [rsp+d], xmmN
            c += h(rex + '0F29' + modrm + '24' + '%02X' % disp) if disp < 0x80 else \
                h(rex + '0F29' + '%02X' % (int(modrm, 16) + 0x40) + '24' + struct.pack('<i', disp).hex())
        c += h('4889CB')                                                   # mov rbx, rcx
        c += h('488B4B78')                                                 # mov rcx, [rbx+0x78]
        c += h('4889C8 4883E001 48C1E003 4829C4'.replace(' ', ''))         # pad rsp if odd count
        c += h('488BB380000000')                                           # mov rsi, [rbx+0x80]
        loop = len(c)
        c += h('4885C9')                                                   # test rcx, rcx
        c += h('7409')                                                     # jz +9
        c += h('FF74CEF8')                                                 # push [rsi+rcx*8-8]
        c += h('48FFC9')                                                   # dec rcx
        c += h('EB') + struct.pack('<b', loop - (len(c) + 2))              # jmp loop
        for n in range(8):                                                 # movsd xmmN, [rbx+0x38+8n]
            c += h('F20F10' + '%02X' % (0x43 + (n << 3)) + '%02X' % (0x38 + 8 * n))
        c += h('488B7B08 488B7310 488B5318 488B4B20 4C8B4328 4C8B4B30'.replace(' ', ''))
        c += h('B808000000')                                               # mov eax, 8
        c += h('FF13')                                                     # call [rbx]
        c += h('48898388000000')                                           # mov [rbx+0x88], rax
        c += h('F20F118390000000')                                         # movsd [rbx+0x90], xmm0
        c += h('488DA520FFFFFF')                                           # lea rsp, [rbp-0xe0]
        for rex, modrm, disp in saves:                                     # movaps xmmN, [rsp+d]
            c += h(rex + '0F28' + modrm + '24' + '%02X' % disp) if disp < 0x80 else \
                h(rex + '0F28' + '%02X' % (int(modrm, 16) + 0x40) + '24' + struct.pack('<i', disp).hex())
        c += h('4881C4A8000000 415F 415E 415D 415C 5E 5F 5B 5D C3'.replace(' ', ''))
        at = self._emit(bytes(c))
        self._check_thunk(at, len(c))
        self._ctx = self.alloc(0x98, 16)
        self._stackargs = self.alloc(8 * 32, 16)
        return ctypes.CFUNCTYPE(None, ctypes.c_void_p)(at)

    def _check_thunk(self, at, n):
        text = [(i.mnemonic, i.op_str) for i in _md.disasm(ctypes.string_at(at, n), 0)]
        want_xmm = ['xmmword ptr [rsp + 0x%x], xmm%d' % ((k - 6) * 16, k) if k > 6 else
                    'xmmword ptr [rsp], xmm6' for k in range(6, 16)]
        got_xmm = [o for m, o in text if m == 'movaps' and o.startswith('xmmword ptr [rsp')]
        if got_xmm != want_xmm:
            raise SystemExit('thunk encodes the xmm saves wrong: %r' % got_xmm)
        loads = [o for m, o in text if m == 'movsd' and o.startswith('xmm')]
        if loads != ['xmm%d, qword ptr [rbx + 0x%x]' % (k, 0x38 + 8 * k) for k in range(8)]:
            raise SystemExit('thunk encodes the vector arguments wrong: %r' % loads)
        if ('call', 'qword ptr [rbx]') not in text or text[-1] != ('ret', ''):
            raise SystemExit('thunk is malformed')

    def call(self, target, *ints, floats=(), stack=()):
        """Call System V `target(ints..., floats...)`; returns `(rax, xmm0 as float, xmm0 as double)`."""
        if len(ints) > 6 or len(floats) > 8 or len(stack) > 32:
            raise SystemExit('too many arguments')
        ctx = bytearray(0x98)
        struct.pack_into('<Q', ctx, 0, target)
        for i, v in enumerate(ints):
            struct.pack_into('<Q', ctx, 8 + 8 * i, v & 0xFFFFFFFFFFFFFFFF)
        for i, v in enumerate(floats):
            if isinstance(v, tuple) and v[0] == 'd':
                struct.pack_into('<d', ctx, 0x38 + 8 * i, v[1])
            else:
                struct.pack_into('<f', ctx, 0x38 + 8 * i, v)
        for i, v in enumerate(stack):
            struct.pack_into('<Q', self.buf, self._stackargs - self.mem + 8 * i, v & 0xFFFFFFFFFFFFFFFF)
        struct.pack_into('<QQ', ctx, 0x78, len(stack), self._stackargs)
        ctypes.memmove(self._ctx, bytes(ctx), 0x98)
        self._thunk(self._ctx)
        out = ctypes.string_at(self._ctx, 0x98)
        if struct.unpack_from('<Q', self.buf, self.canary - self.mem)[0] != 0xDEADBEEFCAFEF00D:
            raise SystemExit('stack canary clobbered')
        rax, = struct.unpack_from('<Q', out, 0x88)
        f, = struct.unpack_from('<f', out, 0x90)
        dbl, = struct.unpack_from('<d', out, 0x90)
        return rax, f, dbl


def standard(rand_constant=None, size=TOTAL):
    """libc, with the few imports libc's math needs nobody, and the stack guard wired.

    `rand_constant`, when given, replaces `rand` with a stub returning it, so a renderer on the
    other side can be driven with the same draws.
    """
    img = Image(size)
    guard = img.canary
    img.overrides['Ou3iL1abvng'] = img.stub('stack_chk_fail', b'\xCC')
    img.overrides['f7uOxY9mM1U'] = guard             # __stack_chk_guard
    for name in ('module_start', 'module_stop', 'H2e8t5ScQGc'):   # __cxa_finalize
        img.overrides[name] = img.stubs['ret0']
    if rand_constant is not None:
        img.overrides['cpCOXWMgha0'] = img.stub('rand', b'\xB8' + struct.pack('<I', rand_constant) + b'\xC3')
    img.load('libc')
    return img


def _selftest():
    img = standard()
    libc = img.modules['libc']
    for name, nid in (('exp2f', 'wuAQt-j+p4o'), ('expf', '8zsu04XNsZ4')):
        for x in (0.0, 0.5, -1.25, 3.0):
            _, f, _ = img.call(libc.exports[nid], floats=(x,))
            print('%s(%g) = %.9g' % (name, x, f))
    _, f, _ = img.call(libc.exports['1D0H2KNjshE'], floats=(10.0, -0.9))
    print('powf(10, -0.9) = %.9g' % f)
    print('rand:', [img.call(libc.exports['cpCOXWMgha0'])[0] for _ in range(3)])
    syn = img.load('input')
    rev = img.load('reverb')
    print('input unresolved:', syn.unresolved, ' reverb unresolved:', rev.unresolved)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'selftest':
        _selftest()
    else:
        raise SystemExit(__doc__)
