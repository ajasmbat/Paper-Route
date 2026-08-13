import * as THREE from 'three';

// Ticket 4 — Thermals: vertical lift cylinders with smoothstep falloff,
// pink shimmer visuals, and rising specks.
//
// Contract:
//   - sampleAt(pos, out) writes upward wind (m/s) into `out`; zero allocs.
//   - loadLevel(levelJson) / unload() rebuild GPU + CPU state.
//   - update() bookkeeps state.thermals.activeThermalIndex and advances specks.
//   - render() applies subtle shimmer wobble.

const PINK = 0xff4fa3;

// Per-thermal speck count. 48 = enough to read as a rising column at typical
// speeds without a big draw or memory cost. Tunable, module-local by design.
const SPECKS_PER_THERMAL = 48;

// Vertical easing band (world units) at the top and the bottom of each
// thermal — inside this band the vertical weight ramps 0 → 1 (or 1 → 0), so
// the lift feels like you punched through the top instead of hitting a wall.
const EDGE_BAND = 6;

// Threshold on the combined weight (w = radial * vertical) for the plane to
// count as "inside" a thermal for the activeThermalIndex signal. Ticket 5/6
// listen for this transition; keep it high enough that grazing an edge does
// not spam the catch sound.
const ACTIVE_W = 0.5;

// Module-level GPU + CPU state. Recreated on loadLevel / cleared on unload.
let scene = null;
let clock = null;
let mounted = false;

// Raw thermal params, hot-loop-friendly SoA. Indexes into all arrays match.
let count = 0;
let px = null;          // Float32Array, world x
let pz = null;          // Float32Array, world z
let radius = null;      // Float32Array, m
let strength = null;    // Float32Array, m/s at core
let height = null;      // Float32Array, m top-of-column
let phase = null;       // Float32Array, per-thermal shimmer phase offset

// Shimmer InstancedMesh — one CylinderGeometry, N instances scaled to fit.
let shimmerMesh = null;
let shimmerBaseScales = null;   // Float32Array [sx, sy, sz] triples
let shimmerBasePositions = null;// Float32Array [x, y, z] triples (mid-height)

// Specks — a single shared THREE.Points with a fixed-size BufferGeometry.
// Slots [i * SPECKS_PER_THERMAL, (i+1) * SPECKS_PER_THERMAL) belong to thermal i.
let speckPoints = null;
let speckPositions = null;      // Float32Array, x/y/z per point (view into geometry attr)
let speckOffsets = null;        // Float32Array, per-point radial offset (r, angle)
let speckPositionsAttr = null;  // THREE.BufferAttribute (needs needsUpdate = true)

/**
 * Zero-alloc smoothstep — mirrors GLSL smoothstep(edge0, edge1, x).
 * Returns 0 when x <= edge0, 1 when x >= edge1, S-curve in between.
 */
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  let t = (x - edge0) / (edge1 - edge0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/**
 * Radial weight at (px[i], pz[i]) relative to sample (x, z).
 * The spec asks for smoothstep(radius, radius*0.4, dist): 1 at the core, 0
 * at the outer edge, with an S-curve in between. We use smoothstep with the
 * "outer" argument first so it decays outward (edge0 > edge1 flips the ramp).
 */
function radialW(i, x, z) {
  const dx = x - px[i];
  const dz = z - pz[i];
  const dist = Math.sqrt(dx * dx + dz * dz);
  const r = radius[i];
  return smoothstep(r, r * 0.4, dist);
}

/**
 * Vertical weight: 0 below ground and above height, ramp EDGE_BAND at each
 * end so the transition is smooth (no snap on entry/exit through the top or
 * bottom cap).
 */
function verticalW(i, y) {
  const h = height[i];
  if (y <= 0 || y >= h) return 0;
  const bottom = smoothstep(0, EDGE_BAND, y);
  const top = smoothstep(h, h - EDGE_BAND, y);
  return bottom * top;
}

/**
 * sampleAt — writes upward wind velocity into out. Zero allocations.
 * Returns out for caller convenience.
 */
export function sampleAt(pos, out) {
  out.x = 0;
  out.z = 0;
  if (!count) {
    out.y = 0;
    return out;
  }
  let vy = 0;
  const x = pos.x;
  const y = pos.y;
  const z = pos.z;
  for (let i = 0; i < count; i++) {
    // Cheap AABB reject on radius before the sqrt-hitting radialW.
    const dx = x - px[i];
    const dz = z - pz[i];
    const r = radius[i];
    if (dx > r || dx < -r || dz > r || dz < -r) continue;
    const w = radialW(i, x, z) * verticalW(i, y);
    if (w > 0) vy += w * strength[i];
  }
  out.y = vy;
  return out;
}

/**
 * (Re)build GPU + CPU state from a level JSON's thermals array.
 * Idempotent — calling twice tears down the previous set first.
 */
export function loadLevel(levelJson) {
  unload();
  const list = levelJson?.thermals ?? [];
  count = list.length;
  if (!count) return;

  px = new Float32Array(count);
  pz = new Float32Array(count);
  radius = new Float32Array(count);
  strength = new Float32Array(count);
  height = new Float32Array(count);
  phase = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const t = list[i];
    px[i] = t.x;
    pz[i] = t.z;
    radius[i] = t.radius;
    strength[i] = t.strength;
    height[i] = t.height;
    // Deterministic phase per thermal — different columns wobble out of sync
    // without an RNG dependency, so replays look identical.
    phase[i] = (i * 0.9173) % (Math.PI * 2);
  }

  buildShimmer();
  buildSpecks();

  if (scene) {
    if (shimmerMesh) scene.add(shimmerMesh);
    if (speckPoints) scene.add(speckPoints);
  }
  mounted = !!scene;
}

/**
 * Free GPU resources and reset module state so loadLevel can be called again.
 */
export function unload() {
  if (scene) {
    if (shimmerMesh) scene.remove(shimmerMesh);
    if (speckPoints) scene.remove(speckPoints);
  }
  if (shimmerMesh) {
    shimmerMesh.geometry.dispose();
    shimmerMesh.material.dispose();
    shimmerMesh = null;
  }
  if (speckPoints) {
    speckPoints.geometry.dispose();
    speckPoints.material.dispose();
    speckPoints = null;
  }
  shimmerBaseScales = null;
  shimmerBasePositions = null;
  speckPositions = null;
  speckOffsets = null;
  speckPositionsAttr = null;
  count = 0;
  px = pz = radius = strength = height = phase = null;
  mounted = false;
}

function buildShimmer() {
  // Unit cylinder — height 1, radius 1 — scaled per-instance to real size.
  const geo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: PINK,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
  shimmerMesh = new THREE.InstancedMesh(geo, mat, count);
  shimmerMesh.frustumCulled = false;

  shimmerBaseScales = new Float32Array(count * 3);
  shimmerBasePositions = new Float32Array(count * 3);

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const r = radius[i];
    const h = height[i];
    p.set(px[i], h * 0.5, pz[i]);
    s.set(r, h, r);
    m.compose(p, q, s);
    shimmerMesh.setMatrixAt(i, m);

    shimmerBaseScales[i * 3 + 0] = r;
    shimmerBaseScales[i * 3 + 1] = h;
    shimmerBaseScales[i * 3 + 2] = r;
    shimmerBasePositions[i * 3 + 0] = px[i];
    shimmerBasePositions[i * 3 + 1] = h * 0.5;
    shimmerBasePositions[i * 3 + 2] = pz[i];
  }
  shimmerMesh.instanceMatrix.needsUpdate = true;
}

function buildSpecks() {
  const total = count * SPECKS_PER_THERMAL;
  speckPositions = new Float32Array(total * 3);
  speckOffsets = new Float32Array(total * 2); // [r, angle] per point

  for (let i = 0; i < count; i++) {
    const r = radius[i];
    const h = height[i];
    for (let k = 0; k < SPECKS_PER_THERMAL; k++) {
      const idx = i * SPECKS_PER_THERMAL + k;
      // Deterministic per-index polar offset — a golden-angle spiral inside
      // the disk keeps the column visually full without any RNG in init.
      const t = (k + 0.5) / SPECKS_PER_THERMAL;
      const rr = Math.sqrt(t) * r * 0.85; // bias toward the outside a bit
      const ang = k * 2.399963229728653;  // golden angle
      speckOffsets[idx * 2 + 0] = rr;
      speckOffsets[idx * 2 + 1] = ang;
      // Stagger initial heights across the column so it looks in-flight from t=0.
      const y = h * t;
      speckPositions[idx * 3 + 0] = px[i] + Math.cos(ang) * rr;
      speckPositions[idx * 3 + 1] = y;
      speckPositions[idx * 3 + 2] = pz[i] + Math.sin(ang) * rr;
    }
  }

  const geo = new THREE.BufferGeometry();
  speckPositionsAttr = new THREE.BufferAttribute(speckPositions, 3);
  speckPositionsAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', speckPositionsAttr);

  const mat = new THREE.PointsMaterial({
    color: PINK,
    size: 1.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  speckPoints = new THREE.Points(geo, mat);
  speckPoints.frustumCulled = false;
}

export function init(state) {
  scene = state.three?.scene ?? null;
  // If Ticket 10 (levels) has already stashed a level on the state, wire in
  // its thermals immediately. Otherwise loadLevel() will be called later.
  const level = state.level?.loaded;
  if (level && Array.isArray(level.thermals)) {
    loadLevel(level);
    return;
  }
  // Dev-only sanity: three thermals near the plane spawn so shimmer + specks
  // can be inspected before Ticket 2 (flight) or Ticket 10 (levels) land.
  // Overwritten as soon as loadLevel() is called with a real level.
  if (import.meta.env?.DEV) {
    loadLevel({
      thermals: [
        { x: 0, z: -30, radius: 12, strength: 6, height: 180 },
        { x: 25, z: -10, radius: 8, strength: 4, height: 140 },
        { x: -20, z: 5, radius: 10, strength: 5, height: 160 },
      ],
    });
  }
}

export function update(state, dt) {
  // Late-bind if a level got loaded after init.
  if (scene && !mounted && count === 0) {
    const level = state.level?.loaded;
    if (level && Array.isArray(level.thermals)) loadLevel(level);
  }
  if (!count) {
    state.thermals.activeThermalIndex = -1;
    return;
  }

  // ---- activeThermalIndex: argmax of (w * strength) with w > ACTIVE_W. ----
  const p = state.plane.position;
  let bestI = -1;
  let bestScore = 0;
  for (let i = 0; i < count; i++) {
    const dx = p.x - px[i];
    const dz = p.z - pz[i];
    const r = radius[i];
    if (dx > r || dx < -r || dz > r || dz < -r) continue;
    const wr = radialW(i, p.x, p.z);
    if (wr <= ACTIVE_W) continue;
    const wv = verticalW(i, p.y);
    const w = wr * wv;
    if (w <= ACTIVE_W) continue;
    const score = w * strength[i];
    if (score > bestScore) {
      bestScore = score;
      bestI = i;
    }
  }
  state.thermals.activeThermalIndex = bestI;

  // ---- Specks: rise in place, wrap at top. Speed ∝ thermal strength. ----
  const total = count * SPECKS_PER_THERMAL;
  for (let idx = 0; idx < total; idx++) {
    const i = (idx / SPECKS_PER_THERMAL) | 0;
    const h = height[i];
    // Base speed of 1.8x strength gives a visible upward drift at typical
    // strengths (4-8 m/s → 7-14 m/s specks) without racing past the shimmer.
    const speed = strength[i] * 1.8;
    let y = speckPositions[idx * 3 + 1] + speed * dt;
    if (y > h) y -= h;
    speckPositions[idx * 3 + 1] = y;
    // x/z stay put — the polar offset was baked into buildSpecks and never
    // needs to be recomputed here.
  }
  if (speckPositionsAttr) speckPositionsAttr.needsUpdate = true;
}

// Reused per render() to write instance matrices without allocations.
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

export function render(state, alpha) {
  if (!count || !shimmerMesh) return;

  const t = state.time.elapsed;
  // Subtle scale + Y wobble per instance. Amplitudes are tiny (±3% radius,
  // ±1% height) — we're on --paper, so restraint reads better than a big
  // pulse. Opacity oscillation is baked into the material below.
  for (let i = 0; i < count; i++) {
    const phi = phase[i] + t * 1.4;
    const sWobble = 1 + Math.sin(phi) * 0.03;
    const hWobble = 1 + Math.cos(phi * 0.7) * 0.01;
    const baseR = shimmerBaseScales[i * 3 + 0];
    const baseH = shimmerBaseScales[i * 3 + 1];
    _pos.set(
      shimmerBasePositions[i * 3 + 0],
      shimmerBasePositions[i * 3 + 1],
      shimmerBasePositions[i * 3 + 2],
    );
    _scale.set(baseR * sWobble, baseH * hWobble, baseR * sWobble);
    _mat.compose(_pos, _quat, _scale);
    shimmerMesh.setMatrixAt(i, _mat);
  }
  shimmerMesh.instanceMatrix.needsUpdate = true;

  // Global opacity breathing — cheap, one write per frame regardless of count.
  const breath = 0.18 + Math.sin(t * 1.1) * 0.04;
  shimmerMesh.material.opacity = breath;
}
