import { useEffect, useRef, useState } from 'react';
import type { Game } from './engine/game';

// On-screen controls for phones and tablets. They send the same events the keyboard
// and mouse send, so the game logic is unchanged. Native touch events are used
// (not pointer events) so every finger is tracked by its own identifier.
const sendKey = (game: Game, code: string, down: boolean) => {
  const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code });
  if (down) game.onKeyDown(ev);
  else game.onKeyUp(ev);
};
const tapKey = (game: Game, code: string) => {
  sendKey(game, code, true);
  setTimeout(() => sendKey(game, code, false), 60);
};

const STICK_R = 56;
const btn = 'pointer-events-auto absolute flex items-center justify-center rounded-full border border-amber-200/40 bg-stone-900/60 text-amber-100 text-xs font-bold select-none touch-none';

export function TouchControls({ game }: { game: Game }) {
  const root = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  // Tracked fingers, keyed by touch identifier.
  const stick = useRef<{ id: number; ox: number; oy: number; held: Set<string> } | null>(null);
  const look = useRef<{ id: number; x: number; y: number } | null>(null);
  const holds = useRef(new Map<number, string>());

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const zoneOf = (t: EventTarget | null) =>
      (t as HTMLElement | null)?.closest?.('[data-zone]')?.getAttribute('data-zone') ?? null;

    const taps: Record<string, () => void> = {
      next: () => game.onWheel(-1),
      prev: () => game.onWheel(1),
      esc: () => tapKey(game, 'Escape'),
      up: () => tapKey(game, 'ArrowUp'),
      down: () => tapKey(game, 'ArrowDown'),
      ok: () => tapKey(game, 'Enter'),
    };
    const holdsDef: Record<string, { down: () => void; up: () => void }> = {
      fire: { down: () => game.onMouseDown(0), up: () => game.onMouseUp(0) },
      jump: { down: () => sendKey(game, 'Space', true), up: () => sendKey(game, 'Space', false) },
    };

    const stickMove = (x: number, y: number) => {
      const s = stick.current;
      if (!s) return;
      let dx = x - s.ox, dy = y - s.oy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) { dx = (dx / len) * STICK_R; dy = (dy / len) * STICK_R; }
      setKnob({ x: dx, y: dy });
      const want = new Set<string>();
      if (dy < -STICK_R * 0.35) want.add('KeyW');
      if (dy > STICK_R * 0.35) want.add('KeyS');
      if (dx < -STICK_R * 0.35) want.add('KeyA');
      if (dx > STICK_R * 0.35) want.add('KeyD');
      for (const c of [...s.held]) if (!want.has(c)) { sendKey(game, c, false); s.held.delete(c); }
      for (const c of want) if (!s.held.has(c)) { sendKey(game, c, true); s.held.add(c); }
    };

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        const z = zoneOf(t.target);
        if (z === 'stick' && !stick.current) stick.current = { id: t.identifier, ox: t.clientX, oy: t.clientY, held: new Set() };
        else if (z === 'look' && !look.current) look.current = { id: t.identifier, x: t.clientX, y: t.clientY };
        else if (z && taps[z]) taps[z]();
        else if (z && holdsDef[z]) { holds.current.set(t.identifier, z); holdsDef[z].down(); }
      }
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (stick.current?.id === t.identifier) stickMove(t.clientX, t.clientY);
        else if (look.current?.id === t.identifier) {
          const l = look.current;
          game.onMouseMove((t.clientX - l.x) * 1.5, (t.clientY - l.y) * 1.5);
          l.x = t.clientX;
          l.y = t.clientY;
        }
      }
    };
    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (stick.current?.id === t.identifier) {
          for (const c of stick.current.held) sendKey(game, c, false);
          stick.current = null;
          setKnob({ x: 0, y: 0 });
        }
        if (look.current?.id === t.identifier) look.current = null;
        const h = holds.current.get(t.identifier);
        if (h) { holdsDef[h].up(); holds.current.delete(t.identifier); }
      }
    };
    // Stop the browser from taking over drags (iOS edge swipes, scrolling, pinch zoom).
    const stopGesture = (e: Event) => e.preventDefault();

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    document.addEventListener('gesturestart', stopGesture);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      document.removeEventListener('gesturestart', stopGesture);
    };
  }, [game]);

  return (
    <div ref={root} className="absolute inset-0 pointer-events-none touch-none z-10" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {/* look zone: right half, under the buttons */}
      <div data-zone="look" className="pointer-events-auto absolute top-0 bottom-0 right-0 w-1/2 touch-none" />

      {/* movement stick: a drag is measured from where the finger first touches */}
      <div
        data-zone="stick"
        className={`${btn} left-10 w-36 h-36 bg-stone-900/40`}
        style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}
      >
        <div
          className="w-14 h-14 rounded-full bg-amber-200/50 border border-amber-100/60 pointer-events-none"
          style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
        />
      </div>

      <div data-zone="fire" className={`${btn} w-24 h-24 bg-red-900/70`} style={{ right: '1.5rem', bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
        FIRE
      </div>
      <div data-zone="jump" className={`${btn} w-16 h-16`} style={{ right: '8.5rem', bottom: 'calc(7.5rem + env(safe-area-inset-bottom))' }}>
        JUMP
      </div>

      <div data-zone="next" className={`${btn} w-14 h-14`} style={{ right: '1.5rem', top: 'calc(1rem + env(safe-area-inset-top))' }}>NEXT</div>
      <div data-zone="prev" className={`${btn} w-14 h-14`} style={{ right: '5rem', top: 'calc(1rem + env(safe-area-inset-top))' }}>PREV</div>

      <div className="absolute left-4 flex gap-2" style={{ top: 'calc(1rem + env(safe-area-inset-top))' }}>
        <div data-zone="esc" className={`${btn} static w-12 h-12`}>ESC</div>
        <div data-zone="up" className={`${btn} static w-12 h-12`}>▲</div>
        <div data-zone="down" className={`${btn} static w-12 h-12`}>▼</div>
        <div data-zone="ok" className={`${btn} static w-12 h-12`}>OK</div>
      </div>
    </div>
  );
}
