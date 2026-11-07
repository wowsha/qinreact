// QuakeC builtin functions, registered by name (as found in the progs function table).
import type { Server, Trace } from './server';
import { angleVectors, MOVE_NORMAL, MOVE_NOMONSTERS, FL, SOLID, STEPSIZE } from './server';
import { CONTENTS_EMPTY, CONTENTS_SOLID } from './bsp';
import type { Progs } from './progs';

const R2D = 180 / Math.PI;

export function anglemod(a: number) {
  return (360 / 65536) * ((a * (65536 / 360)) & 65535);
}

function fmtF(v: number, w: number, d: number) {
  return v.toFixed(d).padStart(w, ' ');
}

export function installBuiltins(sv: Server) {
  const vm = sv.vm;
  const B = (name: string, fn: (vm: Progs) => void) => vm.builtinsByName.set(name, fn);
  const self = () => vm.gI[sv.G.self];

  // ---- message stream emitted by QC Write* builtins ----
  const msg: (number | string)[] = [];
  const tempLen = (t: number) => {
    if (t === 5 || t === 6 || t === 9 || t === 13) return 9;
    if (t === 12) return 7;
    return 5;
  };
  const pump = () => {
    for (;;) {
      if (!msg.length) return;
      const c = msg[0] as number;
      let need = 1;
      if (c === 23) {
        if (msg.length < 2) return;
        need = tempLen(msg[1] as number);
      } else if (c === 31 || c === 26) need = 2;
      else if (c === 32) need = 3;
      if (msg.length < need) return;
      const a = msg.slice(0, need);
      msg.splice(0, need);
      switch (c) {
        case 23: sv.ev.temp?.(a[1] as number, a.slice(2) as number[]); break;
        case 26: sv.ev.centerprint?.(a[1] as string); break;
        case 27: sv.ev.killedMonster?.(); break;
        case 28: sv.ev.foundSecret?.(); break;
        case 30: sv.intermission = true; sv.ev.intermission?.(); break;
        case 31: sv.intermission = true; sv.ev.finale?.(a[1] as string); break;
        case 32: sv.ev.cdtrack?.(a[1] as number, a[2] as number); break;
        case 33: sv.ev.sellscreen?.(); break;
      }
    }
  };
  const W = (name: string, conv: (v: number) => number = (v) => v) =>
    B(name, (v) => {
      msg.push(conv(v.fparm(1)));
      pump();
    });
  W('WriteByte', (v) => v & 255);
  W('WriteChar');
  W('WriteShort');
  W('WriteLong');
  W('WriteCoord');
  W('WriteAngle');
  B('WriteEntity', (v) => {
    msg.push(v.iparm(1));
    pump();
  });
  B('WriteString', (v) => {
    msg.push(v.sparm(1));
    pump();
  });

  // ---- math / utility ----
  B('makevectors', (v) => {
    const a = angleVectors(v.vparm(0));
    const set = (n: string, x: number[]) => {
      const o = sv.G[n];
      v.gF[o] = x[0]; v.gF[o + 1] = x[1]; v.gF[o + 2] = x[2];
    };
    set('v_forward', a.forward);
    set('v_right', a.right);
    set('v_up', a.up);
  });
  B('random', (v) => v.retF(Math.random()));
  B('normalize', (v) => {
    const a = v.vparm(0);
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l === 0) v.retV(0, 0, 0);
    else v.retV(a[0] / l, a[1] / l, a[2] / l);
  });
  B('vlen', (v) => {
    const a = v.vparm(0);
    v.retF(Math.hypot(a[0], a[1], a[2]));
  });
  B('vectoyaw', (v) => {
    const a = v.vparm(0);
    let yaw = 0;
    if (a[0] !== 0 || a[1] !== 0) {
      yaw = Math.trunc(Math.atan2(a[1], a[0]) * R2D);
      if (yaw < 0) yaw += 360;
    }
    v.retF(yaw);
  });
  B('vectoangles', (v) => {
    const a = v.vparm(0);
    let yaw: number, pitch: number;
    if (a[0] === 0 && a[1] === 0) {
      yaw = 0;
      pitch = a[2] > 0 ? 90 : 270;
    } else {
      yaw = Math.trunc(Math.atan2(a[1], a[0]) * R2D);
      if (yaw < 0) yaw += 360;
      pitch = Math.trunc(Math.atan2(a[2], Math.hypot(a[0], a[1])) * R2D);
      if (pitch < 0) pitch += 360;
    }
    v.retV(pitch, yaw, 0);
  });
  B('rint', (v) => {
    const f = v.fparm(0);
    v.retF(f > 0 ? Math.floor(f + 0.5) : Math.ceil(f - 0.5));
  });
  B('floor', (v) => v.retF(Math.floor(v.fparm(0))));
  B('ceil', (v) => v.retF(Math.ceil(v.fparm(0))));
  B('fabs', (v) => v.retF(Math.abs(v.fparm(0))));
  B('ftos', (v) => {
    const f = v.fparm(0);
    v.retS(f === Math.trunc(f) ? String(Math.trunc(f)) : fmtF(f, 5, 1));
  });
  B('vtos', (v) => {
    const a = v.vparm(0);
    v.retS(`'${fmtF(a[0], 5, 1)} ${fmtF(a[1], 5, 1)} ${fmtF(a[2], 5, 1)}'`);
  });
  B('cvar', (v) => v.retF(sv.cv(v.sparm(0))));
  B('cvar_set', (v) => {
    sv.cvars[v.sparm(0)] = parseFloat(v.sparm(1)) || 0;
  });
  B('localcmd', (v) => {
    const s = v.sparm(0).trim();
    const m = /^(?:changelevel|map)\s+(\S+)/.exec(s);
    if (m) sv.pendingChange = m[1];
  });
  B('dprint', (v) => console.log('[dprint]', v.sparm(0)));
  // single player: suppress multiplayer join/leave broadcasts
  B('bprint', (v) => { const m = v.sparm(0); if (/(entered|joined) the game/i.test(m)) return; sv.ev.print?.(m); });
  B('sprint', (v) => sv.ev.print?.(v.sparm(1)));
  B('centerprint', (v) => sv.ev.centerprint?.(v.sparm(1)));
  B('stuffcmd', (v) => sv.ev.stuffcmd?.(v.sparm(1)));
  B('error', (v) => v.onError('Program error: ' + v.sparm(0)));
  B('objerror', (v) => {
    console.error('objerror: ' + v.sparm(0));
    sv.freeEdict(self());
  });
  B('break', () => {});
  B('traceon', () => {});
  B('traceoff', () => {});
  B('coredump', () => {});
  B('eprint', () => {});

  // ---- entities ----
  B('spawn', (v) => v.retI(sv.alloc()));
  B('remove', (v) => {
    const e = v.iparm(0);
    if (e === 0) {
      v.onError('Tried to remove the world');
      return;
    }
    sv.freeEdict(e);
  });
  B('nextent', (v) => {
    let i = v.iparm(0);
    for (;;) {
      i++;
      if (i >= sv.numEdicts) return v.retI(0);
      if (!sv.free[i]) return v.retI(i);
    }
  });
  B('find', (v) => {
    let e = v.iparm(0);
    const ofs = v.iparm(1);
    const s = v.sparm(2);
    for (e++; e < sv.numEdicts; e++) {
      if (sv.free[e]) continue;
      const t = v.evI[e * sv.nf + ofs];
      if (!t) continue;
      if (v.str(t) === s) return v.retI(e);
    }
    v.retI(0);
  });
  B('findradius', (v) => {
    const org = v.vparm(0);
    const rad = v.fparm(1);
    let chain = 0;
    for (let e = 1; e < sv.numEdicts; e++) {
      if (sv.free[e]) continue;
      if (sv.fget(e, 'solid') === SOLID.NOT) continue;
      const c = sv.entityCenter(e);
      if (Math.hypot(org[0] - c[0], org[1] - c[1], org[2] - c[2]) > rad) continue;
      sv.iset(e, 'chain', chain);
      chain = e;
    }
    v.retI(chain);
  });
  B('setorigin', (v) => {
    const e = v.iparm(0);
    sv.vset(e, 'origin', v.vparm(1));
    sv.linkEdict(e, false);
  });
  const setMinMax = (e: number, mn: number[], mx: number[]) => {
    sv.vset(e, 'mins', mn);
    sv.vset(e, 'maxs', mx);
    sv.vset(e, 'size', [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]);
    sv.linkEdict(e, false);
  };
  B('setsize', (v) => setMinMax(v.iparm(0), v.vparm(1), v.vparm(2)));
  B('setmodel', (v) => {
    const e = v.iparm(0);
    const name = v.sparm(1);
    const idx = sv.models.indexOf(name);
    if (idx < 0) {
      v.onError('no precache: ' + name);
      return;
    }
    sv.iset(e, 'model', v.iparm(1));
    sv.fset(e, 'modelindex', idx);
    const bm = sv.modelBsp[idx];
    if (bm) setMinMax(e, bm.mins, bm.maxs);
    else if (name.endsWith('.mdl')) setMinMax(e, [-16, -16, -16], [16, 16, 16]);
    else setMinMax(e, [0, 0, 0], [0, 0, 0]);
  });
  B('precache_sound', (v) => {
    sv.precacheSound(v.sparm(0));
    v.retI(v.iparm(0));
  });
  B('precache_model', (v) => {
    sv.precacheModel(v.sparm(0));
    v.retI(v.iparm(0));
  });
  B('precache_file', (v) => v.retI(v.iparm(0)));
  B('precache_sound2', (v) => sv.precacheSound(v.sparm(0)));
  B('precache_model2', (v) => sv.precacheModel(v.sparm(0)));
  B('precache_file2', () => {});
  B('lightstyle', (v) => {
    const i = v.fparm(0) | 0;
    const s = v.sparm(1);
    sv.lightstyles[i] = s;
    sv.ev.lightstyle?.(i, s);
  });
  B('makestatic', (v) => {
    const e = v.iparm(0);
    sv.ev.makeStatic?.({
      model: sv.str(e, 'model'),
      frame: sv.fget(e, 'frame'),
      skin: sv.fget(e, 'skin'),
      origin: sv.vget(e, 'origin'),
      angles: sv.vget(e, 'angles'),
      effects: sv.fget(e, 'effects'),
    });
    sv.freeEdict(e);
  });
  B('changelevel', (v) => {
    if (sv.changelevelIssued) return;
    sv.changelevelIssued = true;
    sv.pendingChange = v.sparm(0);
  });
  B('setspawnparms', (v) => {
    for (let i = 0; i < 16; i++) v.gF[sv.G.parm1 + i] = sv.spawnParms[i];
  });
  B('ambientsound', (v) => {
    sv.ev.ambient?.(v.vparm(0), v.sparm(1), v.fparm(2), v.fparm(3));
  });
  B('sound', (v) => {
    const e = v.iparm(0);
    sv.ev.sound?.(e, v.fparm(1) | 0, v.sparm(2), v.fparm(3) * 255, v.fparm(4), sv.entityCenter(e));
  });
  B('particle', (v) => sv.ev.particle?.(v.vparm(0), v.vparm(1), v.fparm(2), v.fparm(3)));
  B('pointcontents', (v) => v.retF(sv.pointContents(v.vparm(0))));

  const setTrace = (tr: Trace) => {
    const g = sv.G;
    vm.gF[g.trace_allsolid] = tr.allsolid ? 1 : 0;
    vm.gF[g.trace_startsolid] = tr.startsolid ? 1 : 0;
    vm.gF[g.trace_fraction] = tr.fraction;
    vm.gF[g.trace_inwater] = tr.inwater ? 1 : 0;
    vm.gF[g.trace_inopen] = tr.inopen ? 1 : 0;
    for (let i = 0; i < 3; i++) {
      vm.gF[g.trace_endpos + i] = tr.endpos[i];
      vm.gF[g.trace_plane_normal + i] = tr.normal[i];
    }
    vm.gF[g.trace_plane_dist] = tr.planeDist;
    vm.gI[g.trace_ent] = tr.ent >= 0 ? tr.ent : 0;
  };
  B('traceline', (v) => {
    const tr = sv.move(v.vparm(0), [0, 0, 0], [0, 0, 0], v.vparm(1), v.fparm(2) | 0, v.iparm(3));
    setTrace(tr);
  });

  B('checkclient', (v) => {
    if (sv.time - sv.lastCheckTime >= 0.1 || !sv.checkPvs) {
      sv.lastCheckTime = sv.time;
      const o = sv.vget(1, 'origin'), vo = sv.vget(1, 'view_ofs');
      const leaf = sv.bsp.leafForPoint(o[0] + vo[0], o[1] + vo[1], o[2] + vo[2]);
      sv.checkPvs = sv.bsp.decompressVis(leaf);
    }
    if (sv.free[1] || sv.fget(1, 'health') <= 0) return v.retI(0);
    const s = self();
    const o = sv.vget(s, 'origin'), vo = sv.vget(s, 'view_ofs');
    const leaf = sv.bsp.leafForPoint(o[0] + vo[0], o[1] + vo[1], o[2] + vo[2]);
    const l = leaf - 1;
    if (l < 0 || !(sv.checkPvs![l >> 3] & (1 << (l & 7)))) return v.retI(0);
    // PVS alone lets monsters notice the player through walls; require a clear line
    const eye = [o[0] + vo[0], o[1] + vo[1], o[2] + vo[2]];
    const po = sv.vget(1, 'origin'), pvo = sv.vget(1, 'view_ofs');
    const tr: any = sv.move(eye, [0, 0, 0], [0, 0, 0], [po[0] + pvo[0], po[1] + pvo[1], po[2] + pvo[2]], 1, s);
    if (tr.fraction < 1) return v.retI(0);
    v.retI(1);
  });

  // ---- movement helpers ----
  B('droptofloor', (v) => {
    const e = self();
    const o = sv.vget(e, 'origin');
    const tr = sv.move(o, sv.vget(e, 'mins'), sv.vget(e, 'maxs'), [o[0], o[1], o[2] - 256], MOVE_NORMAL, e);
    if (tr.fraction === 1 || tr.allsolid) return v.retF(0);
    sv.vset(e, 'origin', tr.endpos);
    sv.linkEdict(e, false);
    sv.fset(e, 'flags', (sv.fget(e, 'flags') | 0) | FL.ONGROUND);
    sv.iset(e, 'groundentity', tr.ent);
    v.retF(1);
  });

  const checkBottom = (e: number): boolean => {
    const o = sv.vget(e, 'origin'), mn = sv.vget(e, 'mins'), mx = sv.vget(e, 'maxs');
    const mins = [o[0] + mn[0], o[1] + mn[1], o[2] + mn[2]];
    const maxs = [o[0] + mx[0], o[1] + mx[1], o[2] + mx[2]];
    const start = [0, 0, mins[2] - 1];
    let real = false;
    outer: for (let x = 0; x <= 1; x++)
      for (let y = 0; y <= 1; y++) {
        start[0] = x ? maxs[0] : mins[0];
        start[1] = y ? maxs[1] : mins[1];
        if (sv.pointContents(start) !== CONTENTS_SOLID) {
          real = true;
          break outer;
        }
      }
    if (!real) return true;
    start[2] = mins[2];
    start[0] = (mins[0] + maxs[0]) * 0.5;
    start[1] = (mins[1] + maxs[1]) * 0.5;
    const stop = [start[0], start[1], start[2] - 2 * STEPSIZE];
    let tr = sv.move(start, [0, 0, 0], [0, 0, 0], stop, MOVE_NOMONSTERS, e);
    if (tr.fraction === 1) return false;
    const mid = tr.endpos[2];
    let bottom = mid;
    for (let x = 0; x <= 1; x++)
      for (let y = 0; y <= 1; y++) {
        start[0] = stop[0] = x ? maxs[0] : mins[0];
        start[1] = stop[1] = y ? maxs[1] : mins[1];
        tr = sv.move(start, [0, 0, 0], [0, 0, 0], stop, MOVE_NOMONSTERS, e);
        if (tr.fraction !== 1 && tr.endpos[2] > bottom) bottom = tr.endpos[2];
        if (tr.fraction === 1 || mid - tr.endpos[2] > STEPSIZE) return false;
      }
    return true;
  };
  B('checkbottom', (v) => v.retF(checkBottom(v.iparm(0)) ? 1 : 0));

  const moveStep = (e: number, move: number[], relink: boolean): boolean => {
    const oldorg = sv.vget(e, 'origin');
    const mins = sv.vget(e, 'mins'), maxs = sv.vget(e, 'maxs');
    const flags = sv.fget(e, 'flags') | 0;
    if (flags & (FL.SWIM | FL.FLY)) {
      const enemy = sv.iget(e, 'enemy');
      for (let i = 0; i < 2; i++) {
        const neworg = [oldorg[0] + move[0], oldorg[1] + move[1], oldorg[2] + move[2]];
        if (i === 0 && enemy !== 0) {
          const dz = oldorg[2] - sv.vget(enemy, 'origin')[2];
          if (dz > 40) neworg[2] -= 8;
          if (dz < 30) neworg[2] += 8;
        }
        const tr = sv.move(oldorg, mins, maxs, neworg, MOVE_NORMAL, e);
        if (tr.fraction === 1) {
          if (flags & FL.SWIM && sv.pointContents(tr.endpos) === CONTENTS_EMPTY) return false;
          sv.vset(e, 'origin', tr.endpos);
          if (relink) sv.linkEdict(e, true);
          return true;
        }
        if (enemy === 0) break;
      }
      return false;
    }
    const neworg = [oldorg[0] + move[0], oldorg[1] + move[1], oldorg[2] + move[2] + STEPSIZE];
    const end = [neworg[0], neworg[1], neworg[2] - STEPSIZE * 2];
    let tr = sv.move(neworg, mins, maxs, end, MOVE_NORMAL, e);
    if (tr.allsolid) return false;
    if (tr.startsolid) {
      neworg[2] -= STEPSIZE;
      tr = sv.move(neworg, mins, maxs, end, MOVE_NORMAL, e);
      if (tr.allsolid || tr.startsolid) return false;
    }
    if (tr.fraction === 1) {
      if (flags & FL.PARTIALGROUND) {
        sv.vset(e, 'origin', [oldorg[0] + move[0], oldorg[1] + move[1], oldorg[2] + move[2]]);
        if (relink) sv.linkEdict(e, true);
        sv.fset(e, 'flags', (sv.fget(e, 'flags') | 0) & ~FL.ONGROUND);
        return true;
      }
      return false;
    }
    sv.vset(e, 'origin', tr.endpos);
    if (!checkBottom(e)) {
      if (flags & FL.PARTIALGROUND) {
        if (relink) sv.linkEdict(e, true);
        return true;
      }
      sv.vset(e, 'origin', oldorg);
      return false;
    }
    if (flags & FL.PARTIALGROUND) sv.fset(e, 'flags', (sv.fget(e, 'flags') | 0) & ~FL.PARTIALGROUND);
    sv.iset(e, 'groundentity', tr.ent);
    if (relink) sv.linkEdict(e, true);
    return true;
  };

  B('walkmove', (v) => {
    const e = self();
    let yaw = v.fparm(0);
    const dist = v.fparm(1);
    if (!((sv.fget(e, 'flags') | 0) & (FL.ONGROUND | FL.FLY | FL.SWIM))) return v.retF(0);
    yaw = (yaw * Math.PI * 2) / 360;
    const move = [Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0];
    const s0 = vm.gI[sv.G.self];
    const ok = moveStep(e, move, true);
    vm.gI[sv.G.self] = s0;
    v.retF(ok ? 1 : 0);
  });

  const changeYaw = (e: number) => {
    const current = anglemod(sv.vget(e, 'angles')[1]);
    const ideal = sv.fget(e, 'ideal_yaw');
    const speed = sv.fget(e, 'yaw_speed');
    if (current === ideal) return;
    let move = ideal - current;
    if (ideal > current) {
      if (move >= 180) move -= 360;
    } else if (move <= -180) move += 360;
    if (move > 0) {
      if (move > speed) move = speed;
    } else if (move < -speed) move = -speed;
    const a = sv.vget(e, 'angles');
    a[1] = anglemod(current + move);
    sv.vset(e, 'angles', a);
  };
  B('changeyaw', () => changeYaw(self()));
  B('ChangeYaw', () => changeYaw(self()));

  const stepDirection = (e: number, yaw: number, dist: number): boolean => {
    sv.fset(e, 'ideal_yaw', yaw);
    changeYaw(e);
    const r = (yaw * Math.PI * 2) / 360;
    const move = [Math.cos(r) * dist, Math.sin(r) * dist, 0];
    const oldorigin = sv.vget(e, 'origin');
    if (moveStep(e, move, false)) {
      const delta = sv.vget(e, 'angles')[1] - sv.fget(e, 'ideal_yaw');
      if (delta > 45 && delta < 315) sv.vset(e, 'origin', oldorigin);
      sv.linkEdict(e, true);
      return true;
    }
    sv.linkEdict(e, true);
    return false;
  };
  const NODIR = -1;
  const newChaseDir = (actor: number, goal: number, dist: number) => {
    const olddir = anglemod(Math.trunc(sv.fget(actor, 'ideal_yaw') / 45) * 45);
    const turnaround = anglemod(olddir - 180);
    const ao = sv.vget(actor, 'origin'), go = sv.vget(goal, 'origin');
    const dx = go[0] - ao[0], dy = go[1] - ao[1];
    const d = [0, NODIR, NODIR];
    d[1] = dx > 10 ? 0 : dx < -10 ? 180 : NODIR;
    d[2] = dy < -10 ? 270 : dy > 10 ? 90 : NODIR;
    let tdir: number;
    if (d[1] !== NODIR && d[2] !== NODIR) {
      if (d[1] === 0) tdir = d[2] === 90 ? 45 : 315;
      else tdir = d[2] === 90 ? 135 : 215;
      if (tdir !== turnaround && stepDirection(actor, tdir, dist)) return;
    }
    if ((Math.random() * 4) & 1 || Math.abs(dy) > Math.abs(dx)) {
      tdir = d[1];
      d[1] = d[2];
      d[2] = tdir;
    }
    if (d[1] !== NODIR && d[1] !== turnaround && stepDirection(actor, d[1], dist)) return;
    if (d[2] !== NODIR && d[2] !== turnaround && stepDirection(actor, d[2], dist)) return;
    if (olddir !== NODIR && stepDirection(actor, olddir, dist)) return;
    if (Math.random() < 0.5) {
      for (tdir = 0; tdir <= 315; tdir += 45) if (tdir !== turnaround && stepDirection(actor, tdir, dist)) return;
    } else {
      for (tdir = 315; tdir >= 0; tdir -= 45) if (tdir !== turnaround && stepDirection(actor, tdir, dist)) return;
    }
    if (turnaround !== NODIR && stepDirection(actor, turnaround, dist)) return;
    sv.fset(actor, 'ideal_yaw', olddir);
    if (!checkBottom(actor)) sv.fset(actor, 'flags', (sv.fget(actor, 'flags') | 0) | FL.PARTIALGROUND);
  };
  const closeEnough = (e: number, goal: number, dist: number) => {
    const amin = sv.vget(e, 'absmin'), amax = sv.vget(e, 'absmax');
    const gmin = sv.vget(goal, 'absmin'), gmax = sv.vget(goal, 'absmax');
    for (let i = 0; i < 3; i++) {
      if (gmin[i] > amax[i] + dist) return false;
      if (gmax[i] < amin[i] - dist) return false;
    }
    return true;
  };
  B('movetogoal', (v) => {
    const e = self();
    const goal = sv.iget(e, 'goalentity');
    const dist = v.fparm(0);
    if (!((sv.fget(e, 'flags') | 0) & (FL.ONGROUND | FL.FLY | FL.SWIM))) return v.retF(0);
    const enemy = sv.iget(e, 'enemy');
    if (enemy !== 0 && closeEnough(e, goal, dist)) return;
    if (((Math.random() * 4) | 0) === 1 || !stepDirection(e, sv.fget(e, 'ideal_yaw'), dist)) newChaseDir(e, goal, dist);
    vm.gI[sv.G.self] = e;
  });

  B('aim', (v) => {
    const e = v.iparm(0);
    const o = sv.vget(e, 'origin');
    const start = [o[0], o[1], o[2] + 20];
    const f = sv.G.v_forward;
    const dir = [v.gF[f], v.gF[f + 1], v.gF[f + 2]];
    const end = [start[0] + 2048 * dir[0], start[1] + 2048 * dir[1], start[2] + 2048 * dir[2]];
    let tr = sv.move(start, [0, 0, 0], [0, 0, 0], end, MOVE_NORMAL, e);
    if (tr.ent >= 0 && sv.fget(tr.ent, 'takedamage') === 2 && (!sv.cv('teamplay') || sv.fget(e, 'team') <= 0 || sv.fget(e, 'team') !== sv.fget(tr.ent, 'team'))) {
      return v.retV(dir[0], dir[1], dir[2]);
    }
    let bestdist = sv.cv('sv_aim');
    let bestent = -1;
    for (let i = 1; i < sv.numEdicts; i++) {
      if (sv.free[i] || i === e) continue;
      if (sv.fget(i, 'takedamage') !== 2) continue;
      if (sv.cv('teamplay') && sv.fget(e, 'team') > 0 && sv.fget(e, 'team') === sv.fget(i, 'team')) continue;
      const c = sv.entityCenter(i);
      let d = [c[0] - start[0], c[1] - start[1], c[2] - start[2]];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      d = [d[0] / l, d[1] / l, d[2] / l];
      const dist = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
      if (dist < bestdist) continue;
      tr = sv.move(start, [0, 0, 0], [0, 0, 0], c, MOVE_NOMONSTERS, e);
      if (tr.ent === i) {
        bestdist = dist;
        bestent = i;
      }
    }
    if (bestent >= 0) {
      const bo = sv.vget(bestent, 'origin');
      const d = [bo[0] - o[0], bo[1] - o[1], bo[2] - o[2]];
      const dist = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
      const r = [dir[0] * dist, dir[1] * dist, d[2]];
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      v.retV(r[0] / l, r[1] / l, r[2] / l);
    } else v.retV(dir[0], dir[1], dir[2]);
  });
}
