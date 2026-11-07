# Sonnet attempt 2 + merge fixes (not a benchmark result)

Base: Sonnet attempt 2 (correct lighting). Fixes applied by hand after testing.

1. Pickups invisible (fixed in round 2: the item BSP lookup passed `maps/...` to a loader that already adds `maps/` and `.bsp`, so every pickup model was skipped) (health, shells, nails, rockets, cells): the renderer
   skipped entity models ending in `.bsp`. Now `Server.getBspFile()` loads and
   caches the item BSP and `renderer.ts` draws it via `buildModel`.
2. Light around the player: muzzle-flash / light effects were re-added every
   frame with a 20 s lifetime, so they never faded. Lifetime is now 0.1 s,
   refreshed each frame while the effect flag is set (`game.ts`).
3. Armor stays visible after pickup: entities whose `model` string was cleared
   by QuakeC are now skipped in the draw loop (`renderer.ts`).

Not changed: view-weapon height (still attempt 2's value). Test with small
offsets showed the gun is sensitive to this; tune in `game.ts` where
`eye[2] - 1 / 32 + 1` is set.

Not verified in play: fixes 1 and 3 are checked by code and build only.

4. Single player no longer shows "... entered/joined the game" (bprint filter
   in `builtins.ts`). Build check only; not seen on screen.

Open (not fixed yet):
- Water color per map (E1M1): needs a side-by-side look at the water in both
  builds to find the difference.
- Gun animation: attempt 2 drives the weapon pose from server time
  (`sv.time`); attempt 1 uses its own render clock. Not ported yet.
- E1M2: a monster is freed before the button is pressed. Trigger/spawn logic
  not traced yet.
- Pickup text position: attempt 2 draws notifications at x=0 with no scale;
  attempt 1 at x=1 with a scale. Not confirmed on screen.


Round 2 status (checked in a headless browser on E1M1):
- Health and shell brush groups are now created and visible (7 item groups).
- Not yet seen on screen: no screenshot yet shows a pickup clearly. Check in your browser.
- Light around the player: no dynamic lights exist at spawn in E1M1 now. Not yet confirmed against what you saw.
- Still open: monster freed early, pickup text position, water color, gun animation.

Round 3:
- Pickup textures: item BSPs shared the world's texture cache by index, so
  they got the wrong textures. Each BSP file now has its own cache.
  (Code-level fix; not yet checked on screen.)
- Muzzle light: the lifetime used seconds where the code uses milliseconds, so the
  light expired at once and flickered. Now 100 ms, constant radius. Checked headless:
  one light while the effect is on, none 300 ms after it clears.
- Notification text: was placed inside the 4:3 HUD box, so on a wide window it
  started near the middle. Now drawn at the top-left of the full window.
  Checked by dumping the HUD canvas.
- Open: a stray "playerplayer" prefix appears in notifications from startup
  prints. Monster freed early on E1M2, water color, gun animation.

Round 4:
- Muzzle flash lingered: the player's muzzle-flash bit (effects & 2) was never
  cleared after firing, so the light was re-added every frame. The client now
  consumes the bit when it spawns the light, so each shot gives one 100 ms flash.
  Checked headless while holding fire: one 100 ms light per shot, bit cleared.
- Open: the QuakeC logic that should clear the muzzle bit is not doing it in this
  build, so the root cause is still in the VM/progs side. Also open: custom HUD,
  classic HUD opacity, monster freed early on E1M2, water color, gun animation.

## Round 6
- Stray "playerplayer" console text: each print call now ends its own message; unterminated prints no longer run into the next one (game.ts conPrint).
- Minimal (Ironwail-style) HUD added: face, health, armor, ammo icon and count, bottom-anchored. Classic status bar kept as option "HUD Style" in Options (saved as `hud`), and its background is now opaque.
- Notifications drawn at fixed pixel positions (textPx), from earlier rounds.
- Not yet fixed: ambush monsters on E1M2 still move in the first seconds (checkclient LOS did not stop it); gun animation difference not identified; muzzle light root cause is in QuakeC (client-side workaround only).
- Not screenshot-verified in-game in this round; typecheck and build pass.

## Round 7
- Interpolation: entity positions and angles (doors, platforms, monsters, camera) blend between 72 Hz physics ticks instead of stepping (server.ts snapshotPrev/lerpOrigin/lerpAngles).
- Animation: alias models blend from the previous pose to the next over 0.1 s (renderer.ts ALIAS_VS, pos2/nrm2 attributes, mixT uniform).
- Not verified in-game yet; typecheck, build and a server sanity run pass.
