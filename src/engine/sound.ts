// Sound system: parses Quake WAV lumps and plays them with WebAudio using Quake-style distance attenuation.
import type { Pak } from './pak';

interface Chan {
  ent: number;
  chan: number;
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode | null;
  org: number[] | null; // for ambient (updated every frame)
  vol: number;
  attn: number;
}

export class SoundSystem {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  buffers = new Map<string, AudioBuffer | null>();
  chans: Chan[] = [];
  ambients: Chan[] = [];
  volume = 0.7;
  listener = { org: [0, 0, 0], right: [0, -1, 0] };

  constructor(private pak: Pak) {}

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }
  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private decode(name: string): AudioBuffer | null {
    if (this.buffers.has(name)) return this.buffers.get(name)!;
    let out: AudioBuffer | null = null;
    const d = this.pak.get('sound/' + name);
    if (d && this.ctx && d.length > 44) {
      try {
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        let p = 12;
        let rate = 11025, bits = 8, ch = 1;
        let dataOfs = -1, dataLen = 0, loopStart = -1;
        while (p + 8 <= d.length) {
          const id = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
          const sz = dv.getUint32(p + 4, true);
          if (id === 'fmt ') {
            ch = dv.getUint16(p + 10, true);
            rate = dv.getUint32(p + 12, true);
            bits = dv.getUint16(p + 22, true);
          } else if (id === 'data') {
            dataOfs = p + 8;
            dataLen = Math.min(sz, d.length - dataOfs);
          } else if (id === 'cue ') {
            const n = dv.getUint32(p + 8, true);
            if (n > 0) loopStart = dv.getUint32(p + 8 + 4 + 20, true);
          }
          p += 8 + sz + (sz & 1);
        }
        if (dataOfs >= 0) {
          const bps = bits / 8;
          const frames = Math.floor(dataLen / (bps * ch));
          const buf = this.ctx.createBuffer(1, Math.max(frames, 1), rate);
          const arr = buf.getChannelData(0);
          for (let i = 0; i < frames; i++) {
            const o = dataOfs + i * bps * ch;
            arr[i] = bits === 8 ? (d[o] - 128) / 128 : dv.getInt16(o, true) / 32768;
          }
          (buf as any)._loop = loopStart;
          out = buf;
        }
      } catch {
        out = null;
      }
    }
    this.buffers.set(name, out);
    return out;
  }

  private spatial(org: number[] | null, attn: number) {
    if (!org || attn <= 0) return { scale: 1, pan: 0 };
    const l = this.listener;
    const dx = org[0] - l.org[0], dy = org[1] - l.org[1], dz = org[2] - l.org[2];
    const dist = Math.hypot(dx, dy, dz);
    const scale = 1 - (dist * attn) / 1000;
    const dot = dist > 0 ? (dx * l.right[0] + dy * l.right[1] + dz * l.right[2]) / dist : 0;
    return { scale: Math.max(0, scale), pan: dot * 0.7 };
  }

  play(ent: number, chan: number, name: string, vol: number, attn: number, org: number[]) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const buf = this.decode(name);
    if (!buf) return;
    const sp = this.spatial(org, attn);
    if (sp.scale <= 0) return;
    if (chan !== 0) {
      for (const c of this.chans) if (c.ent === ent && c.chan === chan) { try { c.src.stop(); } catch { /* */ } }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = (vol / 255) * sp.scale;
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = sp.pan;
    src.connect(gain);
    if (pan) {
      gain.connect(pan);
      pan.connect(this.master!);
    } else gain.connect(this.master!);
    const c: Chan = { ent, chan, src, gain, pan, org: null, vol, attn };
    this.chans.push(c);
    src.onended = () => {
      this.chans = this.chans.filter((x) => x !== c);
    };
    src.start();
  }

  ambient(org: number[], name: string, vol: number, attn: number) {
    if (!this.ctx) return;
    const buf = this.decode(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const ls = (buf as any)._loop as number;
    if (ls >= 0) src.loopStart = ls / buf.sampleRate;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    src.connect(gain);
    if (pan) {
      gain.connect(pan);
      pan.connect(this.master!);
    } else gain.connect(this.master!);
    src.start();
    this.ambients.push({ ent: 0, chan: 0, src, gain, pan, org: org.slice(), vol: vol * 255, attn });
  }

  clearAmbients() {
    for (const a of this.ambients) { try { a.src.stop(); } catch { /* */ } }
    this.ambients = [];
  }
  stopAll() {
    for (const c of this.chans) { try { c.src.stop(); } catch { /* */ } }
    this.chans = [];
    this.clearAmbients();
  }

  update(org: number[], right: number[]) {
    this.listener.org = org;
    this.listener.right = right;
    for (const a of this.ambients) {
      const sp = this.spatial(a.org, a.attn);
      a.gain.gain.value = (a.vol / 255) * sp.scale;
      if (a.pan) a.pan.pan.value = sp.pan;
    }
  }
}
