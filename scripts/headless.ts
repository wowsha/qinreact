// Headless smoke test: node --import tsx scripts/headless.ts path/to/pak0.pak [map]
import fs from 'node:fs';
import { Pak } from '../src/engine/pak';
import { Server } from '../src/engine/server';

const file = process.argv[2];
const map = process.argv[3] ?? 'start';
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const pak = new Pak(ab);
const sv = new Server(pak.getBuffer('progs.dat')!, (n) => pak.getBuffer('maps/' + n + '.bsp'));
let errs = 0;
sv.ev.error = (m) => { errs++; if (errs < 10) console.log('ERR', m); };
sv.ev.print = (s) => process.stdout.write('PRINT ' + s);
sv.ev.centerprint = (s) => console.log('CENTER', s);
const builtins = sv.vm.functions.filter((f) => f.first < 0).map((f) => f.name);
console.log('builtins', builtins.length, builtins.filter((n) => !sv.vm.builtinsByName.has(n)).join(','), '(missing above)');
sv.spawnLevel(map);
sv.connectClient(true);
console.log('edicts', sv.numEdicts, 'client origin', sv.vget(1, 'origin'), 'health', sv.fget(1, 'health'), 'movetype', sv.fget(1, 'movetype'));
const cmd = { forward: 0, side: 0, up: 0, buttons: 0, impulse: 0, angles: sv.vget(1, 'angles') as [number, number, number] };
for (let i = 0; i < 72; i++) sv.tick(cmd);
console.log('after 1s', sv.vget(1, 'origin'), 'onground', (sv.fget(1, 'flags') | 0) & 512);
cmd.forward = 400;
for (let i = 0; i < 144; i++) sv.tick(cmd);
console.log('after walking 2s', sv.vget(1, 'origin'), sv.vget(1, 'velocity'));
cmd.buttons = 2;
for (let i = 0; i < 10; i++) sv.tick(cmd);
console.log('jump', sv.vget(1, 'origin'), sv.vget(1, 'velocity'));
cmd.buttons = 0;
for (let i = 0; i < 72 * 20; i++) sv.tick(cmd);
console.log('after 20s', sv.vget(1, 'origin'), 'errors', errs, 'time', sv.time.toFixed(2));
const classes: Record<string, number> = {};
for (let e = 0; e < sv.numEdicts; e++) if (!sv.free[e]) { const c = sv.str(e, 'classname'); classes[c] = (classes[c] || 0) + 1; }
console.log(JSON.stringify(classes));
