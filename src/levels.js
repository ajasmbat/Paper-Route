// Ticket 10 — Levels: 3 JSON literals + loader + localStorage bests.
//
// The three levels form the design arc from the spec:
//   1. Downtown — tutorial by doing. Wide streets, big thermals on the direct
//      line, generous ring — beatable first try on a straight glide.
//   2. The Gap — the game's central idea landing. Target is short of the
//      straight-glide reach; ONE thermal offset to the side. Detour to fly it.
//   3. Spires — precision reward. Tight alleys between tall spires, thermals
//      sitting inside the alleys.
//
// Geometry constants worth remembering while tuning:
//   * TRIM_SPEED = 12 m/s (mirrors src/flight.js).
//   * Neutral-input glide from y=200 with V=12 settles ~6:1 (~1200 m horiz).
//   * Buildings: (x, y, z) is the box center; y = h/2 sits on the ground.
//   * Thermals: (x, z, radius, strength, height). sampleAt gives upward wind.

import * as world from './world.js';
import * as thermals from './thermals.js';

const TRIM_SPEED = 12;

/** @typedef {import('./levels.js').Level} Level */

// ---- Level 1 — Downtown ---------------------------------------------------
// Wide east-west streets, sparse-ish grid of low-to-mid-height buildings.
// Two big fat thermals sit right on the direct flight line to teach the
// player that riding lift feels like the plane accelerating and floating.
// A 75 m outer ring is deliberately generous — verified in scripts/verify-levels.mjs
// that both the naive straight-line glide (lands 46 m from center) and the
// with-lift trajectory (lands 73 m from center) fall inside the ring.

const LEVEL_1 = {
  name: 'Downtown',
  start: { pos: { x: 0, y: 180, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
  // outerR is generous enough that both the naive straight-line glide AND the
  // longer with-lift trajectory land inside — the tutorial's whole point is
  // that neither route needs thinking.
  target: { pos: { x: 0, y: 0, z: -1220 }, innerR: 12, outerR: 75 },
  buildings: buildDowntown(),
  thermals: [
    { x: 0, z: -350, radius: 30, strength: 3.0, height: 220 },
    { x: 0, z: -700, radius: 30, strength: 2.5, height: 220 },
  ],
  bounds: { min: { x: -500, y: 0, z: -1450 }, max: { x: 500, y: 320, z: 200 } },
  timeLimitSec: 90,
};

// Downtown buildings: two rows either side of a wide central street the plane
// flies down. Heights 30 – 90 m so the horizon reads as a skyline; nothing
// intrudes into the corridor.
function buildDowntown() {
  const out = [];
  const COLORS = ['blue', 'pink', 'deep'];
  const sideX = 90; // half-width of the empty flight corridor (x = ±90 clear)
  // Two street rows down each side, staggered depth.
  const zs = [-100, -230, -360, -490, -620, -750, -880];
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i];
    for (const sign of [-1, 1]) {
      // Two buildings deep on each side, at x ≈ sideX+20 and x ≈ sideX+70.
      const near = { w: 40, h: 40 + ((i * 17) % 55), d: 35 };
      const far  = { w: 55, h: 55 + ((i * 23) % 40), d: 45 };
      out.push({
        x: sign * (sideX + near.w * 0.5), y: near.h * 0.5, z,
        w: near.w, h: near.h, d: near.d,
        color: COLORS[(i + (sign > 0 ? 1 : 0)) % COLORS.length],
      });
      out.push({
        x: sign * (sideX + near.w + 20 + far.w * 0.5), y: far.h * 0.5, z: z - 25,
        w: far.w, h: far.h, d: far.d,
        color: COLORS[(i * 2 + (sign > 0 ? 0 : 1)) % COLORS.length],
      });
    }
  }
  return out;
}

// ---- Level 2 — The Gap ----------------------------------------------------
// Start altitude × glide ratio deliberately under the target distance. Exactly
// one thermal — offset ~100 m to the right of the direct line, at the point
// where the player realises the ground is coming up too fast. Detouring right
// costs a little forward distance but the lift more than pays for it.
//
// Sparse buildings only — the challenge here is the geometry of altitude and
// distance, not obstacle avoidance.

const LEVEL_2 = {
  name: 'The Gap',
  start: { pos: { x: 0, y: 150, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
  target: { pos: { x: 0, y: 0, z: -1100 }, innerR: 6, outerR: 25 },
  buildings: buildGapMarkers(),
  thermals: [
    // Offset ~120 m to the right of the direct line, wide + strong so a
    // committed detour actually gains real altitude.
    { x: 130, z: -450, radius: 30, strength: 8.0, height: 380 },
  ],
  bounds: { min: { x: -400, y: 0, z: -1300 }, max: { x: 500, y: 400, z: 200 } },
  timeLimitSec: 90,
};

// Two lone "marker" towers frame the far ring so the player can pick it out
// against the fog, plus a small pink building near the offset thermal as a
// physical cue for where the lift is.
function buildGapMarkers() {
  return [
    { x: -60, y: 40, z: -1100, w: 20, h: 80, d: 20, color: 'deep' },
    { x:  60, y: 40, z: -1100, w: 20, h: 80, d: 20, color: 'deep' },
    { x: 130, y: 30, z: -450,  w: 12, h: 60, d: 12, color: 'pink' },
  ];
}

// ---- Level 3 — Spires -----------------------------------------------------
// Grid of tall spires running along -Z with a 14 m alley on the flight line.
// Thermals sit inside the alley, so gaining altitude means threading the gap.
// Tighter 25 m outer ring rewards precision after the tunnel run.

const LEVEL_3 = {
  name: 'Spires',
  start: { pos: { x: 0, y: 180, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
  target: { pos: { x: 0, y: 0, z: -1200 }, innerR: 4, outerR: 25 },
  buildings: buildSpires(),
  thermals: [
    { x: 0, z: -200, radius: 6, strength: 5.5, height: 260 },
    { x: 0, z: -500, radius: 6, strength: 5.5, height: 260 },
    { x: 0, z: -800, radius: 6, strength: 5.5, height: 260 },
  ],
  bounds: { min: { x: -300, y: 0, z: -1350 }, max: { x: 300, y: 320, z: 200 } },
  timeLimitSec: 90,
};

// Seven rows of paired spires flanking a 14 m central alley on the flight
// line, plus outrigger spires further out to wall in the canyon visually.
function buildSpires() {
  const out = [];
  const rowZ = [-125, -275, -425, -575, -725, -875, -1025];
  const alleyHalf = 22;   // spire centers at x = ±22; spire w = 30, so inner face at ±7 → gap 14 m
  const spireW = 30;
  const spireD = 26;
  const spireH = 260;
  const colors = ['blue', 'pink', 'deep'];
  for (let i = 0; i < rowZ.length; i++) {
    const z = rowZ[i];
    // Central-alley pair.
    for (const sign of [-1, 1]) {
      out.push({
        x: sign * alleyHalf,
        y: spireH * 0.5,
        z,
        w: spireW, h: spireH, d: spireD,
        color: colors[(i + (sign > 0 ? 1 : 0)) % colors.length],
      });
    }
    // Outrigger spires, further out — visual wall, not on the flight path.
    for (const sign of [-1, 1]) {
      out.push({
        x: sign * (alleyHalf + spireW + 20),
        y: (spireH - 40) * 0.5,
        z: z + 30,
        w: spireW - 6, h: spireH - 40, d: spireD - 4,
        color: colors[(i * 2 + (sign > 0 ? 0 : 1)) % colors.length],
      });
    }
  }
  return out;
}

// ---- LEVELS export --------------------------------------------------------

export const LEVELS = [LEVEL_1, LEVEL_2, LEVEL_3];

// ---- localStorage bests ---------------------------------------------------
//
// Key: `paperroute.best.L{n}` (n is 1-indexed). Value: JSON number of meters
// — distance from the plane's final rest position to the ring center. Lower
// is better. `recordBest` writes only when the new distance beats the stored
// one. Failures (SSR, private mode, quota) fall through silently — bests are
// a nice-to-have, not a hard requirement.

function bestKey(index) {
  return `paperroute.best.L${index + 1}`;
}

export function getBest(index) {
  try {
    const raw = globalThis.localStorage?.getItem(bestKey(index));
    if (raw == null) return null;
    const n = JSON.parse(raw);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function recordBest(index, distance) {
  if (!Number.isFinite(distance) || distance < 0) return false;
  const prev = getBest(index);
  if (prev != null && prev <= distance) return false;
  try {
    globalThis.localStorage?.setItem(bestKey(index), JSON.stringify(distance));
    updateHudBest(index);
    return true;
  } catch {
    return false;
  }
}

// ---- HUD "best" chip ------------------------------------------------------
//
// A small single-print DM Mono readout attached beneath the top-center Dist
// chip. --deep ink only (no blue+pink misregistration — that treatment is
// reserved for the big Archivo numerals per the color reservations).

let hudBestEl = null;

function updateHudBest(index) {
  if (!hudBestEl) return;
  const best = getBest(index);
  hudBestEl.textContent = best == null ? 'BEST — · —' : `BEST ${Math.round(best)} m`;
}

// ---- Loader ---------------------------------------------------------------
//
// Two forms:
//   * `seed(state, index)` — used at init time BEFORE world/thermals init.
//     Sets state.level.{index, loaded} + resets the plane; world.init and
//     thermals.init then pull the level off state and mount their own meshes.
//     Safe to call before state.three exists.
//   * `load(state, index)` — full mid-game swap. Same reset, plus explicit
//     world.loadLevel + thermals.loadLevel (both idempotent) and a HUD refresh.

function seed(state, index) {
  const level = LEVELS[index];
  if (!level) return;
  state.level.index = index;
  state.level.loaded = level;
  resetPlane(state, level);
}

export function load(state, index) {
  const level = LEVELS[index];
  if (!level) return;

  state.level.index = index;
  state.level.loaded = level;

  // Swap world + thermals. world.loadLevel handles idempotent teardown of the
  // previous InstancedMeshes; thermals.loadLevel calls unload() first too.
  world.loadLevel(level);
  thermals.loadLevel(level);

  resetPlane(state, level);
  updateHudBest(index);
}

// Reset the plane pose to a level's start. `dir` is treated as a heading
// vector — normalize it, multiply by TRIM_SPEED for launch velocity, and aim
// the mesh along dir so the chase camera doesn't spin up from a mismatched
// forward axis.
function resetPlane(state, level) {
  const p = state.plane;
  p.position.set(level.start.pos.x, level.start.pos.y, level.start.pos.z);

  const dx = level.start.dir.x;
  const dy = level.start.dir.y;
  const dz = level.start.dir.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / dl, ny = dy / dl, nz = dz / dl;
  p.velocity.set(nx * TRIM_SPEED, ny * TRIM_SPEED, nz * TRIM_SPEED);

  // Face `dir` — quaternion from body forward (0,0,-1) to normalized start.dir.
  const fx = 0, fy = 0, fz = -1;
  const dot = fx * nx + fy * ny + fz * nz;
  if (dot > 0.999999) {
    p.quaternion.set(0, 0, 0, 1);
  } else if (dot < -0.999999) {
    // 180° flip — rotate around world up (or +X if dir is near-parallel to it).
    p.quaternion.set(0, 1, 0, 0);
  } else {
    // cross(forward, dir); axis-angle → quaternion via half-angle identity.
    const cx = fy * nz - fz * ny;
    const cy = fz * nx - fx * nz;
    const cz = fx * ny - fy * nx;
    const s = Math.sqrt((1 + dot) * 2);
    const inv = 1 / s;
    p.quaternion.set(cx * inv, cy * inv, cz * inv, s * 0.5).normalize();
  }

  p.angularVel.set(0, 0, 0);
  p.airspeed = TRIM_SPEED;
  p.aoa = 0;
  p.stalled = false;
  p.prevPosition.copy(p.position);
  p.prevQuaternion.copy(p.quaternion);
}

// ---- Module lifecycle -----------------------------------------------------

export function init(state) {
  hudBestEl = document.getElementById('hud-best');
  // Expose a stable API on state so scoring (T11) can call recordBest and
  // trigger a level change without an import cycle back through this module.
  state.level.load = (index) => load(state, index);
  state.level.recordBest = recordBest;
  state.level.getBest = getBest;
  // Seed level 0 for world.init / thermals.init to pick up — do NOT call
  // their loadLevel here; state.three.scene may not exist yet.
  seed(state, 0);
  updateHudBest(0);
}

export function update(_state, _dt) {
  // No per-step work — level swaps are event-driven, bests are event-driven.
}
