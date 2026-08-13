// Chase camera: velocity-space anchor + critically-damped spring, plus FOV swell
// with airspeed and 35%-of-plane-bank roll damping.
//
// Framerate-independent smoothing: `lerp(a, b, 1 - exp(-k*dt))` — never per-frame
// constants. `update` runs at the fixed 120 Hz step; `render` interpolates
// between the previous and current chase snapshot by `alpha`, so the same trail
// feel holds at 30 / 60 / 144 Hz.

import * as THREE from 'three';

// ---- Design-spec tunables --------------------------------------------------
// D and UP_BIAS are the only free geometry knobs. FOV/roll/speed thresholds
// come straight from the ticket and must not drift.
const D            = 5.0;   // meters behind the plane along -velocity
const UP_BIAS      = 1.0;   // meters up (world +Y) to keep camera off the deck
const ROLL_FACTOR  = 0.35;  // camera rolls exactly 35% of plane bank (spec)
const FOV_LOW      = 62;    // degrees, at/under SPEED_LOW
const FOV_HIGH     = 78;    // degrees, at/over SPEED_HIGH
const SPEED_LOW    = 8;     // m/s, start of FOV ramp
const SPEED_HIGH   = 30;    // m/s, end of FOV ramp
const LEAD_SEC     = 2;     // 2 seconds of velocity as look-ahead distance
const LEAD_MIN     = 8;     // meters
const LEAD_MAX     = 40;    // meters
const SLOW_SPEED   = 0.5;   // below this, aim falls back to plane's forward axis

// Critically-damped-ish exp-smoothing rates (1/s). Higher = stiffer.
const SPRING_K_POS = 5.0;
const SPRING_K_ROT = 6.0;
const SPRING_K_FOV = 3.0;

// ---- Pre-allocated module scratch (no allocations in update/render) --------
const WORLD_UP      = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1); // three.js camera looks down -Z
const LOCAL_RIGHT   = new THREE.Vector3(1, 0, 0);
const LOCAL_Z       = new THREE.Vector3(0, 0, 1);

const prevPos  = new THREE.Vector3();
const prevQuat = new THREE.Quaternion();
let   prevFov  = FOV_LOW;

const currPos  = new THREE.Vector3();
const currQuat = new THREE.Quaternion();
let   currFov  = FOV_LOW;

const _aim        = new THREE.Vector3();
const _right      = new THREE.Vector3();
const _anchor     = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _lookAtMat  = new THREE.Matrix4();
const _baseQuat   = new THREE.Quaternion();
const _rollQuat   = new THREE.Quaternion();
const _renderPos  = new THREE.Vector3();
const _renderQuat = new THREE.Quaternion();

// Aim direction: velocity in world space, or plane's forward axis if too slow
// for velocity to be a meaningful direction. Writes into `out`, returns `out`.
function computeAim(plane, out) {
  const speed = plane.velocity.length();
  if (speed > SLOW_SPEED) {
    out.copy(plane.velocity).multiplyScalar(1 / speed);
  } else {
    out.copy(LOCAL_FORWARD).applyQuaternion(plane.quaternion).normalize();
  }
  return out;
}

// Target lookAt-derived orientation, with 35%-of-bank roll about local Z.
// Writes into `outQuat`.
function computeTargetQuat(plane, aim, anchor, lookTarget, outQuat) {
  // Base: level camera looking down aim, world-up as reference.
  _lookAtMat.lookAt(anchor, lookTarget, WORLD_UP);
  _baseQuat.setFromRotationMatrix(_lookAtMat);

  // Extract plane bank from the horizontal projection of its right axis.
  // right.y == sin(bank); positive when the right wing is up.
  _right.copy(LOCAL_RIGHT).applyQuaternion(plane.quaternion);
  const bank = Math.asin(THREE.MathUtils.clamp(_right.y, -1, 1));

  // Apply 35% of that bank as a local-Z rotation on the base orientation.
  // Post-multiplying by a local-Z quaternion rolls the camera about its own
  // forward-back axis (three.js: q.multiply(local) == rotate-on-local-axis).
  _rollQuat.setFromAxisAngle(LOCAL_Z, ROLL_FACTOR * bank);
  outQuat.copy(_baseQuat).multiply(_rollQuat);
}

export function init(state) {
  const plane = state.plane;

  // Seed the chase state so the first frame doesn't snap in from state.js
  // defaults. Everything derives from the plane's initial pose.
  computeAim(plane, _aim);
  _anchor.copy(plane.position)
    .addScaledVector(_aim, -D)
    .addScaledVector(WORLD_UP, UP_BIAS);
  _lookTarget.copy(plane.position).addScaledVector(_aim, LEAD_MIN);

  computeTargetQuat(plane, _aim, _anchor, _lookTarget, currQuat);
  currPos.copy(_anchor);
  currFov = FOV_LOW;

  prevPos.copy(currPos);
  prevQuat.copy(currQuat);
  prevFov = currFov;

  state.camera.chasePos.copy(currPos);
  state.camera.chaseQuat.copy(currQuat);
  state.camera.fov = currFov;
}

export function update(state, dt) {
  const plane = state.plane;

  // Snapshot the pre-step chase state so `render` can interpolate across the
  // step boundary — this is what makes 30/60/144 Hz feel identical.
  prevPos.copy(currPos);
  prevQuat.copy(currQuat);
  prevFov = currFov;

  // Target chase geometry — anchor behind plane in velocity space, biased up.
  computeAim(plane, _aim);
  _anchor.copy(plane.position)
    .addScaledVector(_aim, -D)
    .addScaledVector(WORLD_UP, UP_BIAS);

  // Look-ahead distance scales with speed, clamped to a sensible range.
  const speed = plane.velocity.length();
  const lead = THREE.MathUtils.clamp(LEAD_SEC * speed, LEAD_MIN, LEAD_MAX);
  _lookTarget.copy(plane.position).addScaledVector(_aim, lead);

  // Base + roll-damped target orientation.
  computeTargetQuat(plane, _aim, _anchor, _lookTarget, _baseQuat);

  // Linear FOV clamp between the two speed anchors.
  const t = THREE.MathUtils.clamp(
    (speed - SPEED_LOW) / (SPEED_HIGH - SPEED_LOW),
    0,
    1,
  );
  const targetFov = FOV_LOW + t * (FOV_HIGH - FOV_LOW);

  // Framerate-independent exponential smoothing.
  const aPos = 1 - Math.exp(-SPRING_K_POS * dt);
  const aRot = 1 - Math.exp(-SPRING_K_ROT * dt);
  const aFov = 1 - Math.exp(-SPRING_K_FOV * dt);

  currPos.lerp(_anchor, aPos);
  currQuat.slerp(_baseQuat, aRot);
  currQuat.normalize();
  currFov += (targetFov - currFov) * aFov;

  state.camera.chasePos.copy(currPos);
  state.camera.chaseQuat.copy(currQuat);
  state.camera.fov = currFov;
}

export function render(state, alpha) {
  const three = state.three?.camera;
  if (!three) return;

  // Interpolate the chase snapshot across the current step for a smooth image
  // regardless of the wall-clock frame rate.
  _renderPos.copy(prevPos).lerp(currPos, alpha);
  _renderQuat.copy(prevQuat).slerp(currQuat, alpha);
  const renderFov = prevFov + (currFov - prevFov) * alpha;

  three.position.copy(_renderPos);
  three.quaternion.copy(_renderQuat);
  if (Math.abs(three.fov - renderFov) > 1e-4) {
    three.fov = renderFov;
    three.updateProjectionMatrix();
  }
}
