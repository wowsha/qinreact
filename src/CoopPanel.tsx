import { useEffect, useState } from 'react';
import type { Game } from './engine/game';
import { NetSession, applyDelta } from './engine/net';

// The invite link opens this app with the invite code in its fragment: #join=<code>
const inviteLink = (code: string) => `${window.location.origin}${window.location.pathname}#join=${code}`;

// Co-op setup. The host sends an invite link; the friend opens it and copies an answer
// back; the host pastes the answer to connect. Nobody types the codes.
export function CoopPanel({ game, onClose, invite }: { game: Game; onClose: () => void; invite?: string }) {
  const [session, setSession] = useState<NetSession | null>(game.net);
  const [mode, setMode] = useState<'host' | 'join' | null>(game.net ? (game.net.role === 'host' ? 'host' : 'join') : null);
  const [code, setCode] = useState('');
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState(game.net?.status ?? '');
  const [err, setErr] = useState('');

  const start = (role: 'host' | 'join', joinInvite?: string) => {
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
    setCode('');
    setPaste(joinInvite ?? '');
    setErr('');
    setStatus(s.status);
    if (role === 'join' && joinInvite) {
      s.createAnswer(joinInvite)
        .then((answer) => setCode(answer))
        .catch((e) => setErr(e instanceof Error ? e.message : 'That invite did not work.'));
    }
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
      setErr(e instanceof Error ? e.message : 'That code did not work.');
    }
  };

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => undefined);
  const btn = 'px-3 py-2 rounded bg-amber-700 hover:bg-amber-600 text-amber-50 text-sm disabled:opacity-40';
  const area = 'w-full h-24 p-2 rounded bg-stone-950 border border-stone-700 text-xs font-mono text-stone-200';

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-stone-900 text-stone-200 rounded-lg border border-stone-700 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Co-op over the network</h2>
          <button className="text-stone-400 hover:text-stone-200 text-sm" onClick={onClose}>Close</button>
        </div>
        <p className="text-xs text-stone-400">
          Both players need the same pak0.pak. Connections go directly between the two browsers, so they must be on the same network, or on networks that can reach each other.
        </p>

        {!mode && (
          <div className="flex gap-3">
            <button className={btn} onClick={() => start('host')}>Host a game</button>
            <button className={btn} onClick={() => start('join')}>Join a game</button>
          </div>
        )}

        {mode === 'host' && session && (
          <div className="space-y-3">
            <p className="text-sm">Hosting. Start a map first, then create an invite.</p>
            <button className={btn} onClick={() => guard(async () => {
              if (game.state !== 'playing') throw new Error('Start a game first.');
              setCode(await session.createInvite());
            })}>Create invite</button>
            {code && (
              <div className="space-y-2">
                <button className={btn} onClick={() => copy(inviteLink(code))}>Copy invite link</button>
                <p className="text-xs text-stone-400">Send the link to your friend. They open it, copy their answer, and send it back.</p>
              </div>
            )}
            <p className="text-sm">Paste the answer from your friend:</p>
            <textarea className={area} placeholder="Paste the answer here" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className={btn} disabled={!paste.trim()} onClick={() => guard(() => session.acceptAnswer(paste))}>Connect</button>
          </div>
        )}

        {mode === 'join' && session && (
          <div className="space-y-3">
            {!code && (
              <>
                <p className="text-sm">Joining. Paste the invite link or code from the host.</p>
                <textarea className={area} placeholder="Paste the invite here" value={paste} onChange={(e) => setPaste(e.target.value)} />
                <button className={btn} disabled={!paste.trim()} onClick={() => guard(async () => {
                  setCode(await session.createAnswer(paste.trim().replace(/^.*#join=/, '')));
                })}>Create answer</button>
              </>
            )}
            {code && (
              <div className="space-y-2">
                <button className={btn} onClick={() => copy(code)}>Copy answer</button>
                <p className="text-xs text-stone-400">Send this answer back to the host. They paste it to connect.</p>
              </div>
            )}
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
            setCode('');
            setStatus('Left the co-op session.');
          }}>Leave session</button>
        )}
      </div>
    </div>
  );
}
