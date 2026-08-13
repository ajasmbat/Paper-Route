import * as THREE from 'three';
import { state } from './state.js';
import * as flight from './flight.js';
import * as world from './world.js';
import * as thermals from './thermals.js';
import * as camera from './camera.js';
import * as audio from './audio.js';
import * as hud from './hud.js';
import * as input from './input.js';
import * as levels from './levels.js';
import * as scoring from './scoring.js';

const DEEP = 0x12162B;

const canvas = document.getElementById('game');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(DEEP, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(DEEP);
scene.fog = new THREE.Fog(DEEP, 40, 900);

const three = new THREE.PerspectiveCamera(
  state.camera.fov,
  window.innerWidth / window.innerHeight,
  0.1,
  2000,
);
three.position.copy(state.camera.chasePos);
three.quaternion.copy(state.camera.chaseQuat);

// Expose renderer/scene/camera on state for modules that need them.
state.three = { renderer, scene, camera: three };

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  three.aspect = w / h;
  three.updateProjectionMatrix();
});

// Initialize every module in dependency order.
const modules = [levels, input, flight, world, thermals, camera, audio, hud, scoring];
for (const m of modules) m.init?.(state);

// ---- Fixed-timestep loop with accumulator + render interpolation ---------
// The contract every other ticket assumes:
//   * update(state, dt) runs at exactly 120Hz on state.time.stepDt.
//   * render(state, alpha) is called once per animation frame with
//     alpha in [0, 1] — the fractional distance between the previous
//     step and the current step. Interpolate visuals against alpha,
//     never against wall-clock.
const STEP_DT = state.time.stepDt;      // 1/120
const MAX_ACCUM = STEP_DT * 8;          // cap catch-up to avoid spiral of death

let lastMs = performance.now();
let accumulator = 0;
let heartbeatAccum = 0;

function step(dt) {
  input.update?.(state, dt);
  flight.update?.(state, dt);
  thermals.update?.(state, dt);
  world.update?.(state, dt);
  camera.update?.(state, dt);
  scoring.update?.(state, dt);
  audio.update?.(state, dt);
  hud.update?.(state, dt);
  state.time.elapsed += dt;
}

function render(alpha) {
  camera.render?.(state, alpha);
  world.render?.(state, alpha);
  thermals.render?.(state, alpha);
  flight.render?.(state, alpha);
  hud.render?.(state, alpha);
  renderer.render(scene, three);
}

function frame(nowMs) {
  const rawDt = (nowMs - lastMs) / 1000;
  lastMs = nowMs;

  accumulator += rawDt;
  if (accumulator > MAX_ACCUM) accumulator = MAX_ACCUM;

  while (accumulator >= STEP_DT) {
    step(STEP_DT);
    accumulator -= STEP_DT;
  }

  const alpha = accumulator / STEP_DT;
  render(alpha);

  // Dev heartbeat — one line per second confirming the fixed step is ticking.
  if (import.meta.env?.DEV) {
    heartbeatAccum += rawDt;
    if (heartbeatAccum >= 1) {
      heartbeatAccum -= 1;
      // eslint-disable-next-line no-console
      console.log('[paper-route] state.time.elapsed =', state.time.elapsed.toFixed(3));
    }
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
