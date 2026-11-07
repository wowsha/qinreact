import { useCallback, useEffect, useRef, useState } from 'react';
import { Pak } from './engine/pak';
import { Assets } from './engine/assets';
import { Game } from './engine/game';

type Phase = 'drop' | 'loading' | 'game';

export default function App() {
  const [phase, setPhase] = useState<Phase>('drop');
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [info, setInfo] = useState('');
  const glRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const assetsRef = useRef<Assets | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadFile = useCallback(async (file: File) => {
    setError('');
    setPhase('loading');
    setInfo(`Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
    try {
      const buf = await file.arrayBuffer();
      const pak = new Pak(buf);
      setInfo(`Parsed PAK directory: ${pak.entries.size} files`);
      console.log(`[quake] PAK parsed: ${pak.entries.size} files`);
      const assets = new Assets(pak);
      const missing = assets.validate();
      if (missing.length) throw new Error('This PAK is missing: ' + missing.join(', '));
      assetsRef.current = assets;
      setPhase('game');
    } catch (e) {
      setError((e as Error).message);
      setPhase('drop');
    }
  }, []);

  // create the game once the canvases are mounted
  useEffect(() => {
    if (phase !== 'game' || !assetsRef.current || !glRef.current || !hudRef.current || !wrapRef.current) return;
    const game = new Game(glRef.current, hudRef.current, assetsRef.current);
    gameRef.current = game;
    (window as unknown as { __game?: Game }).__game = game;
    game.onQuit = () => {
      game.destroy();
      gameRef.current = null;
      setPhase('drop');
    };
    const fit = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      game.resize(r.width, r.height);
    };
    fit();
    game.start();
    const ro = new ResizeObserver(fit);
    ro.observe(wrapRef.current);
    const kd = (e: KeyboardEvent) => {
      if (game.onKeyDown(e)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => game.onKeyUp(e);
    const mm = (e: MouseEvent) => game.onMouseMove(e.movementX, e.movementY);
    const md = (e: MouseEvent) => game.onMouseDown(e.button);
    const mu = (e: MouseEvent) => game.onMouseUp(e.button);
    const wh = (e: WheelEvent) => game.onWheel(e.deltaY);
    const pl = () => game.onPointerLockChange();
    const cm = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('mousemove', mm);
    window.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    window.addEventListener('wheel', wh, { passive: true });
    document.addEventListener('pointerlockchange', pl);
    hudRef.current.addEventListener('contextmenu', cm);
    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mousedown', md);
      window.removeEventListener('mouseup', mu);
      window.removeEventListener('wheel', wh);
      document.removeEventListener('pointerlockchange', pl);
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, [phase]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  };

  if (phase === 'game') {
    return (
      <div ref={wrapRef} className="fixed inset-0 bg-black overflow-hidden select-none">
        <canvas ref={glRef} className="absolute inset-0 w-full h-full" style={{ imageRendering: 'pixelated' }} />
        <canvas ref={hudRef} className="absolute inset-0 w-full h-full" style={{ imageRendering: 'pixelated' }} />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center p-6 text-stone-200"
      style={{ background: 'radial-gradient(ellipse at 50% 30%, #3a2412 0%, #150c06 60%, #070403 100%)' }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="max-w-xl w-full text-center">
        <h1 className="text-5xl font-bold tracking-widest text-amber-500 mb-1" style={{ fontFamily: 'Impact, Haettenschweiler, sans-serif', textShadow: '0 3px 0 #4a2200' }}>
          QUAKE-STYLE ENGINE
        </h1>
        <p className="text-stone-400 mb-8 text-sm">A from-scratch BSP renderer, QuakeC virtual machine and Quake physics, running in your browser.</p>
        <div
          className={`rounded-lg border-2 border-dashed px-8 py-14 transition-colors cursor-pointer ${over ? 'border-amber-400 bg-amber-950/40' : 'border-stone-600 bg-black/30 hover:border-amber-700'}`}
          onClick={() => fileInput.current?.click()}
        >
          {phase === 'loading' ? (
            <div>
              <div className="text-amber-400 text-lg mb-2">Loading…</div>
              <div className="text-stone-400 text-sm">{info}</div>
            </div>
          ) : (
            <>
              <div className="text-2xl text-amber-300 mb-2">Drop <code className="text-amber-200">pak0.pak</code> here</div>
              <div className="text-stone-400 text-sm">…or click to choose the file.<br />Use the Quake shareware <code>id1/pak0.pak</code>. It is parsed locally in your browser and never uploaded.</div>
            </>
          )}
          <input ref={fileInput} type="file" accept=".pak" className="hidden" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
        </div>
        {error && <div className="mt-4 text-red-400 text-sm bg-red-950/40 border border-red-900 rounded p-3">{error}</div>}
        <div className="mt-8 text-xs text-stone-500 leading-relaxed">
          <div className="text-stone-400 mb-1">Controls</div>
          WASD / arrows move · Mouse look · Left click / Ctrl fire · Space / right click jump · 1–8 or wheel weapons · Shift walk · P pause · Esc menu
        </div>
      </div>
    </div>
  );
}
