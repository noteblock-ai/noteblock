// WebAudio: decoded once, positional via a panner per voice.
import { BASE } from "../assets";

const NAMES = ["rifle", "scatter", "arc", "boom", "crunch", "reload", "reload2", "hit", "kill", "step0", "step1", "step2", "step3", "step4", "jump", "land", "dash", "pickup", "pad", "shield", "horn", "impact"] as const;
export type SoundName = (typeof NAMES)[number];

class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  buffers = new Map<string, AudioBuffer>();
  volume = 0.7;
  private loading: Promise<void> | null = null;
  listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };
  // sound starts off until the player turns it on
  muted = (() => { try { return localStorage.getItem("blastside.sound") !== "on"; } catch { return true; } })();
  /** paused or tab hidden: silent, without touching the saved mute */
  suspended = false;
  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem("blastside.sound", this.muted ? "off" : "on"); } catch {}
    this.applyGain();
    return this.muted;
  }
  setSuspended(v: boolean) { this.suspended = v; this.applyGain(); }
  private applyGain() {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.muted || this.suspended ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  init() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {}); return this.loading!; }
    try {
      this.ctx = new AudioContext();
    } catch { return Promise.resolve(); }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.loading = Promise.all(
      NAMES.map(async (n) => {
        try {
          const r = await fetch(`${BASE}sfx/${n}.ogg`);
          const ab = await r.arrayBuffer();
          this.buffers.set(n, await this.ctx!.decodeAudioData(ab));
        } catch { /* missing codec etc: stay silent */ }
      }),
    ).then(() => { this.applyGain(); this.startWind(); });
    return this.loading;
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyGain();
  }

  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number) {
    this.listener = { x, y, z, fx, fz };
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      (l as any).setPosition(x, y, z);
      (l as any).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** A quiet wind bed: filtered noise with a slow swell. */
  private startWind() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = last * 0.985 + (Math.random() * 2 - 1) * 0.015; d[i] = last * 3.2; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 520;
    const g = ctx.createGain(); g.gain.value = 0.11;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 0.05;
    lfo.connect(lg); lg.connect(g.gain); lfo.start();
    src.connect(lp); lp.connect(g); g.connect(this.master!);
    src.start();
  }

  /** Play a sound; with `at` it is positional. */
  play(name: SoundName, opts: { at?: [number, number, number]; vol?: number; rate?: number; jitter?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.suspended) return;
    if (ctx.state !== "running") { ctx.resume().catch(() => {}); return; }
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() - 0.5) * (opts.jitter ?? 0.08));
    const g = ctx.createGain();
    g.gain.value = opts.vol ?? 1;
    let node: AudioNode = src;
    node.connect(g);
    if (opts.at) {
      const p = ctx.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 4;
      p.maxDistance = 80;
      p.rolloffFactor = 1.2;
      if (p.positionX) { p.positionX.value = opts.at[0]; p.positionY.value = opts.at[1]; p.positionZ.value = opts.at[2]; }
      else (p as any).setPosition(...opts.at);
      g.connect(p);
      p.connect(this.master!);
    } else {
      g.connect(this.master!);
    }
    src.start();
  }
}

export const audio = new Audio();
