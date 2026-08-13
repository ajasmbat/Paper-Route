// Ribbon trail: pink, widens with speed.
// Ring buffer of plane poses -> triangle-strip mesh. Head vertex tracks the
// interpolated flight pose so the ribbon glues to the plane at any framerate.

import * as THREE from 'three';
import * as flightModule from './flight.js';

// Ticket 2 owns flight.js and may export an `interpolate(state, alpha, outPos,
// outQuat)`. Read it dynamically so this ticket ships before Ticket 2 without
// a static "not exported" warning; fall back to inline lerp/slerp otherwise.
const flight = /** @type {any} */ (flightModule);

const SAMPLES = 120;
const SAMPLE_STRIDE = 7;              // pos(3) + right(3) + halfWidth(1)
const SAMPLE_EVERY_N_STEPS = 2;       // 120Hz step / 2 = 60Hz sample cadence

// Width in world meters. halfWidth = clamp(BASE_W + K_W * airspeed, MIN, MAX) * 0.5
const BASE_W = 0.10;
const K_W = 0.025;
const MIN_W = 0.15;
const MAX_W = 1.20;

const PINK = 0xff4fa3;

const samples = new Float32Array(SAMPLES * SAMPLE_STRIDE);
const positions = new Float32Array(SAMPLES * 2 * 3);
const alphas = new Float32Array(SAMPLES * 2);
const indices = new Uint16Array((SAMPLES - 1) * 6);

let cursor = 0;
let filled = 0;
let stepCounter = 0;
let mesh = null;
let geometry = null;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function halfWidthFor(airspeed) {
  return clamp(BASE_W + K_W * airspeed, MIN_W, MAX_W) * 0.5;
}

// Delegate to flight.interpolate when present (Ticket 2 may add a smarter
// version); otherwise lerp/slerp between prev and current step snapshots.
// Bracket access dodges Rollup's "not exported" warning while Ticket 2 is
// still in flight.
function interpolate(state, alpha, outPos, outQuat) {
  const fn = flight['interpolate'];
  if (typeof fn === 'function') {
    fn(state, alpha, outPos, outQuat);
    return;
  }
  outPos.lerpVectors(state.plane.prevPosition, state.plane.position, alpha);
  outQuat.copy(state.plane.prevQuaternion).slerp(state.plane.quaternion, alpha);
}

export function init(state) {
  for (let i = 0; i < SAMPLES - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    const j = i * 6;
    indices[j + 0] = a; indices[j + 1] = c; indices[j + 2] = b;
    indices[j + 3] = b; indices[j + 4] = c; indices[j + 5] = d;
  }

  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(PINK) } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(uColor, vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  state.three.scene.add(mesh);

  if (!state.trail) state.trail = { hidden: false };
}

export function update(state, dt) {
  stepCounter++;
  if (stepCounter % SAMPLE_EVERY_N_STEPS !== 0) return;

  const p = state.plane.position;
  const q = state.plane.quaternion;
  const right = state.scratch.v0.set(1, 0, 0).applyQuaternion(q);
  const hw = halfWidthFor(state.plane.airspeed);

  const base = cursor * SAMPLE_STRIDE;
  samples[base + 0] = p.x;
  samples[base + 1] = p.y;
  samples[base + 2] = p.z;
  samples[base + 3] = right.x;
  samples[base + 4] = right.y;
  samples[base + 5] = right.z;
  samples[base + 6] = hw;

  cursor = (cursor + 1) % SAMPLES;
  if (filled < SAMPLES) filled++;
}

export function render(state, alpha) {
  if (!mesh) return;

  if (state.trail?.hidden === true || filled < 2) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;

  const headPos = state.scratch.v1;
  const headQuat = state.scratch.q0;
  interpolate(state, alpha, headPos, headQuat);
  const headRight = state.scratch.v2.set(1, 0, 0).applyQuaternion(headQuat);
  const headHW = halfWidthFor(state.plane.airspeed);

  const start = filled < SAMPLES ? 0 : cursor;
  const count = filled;
  const last = count - 1;

  for (let i = 0; i < count; i++) {
    let px, py, pz, rx, ry, rz, hw;
    if (i === last) {
      px = headPos.x; py = headPos.y; pz = headPos.z;
      rx = headRight.x; ry = headRight.y; rz = headRight.z;
      hw = headHW;
    } else {
      const ringIdx = (start + i) % SAMPLES;
      const b = ringIdx * SAMPLE_STRIDE;
      px = samples[b + 0]; py = samples[b + 1]; pz = samples[b + 2];
      rx = samples[b + 3]; ry = samples[b + 4]; rz = samples[b + 5];
      hw = samples[b + 6];
    }
    const o = i * 6;
    positions[o + 0] = px - rx * hw;
    positions[o + 1] = py - ry * hw;
    positions[o + 2] = pz - rz * hw;
    positions[o + 3] = px + rx * hw;
    positions[o + 4] = py + ry * hw;
    positions[o + 5] = pz + rz * hw;

    const a = last > 0 ? i / last : 1;
    alphas[i * 2 + 0] = a;
    alphas[i * 2 + 1] = a;
  }

  const segments = count - 1;
  geometry.setDrawRange(0, segments * 6);
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.aAlpha.needsUpdate = true;
}
