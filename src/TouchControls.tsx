import { useRef, useState } from 'react';
import type { PointerEvent as PE } from 'react';
import type { Game } from './engine/game';

// On-screen controls for phones and tablets. They send the same events the keyboard
// and mouse send, so the game logic is unchanged.
const sendKey = (game: Game, code: string, down: boolean) => {
  const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code });
  if (down) game.onKeyDown(ev);
  else game.onKeyUp(ev);
};
const tapKey = (game: Game, code: string) => {
  sendKey(game, code, true);
  setTimeout(() => sendKey(game, code, false), 60);
};

// Pointer capture keeps a drag alive off the element; it can throw for synthetic pointers.
const capture = (e: PE<HTMLDivElement>) => {
  try {
    capture(e);
  } catch {
    /* not capturable: the drag just ends when the finger leaves the element */
  }
};

const STICK_R = 56;
const btn = 'pointer-events-auto absolute flex items-center justify-center rounded-full border border-amber-200/40 bg-stone-900/60 text-amber-100 text-xs font-bold select-none touch-none';

export function TouchControls({ game }: { game: Game }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const stick = useRef<{ id: number; cx: number; cy: number; held: Set<string> } | null>(null);
  const look = useRef<{ id: number; x: number; y: number } | null>(null);

  // Left thumb: movement (WASD).
  const stickDown = (e: PE<HTMLDivElement>) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    capture(e);
    stick.current = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2, held: new Set() };
  };
  const stickMove = (e: PE<HTMLDivElement>) => {
    const s = stick.current;
    if (!s || s.id !== e.pointerId) return;
    let dx = e.clientX - s.cx, dy = e.clientY - s.cy;
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
  const stickEnd = (e: PE<HTMLDivElement>) => {
    const s = stick.current;
    if (!s || s.id !== e.pointerId) return;
    for (const c of s.held) sendKey(game, c, false);
    stick.current = null;
    setKnob({ x: 0, y: 0 });
  };

  // Right side of the screen: drag to look around.
  const lookDown = (e: PE<HTMLDivElement>) => {
    capture(e);
    look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const lookMove = (e: PE<HTMLDivElement>) => {
    const l = look.current;
    if (!l || l.id !== e.pointerId) return;
    game.onMouseMove((e.clientX - l.x) * 1.5, (e.clientY - l.y) * 1.5);
    l.x = e.clientX;
    l.y = e.clientY;
  };
  const lookEnd = (e: PE<HTMLDivElement>) => {
    if (look.current?.id === e.pointerId) look.current = null;
  };

  // Buttons that are held while the finger is down.
  const hold = (down: () => void, up: () => void) => ({
    onPointerDown: (e: PE<HTMLDivElement>) => { e.preventDefault(); capture(e); down(); },
    onPointerUp: () => up(),
    onPointerCancel: () => up(),
  });
  const tap = (fn: () => void) => ({
    onPointerDown: (e: PE<HTMLDivElement>) => { e.preventDefault(); fn(); },
  });

  return (
    <div className="absolute inset-0 pointer-events-none touch-none z-10" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {/* look zone: right half, under the buttons */}
      <div
        className="pointer-events-auto absolute top-0 bottom-0 right-0 w-1/2 touch-none"
        onPointerDown={lookDown}
        onPointerMove={lookMove}
        onPointerUp={lookEnd}
        onPointerCancel={lookEnd}
      />

      {/* movement stick */}
      <div
        className={`${btn} left-5 w-36 h-36 bg-stone-900/40`}
        style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}
        onPointerDown={stickDown}
        onPointerMove={stickMove}
        onPointerUp={stickEnd}
        onPointerCancel={stickEnd}
      >
        <div
          className="w-14 h-14 rounded-full bg-amber-200/50 border border-amber-100/60 pointer-events-none"
          style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
        />
      </div>

      {/* fire */}
      <div
        className={`${btn} w-24 h-24 bg-red-900/70`}
        style={{ right: '1.5rem', bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}
        {...hold(() => game.onMouseDown(0), () => game.onMouseUp(0))}
      >
        FIRE
      </div>

      {/* jump */}
      <div
        className={`${btn} w-16 h-16`}
        style={{ right: '8.5rem', bottom: 'calc(7.5rem + env(safe-area-inset-bottom))' }}
        {...hold(() => sendKey(game, 'Space', true), () => sendKey(game, 'Space', false))}
      >
        JUMP
      </div>

      {/* weapons */}
      <div className={`${btn} w-14 h-14`} style={{ right: '1.5rem', top: 'calc(1rem + env(safe-area-inset-top))' }} {...tap(() => game.onWheel(-1))}>
        NEXT
      </div>
      <div className={`${btn} w-14 h-14`} style={{ right: '5rem', top: 'calc(1rem + env(safe-area-inset-top))' }} {...tap(() => game.onWheel(1))}>
        PREV
      </div>

      {/* menu pad */}
      <div className="absolute left-4 flex gap-2" style={{ top: 'calc(1rem + env(safe-area-inset-top))' }}>
        <div className={`${btn} static w-12 h-12`} {...tap(() => tapKey(game, 'Escape'))}>ESC</div>
        <div className={`${btn} static w-12 h-12`} {...tap(() => tapKey(game, 'ArrowUp'))}>▲</div>
        <div className={`${btn} static w-12 h-12`} {...tap(() => tapKey(game, 'ArrowDown'))}>▼</div>
        <div className={`${btn} static w-12 h-12`} {...tap(() => tapKey(game, 'Enter'))}>OK</div>
      </div>
    </div>
  );
}
