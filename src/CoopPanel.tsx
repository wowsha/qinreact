import { useEffect, useState } from 'react';
import type { Game } from './engine/game';
import { NetSession, applyDelta } from './engine/net';

// The invite link opens this app with the invite id in its fragment: #join=<id>
const inviteLink = (id: string) => `${window.location.origin}${window.location.pathname}#join=${id}`;
const idFromInput = (text: string) => text.trim().replace(/^.*#join=/, '');

// Co-op setup. The host copies one invite link and sends it to the friend. The friend opens
// it and joins. Nothing has to be typed or pasted back.
export function CoopPanel({ game, onClose, invite }: { game: Game; onClose: () => void; invite?: string }) {
  const [session, setSession] = useState<NetSession | null>(game.net);
  const [mode, setMode] = useState<'host' | 'join' | null>(game.net ? (game.net.role === 'host' ? 'host' : 'join') : null);
  const [id, setId] = useState('');
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState(game.net?.status ?? '');
  const [err, setErr] = useState('');

  const start = (role: 'host' | 'join', joinId?: string) => {
    session?.close();
    const s = new NetSession(role === 'host' ? 'host' : 'client');
    s.onStatus = () => setStatus(s.status);
    if (role === 'host') {
      s.fullSender = () => game.snapshotRaw();
    } else {
      s.onFull = (raw, ent) => {
        game.loadRaw(raw);
        game.setViewEnt(ent);
      };
      s.onDelta = (m) => {
        if (game.sv) applyDelta(game.sv, m);
      };
    }
    game.net = s;
    setSession(s);
    setMode(role);
    setId('');
    setPaste('');
    setErr('');
    setStatus(s.status);
    if (role === 'join' && joinId) {
      s.join(joinId).catch((e) => setErr(e instanceof Error ? e.message : 'Could not join.'));
    }
    return s;
  };

  // Opened from an invite link: join straight away.
  useEffect(() => {
    if (invite && !game.net) start('join', invite);
    // Runs once, when the panel opens from a link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = async (fn: () => Promise<void>) => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => undefined);
  const btn = 'px-3 py-2 rounded bg-amber-700 hover:bg-amber-600 text-amber-50 text-sm disabled:opacity-40';
  const area = 'w-full p-2 rounded bg-stone-950 border border-stone-700 text-xs font-mono text-stone-200';

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-stone-900 text-stone-200 rounded-lg border border-stone-700 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Co-op over the network</h2>
          <button className="text-stone-400 hover:text-stone-200 text-sm" onClick={onClose}>Close</button>
        </div>
        <p className="text-xs text-stone-400">
          Both players need the same pak0.pak. The two browsers find each other through a matchmaking server (PeerJS), then play directly.
        </p>

        {!mode && (
          <div className="flex gap-3">
            <button className={btn} onClick={() => guard(async () => {
              if (game.state !== 'playing') throw new Error('Start a game first.');
              const s = start('host');
              setId(await s.createInvite());
            })}>Host a game</button>
            <button className={btn} onClick={() => start('join')}>Join a game</button>
          </div>
        )}

        {mode === 'host' && session && (
          <div className="space-y-3">
            {id ? (
              <>
                <button className={btn} onClick={() => copy(inviteLink(id))}>Copy invite link</button>
                <p className="text-xs text-stone-400">Send the link to your friend. Keep this window open until they connect.</p>
              </>
            ) : (
              <p className="text-sm">Starting the invite…</p>
            )}
          </div>
        )}

        {mode === 'join' && session && !session.conn && (
          <div className="space-y-3">
            <p className="text-sm">Paste the invite link from the host.</p>
            <textarea className={area} rows={3} placeholder="Paste the invite link" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className={btn} disabled={!paste.trim()} onClick={() => guard(() => session.join(idFromInput(paste)))}>Join</button>
          </div>
        )}

        {status && <p className="text-sm text-amber-200">{status}</p>}
        {err && <p className="text-sm text-red-400">{err}</p>}

        {session && (
          <button className="text-xs text-stone-400 hover:text-stone-200 underline" onClick={() => {
            session.close();
            game.net = null;
            setSession(null);
            setMode(null);
            setId('');
            setStatus('Left the co-op session.');
          }}>Leave session</button>
        )}
      </div>
    </div>
  );
}
