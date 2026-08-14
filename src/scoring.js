// Scoring + landing detection + failure states — the seam that turns the
// individually-shipped modules into a game.
//
// Reads: state.plane.{position, prevPosition, velocity}, state.level.{index, loaded},
//        state.input.resetRequested.
// Writes: state.hud.failMsg (also used for the success screen), state.input.resetRequested
//         (consumed back to false), plus level bests via state.level.recordBest.
//
// Hot-path rule: zero allocations per step. All arithmetic below is in-place.

import * as world from './world.js';
import * as audio from './audio.js';
import * as camera from './camera.js';

// Sphere radius the plane uses for the building-collision test. Roughly the
// half-span of the paper plane silhouette so a wingtip clip counts, not just
// a nose punch.
const PLANE_COLLIDE_R = 1.0;

// A touchdown is the frame the plane crosses this altitude. flight.js clamps
// y to 0 on the same step, so `prevPos.y > TOUCHDOWN_Y && pos.y <= TOUCHDOWN_Y`
// is the edge we react to exactly once.
const TOUCHDOWN_Y = 0.1;

// Hard-landing threshold (m/s). |impactVy| above this on touchdown = crash.
const HARD_LANDING_VY = 14;

// Scoring — plan defaults.
const BASE_SCORE = 1000;
const INNER_BONUS = 500;
const TIME_BONUS_PER_SEC = 20;

// Levels wrap after this many.
const LEVEL_COUNT = 3;

// ---- Module state ---------------------------------------------------------

// 'flying' | 'success' | 'failure'. Detection only runs while flying.
let status = 'flying';

// state.time.elapsed when the current level started — the origin for the
// time-bonus calculation. Reset on every level (re)load.
let levelStart = 0;

// The previous step's plane.velocity.y. flight.js runs BEFORE scoring in the
// step order, so on the touchdown frame plane.velocity.y is already the
// clamped 0 — the pre-clamp value we care about is what we saw last frame.
let prevPlaneVy = 0;

// Scratch struct for collideSphere out-normal; we don't use the normal itself
// but the API requires an object.
const _normal = { x: 0, y: 0, z: 0 };

// ---- Module lifecycle -----------------------------------------------------

export function init(state) {
  status = 'flying';
  state.hud.failMsg = '';
  state.input.resetRequested = false;
  levelStart = state.time.elapsed;
  prevPlaneVy = state.plane.velocity.y;
}

export function update(state, dt) {
  // Reset takes precedence over anything else this frame — R while flying
  // reloads the current level too, so the player can bail on a bad run.
  if (state.input.resetRequested) {
    state.input.resetRequested = false;
    const idx = state.level.index ?? 0;
    const next = status === 'success' ? (idx + 1) % LEVEL_COUNT : idx;
    resetToLevel(state, next);
    return;
  }

  if (status !== 'flying') {
    // Still keep prevPlaneVy fresh so a subsequent reset lands in a sane state.
    prevPlaneVy = state.plane.velocity.y;
    return;
  }

  const plane = state.plane;
  const level = state.level.loaded;
  if (!plane || !level) {
    prevPlaneVy = plane.velocity.y;
    return;
  }

  // ---- Out of bounds ------------------------------------------------------
  const b = level.bounds;
  if (b) {
    const p = plane.position;
    if (
      p.x < b.min.x || p.x > b.max.x ||
      p.z < b.min.z || p.z > b.max.z ||
      p.y > b.max.y
    ) {
      setFailure(state, 'Drifted off the map. Press R to retry.');
      prevPlaneVy = plane.velocity.y;
      return;
    }
  }

  // ---- Building collision -------------------------------------------------
  if (world.collideSphere(plane.position, PLANE_COLLIDE_R, _normal)) {
    audio.playCrash?.();
    setFailure(state, 'Clipped a tower. Press R to retry.');
    prevPlaneVy = plane.velocity.y;
    return;
  }

  // ---- Touchdown edge -----------------------------------------------------
  if (plane.prevPosition.y > TOUCHDOWN_Y && plane.position.y <= TOUCHDOWN_Y) {
    // plane.velocity.y is already clamped to 0 by flight.js on the touchdown
    // step; last frame's value is the closest proxy for impact velocity.
    const impactVy = prevPlaneVy;
    handleTouchdown(state, level, impactVy);
    prevPlaneVy = plane.velocity.y;
    return;
  }

  prevPlaneVy = plane.velocity.y;
}

// ---- Touchdown resolution -------------------------------------------------

function handleTouchdown(state, level, impactVy) {
  const plane = state.plane;
  const target = level.target;
  if (!target) return;

  const dx = target.pos.x - plane.position.x;
  const dz = target.pos.z - plane.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // Missed the ring — short (undershot along the launch→target axis) vs wide.
  if (dist > target.outerR) {
    const ax = target.pos.x - level.start.pos.x;
    const az = target.pos.z - level.start.pos.z;
    const axl = Math.sqrt(ax * ax + az * az) || 1;
    const nx = ax / axl;
    const nz = az / axl;
    // Signed distance from target along the launch axis. Negative = the
    // plane is still behind the target (undershoot) → "short". Otherwise the
    // plane made it to or past the ring's plane but is off the ring → "wide".
    const along = (plane.position.x - target.pos.x) * nx + (plane.position.z - target.pos.z) * nz;
    if (along < 0) {
      setFailure(state, 'Landed short. Press R to retry.');
    } else {
      setFailure(state, 'Landed wide. Press R to retry.');
    }
    return;
  }

  // Inside the ring — check hard-landing threshold.
  if (impactVy < -HARD_LANDING_VY) {
    audio.playCrash?.();
    setFailure(state, 'Came in too hot. Press R to retry.');
    return;
  }

  // ---- Successful landing ------------------------------------------------
  audio.playLanding?.();

  let score = BASE_SCORE;
  if (dist <= target.innerR) score += INNER_BONUS;
  const elapsed = state.time.elapsed - levelStart;
  const timeLimit = level.timeLimitSec ?? 90;
  const timeBonus = Math.max(0, (timeLimit - elapsed) * TIME_BONUS_PER_SEC);
  score += Math.floor(timeBonus);

  const idx = state.level.index ?? 0;
  state.level.recordBest?.(idx, dist);
  const best = state.level.getBest?.(idx);
  const bestStr = best == null ? '—' : `${Math.round(best)} m`;

  status = 'success';
  state.hud.failMsg =
    `Landed! Score ${score} · Best ${bestStr} · Press R for next level.`;
}

function setFailure(state, msg) {
  status = 'failure';
  state.hud.failMsg = msg;
}

function resetToLevel(state, index) {
  state.level.load?.(index);
  // Camera holds a smoothed chase pose that would otherwise sweep across
  // the map after a teleport — re-seed it from the fresh plane pose.
  camera.init?.(state);
  status = 'flying';
  state.hud.failMsg = '';
  levelStart = state.time.elapsed;
  prevPlaneVy = state.plane.velocity.y;
}
