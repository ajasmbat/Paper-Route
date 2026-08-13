// Ticket 3 — world: instanced buildings + fog + spatial-grid collision.
//
// Owns the visible playfield: three InstancedMeshes (one per palette color)
// fading into deep-blue fog, a flat ground quad, and a zero-allocation
// sphere-vs-AABB collision test backed by a uniform spatial grid.

import * as THREE from 'three';

const PALETTE = {
  blue: 0x1F3A93,
  pink: 0xFF4FA3,
  deep: 0x12162B,
};
const GROUND_COLOR = 0x1F3A93; // --blue tint per spec ("large blue-tinted quad")
const FOG_COLOR = 0x12162B;    // --deep
const FOG_NEAR = 40;
const FOG_FAR = 500;

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// Module-scope live state (per loaded level). Reset by unload().
let sceneRef = null;
let meshes = [];              // THREE.InstancedMesh[] currently in scene
let groundMesh = null;
let aabb = null;              // Float32Array, 6 floats per building
let buildingCount = 0;
let grid = null;              // { originX, originZ, cellSize, nx, nz, cells: Int32Array[] }
let loadedLevel = null;

// Reusable Matrix4 used only during level load (never per-frame).
const _loadMatrix = new THREE.Matrix4();

export function init(state) {
  sceneRef = state.three.scene;

  // Fog + background are part of world contract. Wire them here.
  sceneRef.background = new THREE.Color(FOG_COLOR);
  sceneRef.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);

  if (state.level.loaded) {
    loadLevel(state.level.loaded);
  } else if (import.meta.env?.DEV) {
    // T10 has not shipped a level yet; render a fixture so the world is
    // visible while other tickets (flight, camera, ...) are wired up.
    loadLevel(buildFixtureLevel());
  }
}

export function update(state, dt) {
  // No per-step work; collision is queried on demand by flight/scoring.
}

export function render(state, alpha) {
  // Meshes are static per level; nothing to do per-frame.
}

// ---- Level lifecycle ------------------------------------------------------

export function loadLevel(levelJson) {
  if (loadedLevel) unload();
  loadedLevel = levelJson;

  const buildings = levelJson.buildings || [];
  const bounds = levelJson.bounds || {
    min: { x: -400, y: 0, z: -400 },
    max: { x: 400, y: 200, z: 400 },
  };

  buildingCount = buildings.length;
  aabb = new Float32Array(buildingCount * 6);

  // Group buildings by color and fill AABB store.
  const byColor = new Map(); // color -> indices[]
  for (let i = 0; i < buildingCount; i++) {
    const b = buildings[i];
    const halfW = b.w * 0.5;
    const halfH = b.h * 0.5;
    const halfD = b.d * 0.5;
    // Convention: (x, y, z) is the center of the box. Buildings sit on the
    // ground when y = h/2 in the level JSON.
    const o = i * 6;
    aabb[o]     = b.x - halfW;
    aabb[o + 1] = b.y - halfH;
    aabb[o + 2] = b.z - halfD;
    aabb[o + 3] = b.x + halfW;
    aabb[o + 4] = b.y + halfH;
    aabb[o + 5] = b.z + halfD;

    const key = b.color in PALETTE ? b.color : 'blue';
    let list = byColor.get(key);
    if (!list) { list = []; byColor.set(key, list); }
    list.push(i);
  }

  // Build one InstancedMesh per palette color present.
  meshes = [];
  for (const [color, indices] of byColor) {
    const mat = new THREE.MeshBasicMaterial({ color: PALETTE[color], fog: true });
    const inst = new THREE.InstancedMesh(UNIT_BOX, mat, indices.length);
    inst.frustumCulled = false; // whole city is one draw; keep it simple.
    for (let j = 0; j < indices.length; j++) {
      const bi = indices[j];
      const b = buildings[bi];
      _loadMatrix.makeScale(b.w, b.h, b.d);
      _loadMatrix.setPosition(b.x, b.y, b.z);
      inst.setMatrixAt(j, _loadMatrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.name = `world:buildings:${color}`;
    sceneRef.add(inst);
    meshes.push(inst);
  }

  // Ground quad — static, part of the world, y=0. Ground collision is
  // handled by flight/scoring, not by collideSphere.
  const bx = bounds.max.x - bounds.min.x;
  const bz = bounds.max.z - bounds.min.z;
  const groundSize = Math.max(bx, bz) * 4; // pad well beyond bounds so the horizon fogs out
  const groundGeom = new THREE.PlaneGeometry(groundSize, groundSize);
  const groundMat = new THREE.MeshBasicMaterial({ color: GROUND_COLOR, fog: true });
  groundMesh = new THREE.Mesh(groundGeom, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = 0;
  groundMesh.name = 'world:ground';
  sceneRef.add(groundMesh);

  // Uniform spatial grid over level bounds. Cell size ≈ 2× median footprint.
  buildSpatialGrid(buildings, bounds);
}

export function unload() {
  if (!sceneRef) return;
  for (const m of meshes) {
    sceneRef.remove(m);
    m.material.dispose();
    // Do NOT dispose UNIT_BOX — it is shared across all instanced meshes.
  }
  meshes = [];
  if (groundMesh) {
    sceneRef.remove(groundMesh);
    groundMesh.geometry.dispose();
    groundMesh.material.dispose();
    groundMesh = null;
  }
  aabb = null;
  buildingCount = 0;
  grid = null;
  loadedLevel = null;
}

// ---- Spatial grid ---------------------------------------------------------

function buildSpatialGrid(buildings, bounds) {
  // Median footprint = median of max(w, d) across buildings.
  let cellSize;
  if (buildings.length === 0) {
    cellSize = 20;
  } else {
    const foots = new Float64Array(buildings.length);
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      foots[i] = b.w > b.d ? b.w : b.d;
    }
    foots.sort();
    const median = foots[foots.length >> 1];
    cellSize = Math.max(median * 2, 4);
  }

  const originX = bounds.min.x;
  const originZ = bounds.min.z;
  const nx = Math.max(1, Math.ceil((bounds.max.x - originX) / cellSize));
  const nz = Math.max(1, Math.ceil((bounds.max.z - originZ) / cellSize));

  // Two-pass build: count then fill, so each cell is a tightly-sized Int32Array.
  const counts = new Int32Array(nx * nz);
  for (let i = 0; i < buildingCount; i++) {
    const o = i * 6;
    const minCX = clampInt(Math.floor((aabb[o]     - originX) / cellSize), 0, nx - 1);
    const maxCX = clampInt(Math.floor((aabb[o + 3] - originX) / cellSize), 0, nx - 1);
    const minCZ = clampInt(Math.floor((aabb[o + 2] - originZ) / cellSize), 0, nz - 1);
    const maxCZ = clampInt(Math.floor((aabb[o + 5] - originZ) / cellSize), 0, nz - 1);
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        counts[cz * nx + cx]++;
      }
    }
  }
  const cells = new Array(nx * nz);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = counts[i] > 0 ? new Int32Array(counts[i]) : null;
  }
  const cursors = new Int32Array(nx * nz);
  for (let i = 0; i < buildingCount; i++) {
    const o = i * 6;
    const minCX = clampInt(Math.floor((aabb[o]     - originX) / cellSize), 0, nx - 1);
    const maxCX = clampInt(Math.floor((aabb[o + 3] - originX) / cellSize), 0, nx - 1);
    const minCZ = clampInt(Math.floor((aabb[o + 2] - originZ) / cellSize), 0, nz - 1);
    const maxCZ = clampInt(Math.floor((aabb[o + 5] - originZ) / cellSize), 0, nz - 1);
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const idx = cz * nx + cx;
        cells[idx][cursors[idx]++] = i;
      }
    }
  }

  grid = { originX, originZ, cellSize, nx, nz, cells };
}

function clampInt(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// ---- Collision ------------------------------------------------------------
//
// Zero-allocation sphere-vs-AABB via the uniform spatial grid. Only tests
// buildings in cells the sphere's XZ projection overlaps. Writes a
// unit-length push-out normal into `outNormal` and returns true on the first
// hit. When the sphere center is inside an AABB, normal points along the
// axis of minimum penetration.

export function collideSphere(pos, radius, outNormal) {
  if (!grid || buildingCount === 0) return false;

  const px = pos.x, py = pos.y, pz = pos.z;
  const r = radius;
  const r2 = r * r;

  const cs = grid.cellSize;
  const ox = grid.originX;
  const oz = grid.originZ;
  const nx = grid.nx;
  const nz = grid.nz;

  let minCX = Math.floor((px - r - ox) / cs);
  let maxCX = Math.floor((px + r - ox) / cs);
  let minCZ = Math.floor((pz - r - oz) / cs);
  let maxCZ = Math.floor((pz + r - oz) / cs);
  if (minCX < 0) minCX = 0;
  if (minCZ < 0) minCZ = 0;
  if (maxCX >= nx) maxCX = nx - 1;
  if (maxCZ >= nz) maxCZ = nz - 1;
  if (minCX > maxCX || minCZ > maxCZ) return false;

  const cells = grid.cells;
  const ab = aabb;

  for (let cz = minCZ; cz <= maxCZ; cz++) {
    const row = cz * nx;
    for (let cx = minCX; cx <= maxCX; cx++) {
      const cell = cells[row + cx];
      if (cell === null) continue;
      const cl = cell.length;
      for (let i = 0; i < cl; i++) {
        const bi = cell[i];
        const bo = bi * 6;
        const minX = ab[bo],     minY = ab[bo + 1], minZ = ab[bo + 2];
        const maxX = ab[bo + 3], maxY = ab[bo + 4], maxZ = ab[bo + 5];

        // Closest point on AABB to sphere center.
        const ccx = px < minX ? minX : (px > maxX ? maxX : px);
        const ccy = py < minY ? minY : (py > maxY ? maxY : py);
        const ccz = pz < minZ ? minZ : (pz > maxZ ? maxZ : pz);

        const dx = px - ccx;
        const dy = py - ccy;
        const dz = pz - ccz;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (d2 > r2) continue;

        if (d2 > 1e-12) {
          const inv = 1 / Math.sqrt(d2);
          outNormal.x = dx * inv;
          outNormal.y = dy * inv;
          outNormal.z = dz * inv;
        } else {
          // Center is inside the AABB — push out along axis of min penetration.
          const pxPos = maxX - px, pxNeg = px - minX;
          const pyPos = maxY - py, pyNeg = py - minY;
          const pzPos = maxZ - pz, pzNeg = pz - minZ;
          let minP = pxPos;
          outNormal.x = 1; outNormal.y = 0; outNormal.z = 0;
          if (pxNeg < minP) { minP = pxNeg; outNormal.x = -1; outNormal.y = 0; outNormal.z = 0; }
          if (pyPos < minP) { minP = pyPos; outNormal.x = 0; outNormal.y = 1; outNormal.z = 0; }
          if (pyNeg < minP) { minP = pyNeg; outNormal.x = 0; outNormal.y = -1; outNormal.z = 0; }
          if (pzPos < minP) { minP = pzPos; outNormal.x = 0; outNormal.y = 0; outNormal.z = 1; }
          if (pzNeg < minP) {              outNormal.x = 0; outNormal.y = 0; outNormal.z = -1; }
        }
        return true;
      }
    }
  }
  return false;
}

// ---- Dev fixture ----------------------------------------------------------
//
// A ~40-building sample level so the world module is renderable and testable
// on its own, before T10 ships real level JSON. Deterministic (seeded PRNG).

function buildFixtureLevel() {
  const rand = mulberry32(0xC0FFEE);
  const colors = ['blue', 'pink', 'deep'];
  const buildings = [];
  const bounds = { min: { x: -400, y: 0, z: -400 }, max: { x: 400, y: 200, z: 400 } };
  const N = 42;
  for (let i = 0; i < N; i++) {
    const w = 12 + rand() * 30;
    const d = 12 + rand() * 30;
    const h = 20 + rand() * 120;
    const x = (rand() * 2 - 1) * 350;
    const z = (rand() * 2 - 1) * 350;
    const color = colors[i % colors.length];
    buildings.push({ x, y: h * 0.5, z, w, h, d, color });
  }
  return {
    name: 'world-fixture',
    start: { pos: { x: 0, y: 120, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
    target: { pos: { x: 0, y: 0, z: 0 }, innerR: 5, outerR: 20 },
    buildings,
    thermals: [],
    bounds,
    timeLimitSec: 120,
  };
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
