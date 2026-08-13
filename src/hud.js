// HUD: risograph misregistration numerals + labels.
//
// DOM over the WebGL canvas — no canvas drawing. Reads state.hud.{alt, speed,
// distToTarget, bearingDeg, stalled, failMsg} and paints the numerals as
// stacked blue+pink prints so they read as riso misregistration.
//
// Hot-path rules: no allocations in render; reuse cached span refs; only
// touch textContent when the printed string actually changes.

const refs = {
  alt: { blue: null, pink: null, last: null },
  speed: { blue: null, pink: null, last: null },
  dist: { blue: null, pink: null, last: null },
  bearingTick: null,
  bearingLast: null,
  stall: null,
  stallVisible: false,
  fail: null,
  failLast: null,
};

function pickGlyphs(rootId) {
  const root = document.getElementById(rootId);
  return {
    blue: root.querySelector('.hud-glyph--blue'),
    pink: root.querySelector('.hud-glyph--pink'),
    last: null,
  };
}

function writeNumeral(entry, value) {
  const text = String(value);
  if (entry.last === text) return;
  entry.last = text;
  entry.blue.textContent = text;
  entry.pink.textContent = text;
}

export function init(state) {
  refs.alt = pickGlyphs('hud-alt');
  refs.speed = pickGlyphs('hud-speed');
  refs.dist = pickGlyphs('hud-bearing');
  refs.bearingTick = document.querySelector('#hud-bearing .hud-bearing-tick');
  refs.stall = document.getElementById('hud-stall');
  refs.fail = document.getElementById('hud-fail');

  writeNumeral(refs.alt, 0);
  writeNumeral(refs.speed, 0);
  writeNumeral(refs.dist, 0);
  refs.bearingTick.style.left = '50%';
  refs.stall.style.display = 'none';
  refs.fail.style.display = 'none';
}

// Recompute state.hud from the authoritative plane / level state each step.
// Defensive against tickets 2 and 10 not being wired yet: missing fields
// leave the current state.hud value untouched.
export function update(state, dt) {
  const plane = state.plane;
  const hud = state.hud;

  if (plane) {
    if (plane.position) hud.alt = plane.position.y;
    if (typeof plane.airspeed === 'number') hud.speed = plane.airspeed;
    hud.stalled = !!plane.stalled;
  }

  const target = state.level?.loaded?.target?.pos;
  if (target && plane?.position) {
    const dx = target.x - plane.position.x;
    const dz = target.z - plane.position.z;
    hud.distToTarget = Math.hypot(dx, dz);

    // Relative bearing: angle between the plane's forward heading and the
    // vector to the target, in the horizontal plane, in degrees.
    // Positive = target is to the right of the nose, negative = left.
    const forward = state.scratch.v0.set(0, 0, -1).applyQuaternion(plane.quaternion);
    const fx = forward.x, fz = forward.z;
    const forwardAngle = Math.atan2(fx, -fz);
    const targetAngle = Math.atan2(dx, -dz);
    let rel = targetAngle - forwardAngle;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    hud.bearingDeg = rel * (180 / Math.PI);
  }
}

export function render(state, alpha) {
  const hud = state.hud;

  writeNumeral(refs.alt, Math.max(0, Math.round(hud.alt)));
  writeNumeral(refs.speed, Math.max(0, Math.round(hud.speed)));
  writeNumeral(refs.dist, Math.max(0, Math.round(hud.distToTarget)));

  const clamped = Math.max(-90, Math.min(90, hud.bearingDeg));
  const pct = ((clamped + 90) / 180) * 100;
  if (refs.bearingLast !== pct) {
    refs.bearingLast = pct;
    refs.bearingTick.style.left = pct + '%';
  }

  const shouldShowStall = !!hud.stalled;
  if (shouldShowStall !== refs.stallVisible) {
    refs.stallVisible = shouldShowStall;
    refs.stall.style.display = shouldShowStall ? 'block' : 'none';
  }

  const msg = hud.failMsg || '';
  if (refs.failLast !== msg) {
    refs.failLast = msg;
    refs.fail.textContent = msg;
    refs.fail.style.display = msg ? 'block' : 'none';
  }
}
