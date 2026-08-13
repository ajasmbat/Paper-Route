// Input: pointer-lock mouse (primary) + WASD/QE fallback with framerate-independent ramping.
// Writes state.input.{pitch, roll, yaw} clamped to [-1, 1], plus resetRequested + audio.muted.

import * as audio from './audio.js';

const RAMP_TAU = 0.12;               // seconds — 1 - exp(-dt/tau)
const RAMP_K = 1 / RAMP_TAU;
const FULL_DEFLECTION_PX = 400;      // 400px of cursor delta = full stick throw
const DEADZONE_PX = 6;               // ignore tiny drift near center
const MOUSE_MAX_PX = FULL_DEFLECTION_PX; // clamp virtual cursor to ±this

// Per-key held booleans, flipped by DOM keydown/keyup only.
const keys = {
  w: false, s: false,
  a: false, d: false,
  q: false, e: false,
};

// Virtual cursor position while pointer-locked (accumulated from movementX/Y).
let mouseX = 0;
let mouseY = 0;
let locked = false;

// Ramped digital-key contributions (separate from mouse so mouse feels raw).
let kbdPitch = 0;
let kbdRoll = 0;
let kbdYaw = 0;

let overlayEl = null;
let gestureSeen = false;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function applyDeadzone(v, dz) {
  if (v > dz) return v - dz;
  if (v < -dz) return v + dz;
  return 0;
}

function firstGesture(state) {
  if (gestureSeen) return;
  gestureSeen = true;
  audio.unlock?.(state);
}

function setOverlay(visible) {
  if (!overlayEl) return;
  overlayEl.hidden = !visible;
}

export function init(state) {
  overlayEl = document.getElementById('click-to-fly');
  const canvas = document.getElementById('game');

  // Overlay starts visible — we're not locked yet.
  setOverlay(true);

  canvas?.addEventListener('click', () => {
    firstGesture(state);
    if (!locked && canvas.requestPointerLock) {
      canvas.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (locked) {
      // Center the virtual cursor whenever we re-acquire lock.
      mouseX = 0;
      mouseY = 0;
      setOverlay(false);
    } else {
      setOverlay(true);
    }
  });

  document.addEventListener('pointerlockerror', () => {
    locked = false;
    setOverlay(true);
  });

  document.addEventListener('mousemove', (ev) => {
    if (!locked) return;
    mouseX += ev.movementX || 0;
    mouseY += ev.movementY || 0;
    if (mouseX > MOUSE_MAX_PX) mouseX = MOUSE_MAX_PX;
    else if (mouseX < -MOUSE_MAX_PX) mouseX = -MOUSE_MAX_PX;
    if (mouseY > MOUSE_MAX_PX) mouseY = MOUSE_MAX_PX;
    else if (mouseY < -MOUSE_MAX_PX) mouseY = -MOUSE_MAX_PX;
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    firstGesture(state);
    const k = ev.key.toLowerCase();
    switch (k) {
      case 'w': keys.w = true; break;
      case 's': keys.s = true; break;
      case 'a': keys.a = true; break;
      case 'd': keys.d = true; break;
      case 'q': keys.q = true; break;
      case 'e': keys.e = true; break;
      case 'r': state.input.resetRequested = true; break;
      case 'm': state.audio.muted = !state.audio.muted; break;
      default: return;
    }
  });

  window.addEventListener('keyup', (ev) => {
    const k = ev.key.toLowerCase();
    switch (k) {
      case 'w': keys.w = false; break;
      case 's': keys.s = false; break;
      case 'a': keys.a = false; break;
      case 'd': keys.d = false; break;
      case 'q': keys.q = false; break;
      case 'e': keys.e = false; break;
      default: return;
    }
  });
}

export function update(state, dt) {
  // Digital targets: W = +pitch, S = -pitch; D = +roll, A = -roll; E = +yaw, Q = -yaw.
  const pitchTarget = (keys.w ? 1 : 0) + (keys.s ? -1 : 0);
  const rollTarget  = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
  const yawTarget   = (keys.e ? 1 : 0) + (keys.q ? -1 : 0);

  // Framerate-independent exponential smoothing toward the target.
  const alpha = 1 - Math.exp(-dt * RAMP_K);
  kbdPitch += (pitchTarget - kbdPitch) * alpha;
  kbdRoll  += (rollTarget  - kbdRoll)  * alpha;
  kbdYaw   += (yawTarget   - kbdYaw)   * alpha;

  // Mouse contribution: virtual-cursor offset from center, deadzoned + normalized.
  // Vertical inverted: mouse DOWN (positive Y) → nose UP (positive pitch).
  let mousePitch = 0;
  let mouseRoll = 0;
  if (locked) {
    mousePitch = applyDeadzone(mouseY, DEADZONE_PX) / FULL_DEFLECTION_PX;
    mouseRoll  = applyDeadzone(mouseX, DEADZONE_PX) / FULL_DEFLECTION_PX;
  }

  // Merge and clamp. Mouse + keys sum, then clamp to unit throw.
  state.input.pitch = clamp(mousePitch + kbdPitch, -1, 1);
  state.input.roll  = clamp(mouseRoll  + kbdRoll,  -1, 1);
  state.input.yaw   = clamp(kbdYaw, -1, 1);
}
