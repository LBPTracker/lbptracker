# `@lbptracker/lib`

LittleBigPlanet 3's Music Sequencer as an engine: the sampler, the DSP chain and the render
pipeline. No dependencies, no build step — Node runs the TypeScript directly.

The point of this package is **fidelity**, not a tracker that sounds nice. Every constant in it was
taken out of the game's own bytes — `fmodextinput.prx`, `fmodsmsreverb.prx`,
`fmodsmswavehammer.prx` and the eboot — rather than fitted by ear, and how each was measured is in
`steering/`.

```ts
import { renderProject } from '@lbptracker/lib/render.ts';
import { writeWav } from '@lbptracker/lib/wav.ts';
```

## What is in it

| | |
|---|---|
| `render.ts` | the whole pipeline as one platform-neutral function — the same code renders under Node and in a browser worker, and on 2026-09-02 the two produced the *same file*, 70,704,044 bytes, one SHA-256 |
| `audio/mixer.ts` | voices, resampling, panning, looping, per-voice parameter automation |
| `audio/interpolate.ts`, `audio/mipmap.ts` | the resamplers, including the game's own linear-over-mipmaps |
| `audio/effects.ts` | the echo and the reverb, both read out of the game |
| `audio/compressor.ts` | the SMS WaveHammer, transcribed from the PRX and checked against the module actually running |
| `audio/moog.ts`, `audio/lfo.ts` | the ladder filter and the LFOs |
| `audio/mixer-worklet.ts` | the AudioWorklet shell. ⚠️ Its import graph must stay inside this package — see below |
| `instrument.ts`, `voice.ts` | the `INSb` sampler patch (read by cwlib's `resources/instrument.ts`): slots, key splits, pitch/gain/pan |
| `envelope.ts`, `params.ts`, `polyphony.ts` | ADSR, the parameter tables, the 32-voice pool |
| `scale.ts`, `swing.ts` | the scale quantiser and the step clock, both from `fmodextinput.prx` |
| `fsb.ts`, `ima.ts`, `wav.ts` | FSB4 banks, IMA ADPCM, and 16-bit PCM RIFF |
| `midi.ts`, `smf.ts` | the MIDI bridge, in and out |

## ⚠️ The worklet is the one file with a rule attached

`audio/mixer-worklet.ts` is loaded with `audioWorklet.addModule`, and **a worklet realm has no
import map**: a bare specifier inside its graph fails to resolve, the module never loads, and the
page goes silent with nothing on the main thread to say why. Today the graph is closed inside this
package and the web app bundles it through Vite's `?worker&url`, which resolves everything ahead of
time. If you add an import to that graph, keep it relative.

## Deliberate deviations

Four, each a listening judgement kept one switch away from the measured behaviour: the WaveHammer
compressor is implemented, tested and **disabled by default** (`compressor`); the voice pool frees a
record at the note's written end rather than after its release (`releaseTail`); the stereo fold's
gain is applied but its narrowing is not; and note onsets are sample-accurate where the engine
places them on its 256-frame block. All four, with what would settle each, are in
`steering/open-questions.md`.
