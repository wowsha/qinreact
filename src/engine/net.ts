import type { Server } from './server';

// Peer-to-peer co-op over WebRTC. The host runs the simulation and streams its entity
// memory to the joiner as deltas: only the words that changed since the last update.
// Connection codes are copied by hand, so no signalling server is needed.
// Peers only exchange local (host) addresses, so this works on the same network.
// Set iceServers to a STUN server to connect across different networks.

export type Role = 'host' | 'client';

const RTC_CONFIG: RTCConfiguration = { iceServers: [] };
const PUMP_MS = 50;

// Wait for ICE gathering to finish so the code carries every candidate. Some browsers
// never report 'complete' (gathering can stall), so give up after a short wait and
// send whatever candidates were found.
const ICE_WAIT_MS = 3000;
const waitForIce = (pc: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    const done = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', done);
  });

const encode = (d: RTCSessionDescription) => btoa(JSON.stringify({ type: d.type, sdp: d.sdp }));
const decode = (code: string): RTCSessionDescriptionInit => JSON.parse(atob(code.trim()));

export class NetSession {
  role: Role;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null = null;
  open = false;
  status = '';
  /** Host: returns the full state as JSON (the game's save snapshot). */
  fullSender: (() => string) | null = null;
  /** Joiner: called with the full state, and then with each delta. */
  onFull: ((raw: string) => void) | null = null;
  onDelta: ((m: any) => void) | null = null;
  onStatus: (() => void) | null = null;

  private needFull = false;
  private lastSv: Server | null = null;
  private lastMap = '';
  private lastEv: Int32Array | null = null;
  private lastG: Int32Array | null = null;
  private lastFree: boolean[] = [];
  private lastDyn = 0;
  private lastLs = '';
  private lastPump = 0;

  constructor(role: Role) {
    this.role = role;
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        this.open = false;
        this.setStatus('Connection lost');
      }
    };
  }

  private setStatus(s: string) {
    this.status = s;
    this.onStatus?.();
  }

  private attach(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => {
      this.open = true;
      this.setStatus('Connected');
      if (this.role === 'host') this.needFull = true;
    };
    dc.onclose = () => {
      this.open = false;
      this.setStatus('Disconnected');
    };
    dc.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.k === 'full') this.onFull?.(m.raw);
      else if (m.k === 'd') this.onDelta?.(m);
    };
  }

  // ---- host: create an invite, then accept the joiner's answer
  async createInvite(): Promise<string> {
    this.attach(this.pc.createDataChannel('qinreact'));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    this.setStatus('Invite ready. Send it to your friend, then paste their answer.');
    return encode(this.pc.localDescription!);
  }
  async acceptAnswer(code: string) {
    this.setStatus('Connecting...');
    await this.pc.setRemoteDescription(decode(code));
  }

  // ---- joiner: take the host's invite and create an answer
  async createAnswer(inviteCode: string): Promise<string> {
    this.pc.ondatachannel = (e) => this.attach(e.channel);
    await this.pc.setRemoteDescription(decode(inviteCode));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    this.setStatus('Answer ready. Send it back to the host.');
    return encode(this.pc.localDescription!);
  }

  close() {
    this.open = false;
    this.dc?.close();
    this.pc.close();
  }

  private send(m: unknown) {
    if (this.open && this.dc?.readyState === 'open') this.dc.send(JSON.stringify(m));
  }

  // ---- host: called after each simulation step
  pump(sv: Server) {
    if (this.role !== 'host' || !this.open || !this.fullSender) return;
    const now = performance.now();
    if (!this.needFull && now - this.lastPump < PUMP_MS) return;
    this.lastPump = now;

    if (this.needFull || sv !== this.lastSv || sv.mapName !== this.lastMap) {
      this.needFull = false;
      this.send({ k: 'full', raw: this.fullSender() });
      this.lastSv = sv;
      this.lastMap = sv.mapName;
      this.lastEv = Int32Array.from(sv.vm.evI);
      this.lastG = Int32Array.from(sv.vm.gI);
      this.lastFree = sv.free.map((f: boolean) => !!f);
      this.lastDyn = sv.vm.dynStrings.length;
      this.lastLs = JSON.stringify(sv.lightstyles);
      return;
    }

    const vm = sv.vm;
    const ev: number[] = [];
    const le = this.lastEv!;
    for (let i = 0; i < le.length; i++) {
      const v = vm.evI[i];
      if (v !== le[i]) { ev.push(i, v); le[i] = v; }
    }
    const g: number[] = [];
    const lg = this.lastG!;
    for (let i = 0; i < lg.length; i++) {
      const v = vm.gI[i];
      if (v !== lg[i]) { g.push(i, v); lg[i] = v; }
    }
    const fr: number[] = [];
    for (let i = 0; i < sv.numEdicts; i++) {
      const f = !!sv.free[i];
      if (f !== this.lastFree[i]) { fr.push(i, f ? 1 : 0); this.lastFree[i] = f; }
    }
    const dy = vm.dynStrings.length > this.lastDyn ? vm.dynStrings.slice(this.lastDyn) : [];
    this.lastDyn = vm.dynStrings.length;
    const ls = JSON.stringify(sv.lightstyles);
    const lsChanged = ls !== this.lastLs;
    this.lastLs = ls;
    this.send({ k: 'd', t: sv.time, ne: sv.numEdicts, ev, g, fr, dy, ls: lsChanged ? sv.lightstyles : null });
  }
}

/** Joiner: apply one delta from the host to the local server. */
export function applyDelta(sv: Server, m: any) {
  const vm = sv.vm;
  const ev = m.ev as number[];
  for (let i = 0; i < ev.length; i += 2) vm.evI[ev[i]] = ev[i + 1];
  const g = m.g as number[];
  for (let i = 0; i < g.length; i += 2) vm.gI[g[i]] = g[i + 1];
  const fr = m.fr as number[];
  for (let i = 0; i < fr.length; i += 2) sv.free[fr[i]] = !!fr[i + 1];
  for (const s of m.dy as string[]) vm.dynStrings.push(s);
  if (m.ls) sv.lightstyles = m.ls;
  sv.numEdicts = m.ne;
  sv.time = m.t;
}
