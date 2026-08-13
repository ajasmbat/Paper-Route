// Hand-rolled aerodynamic flight model for the paper plane.
// Owns: state.plane.{position, velocity, quaternion, angularVel, airspeed, aoa, stalled}.
//
// Hot-path rule: zero allocations inside update / interpolate / render.
// Every Vector3 / Quaternion below is module-scope scratch, reused each step.

import * as THREE from 'three';

const DEG = Math.PI / 180;

// ---- Aero constants ------------------------------------------------------
// Tuned empirically so neutral-input glide from y=200 with V=12 m/s settles
// around a 6:1 glide (~1200 m horizontal) at ~12 m/s trim.
const GRAVITY = 9.81;
const MASS = 0.02;            // kg — 20 g paper airplane
const TRIM_SPEED = 12;        // m/s
const Q = 0.0021;             // combined 0.5 * rho * S (kg/m)

const CL_SLOPE = 4.5;         // per radian
const CL_PEAK_AOA = 15 * DEG;
const CL_PEAK = CL_SLOPE * CL_PEAK_AOA;
const STALL_ON = 16 * DEG;
const STALL_FULL = 22 * DEG;
const STALL_FLOOR_FRAC = 0.4; // recoverable — CL drops to 40% of peak, not zero

const CD0 = 0.045;            // parasite drag coeff
const K_INDUCED = 0.13;       // induced-drag factor (Cdi = k * CL²)

// ---- Control constants ---------------------------------------------------
// Authority scales linearly with airspeed / TRIM_SPEED. Capped generously
// so a 6:1 airspeed range still delivers ~5-6x rotation-rate range without
// letting the plane tumble at absurd speeds.
const PITCH_AUTH = 2.5;       // rad/s² per unit input at trim speed
const ROLL_AUTH  = 3.5;
const YAW_WEATHERCOCK = 1.5;  // yaw torque proportional to sideslip
const ANG_DAMP = 4.0;         // per second, on angular velocity
const AUTHORITY_CAP = 3.0;    // limits authority at very high airspeed

// Aerodynamic pitch stability — mimics a tail/dihedral, without one.
// Restoring pitch moment proportional to (aoa - AOA_TRIM), scaled by dynamic
// pressure. This is what lets the plane recover from a stall on its own.
const AOA_TRIM = 8 * DEG;
const PITCH_STIFFNESS = 14.0; // rad/s² per rad AoA deviation, at trim speed

// ---- Module-scope scratch (zero-alloc in hot path) -----------------------
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _airVel = new THREE.Vector3();
const _airDir = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _drag = new THREE.Vector3();
const _grav = new THREE.Vector3(0, -GRAVITY, 0);
const _accel = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _deltaQ = new THREE.Quaternion();

const _interpPos = new THREE.Vector3();
const _interpQuat = new THREE.Quaternion();
const _interpOut = { position: _interpPos, quaternion: _interpQuat };

let planeMesh = null;

// ---- Aero helpers --------------------------------------------------------

// CL curve: linear rise, flat tiny plateau 15-16°, smoothstep drop to 40% by 22°.
// Mirrored on the negative side so pushing over past -16° also stalls.
function computeCL(aoa) {
  const sign = aoa >= 0 ? 1 : -1;
  const a = aoa * sign;
  let cl;
  if (a <= CL_PEAK_AOA)      cl = CL_SLOPE * a;
  else if (a <= STALL_ON)    cl = CL_PEAK;
  else if (a >= STALL_FULL)  cl = CL_PEAK * STALL_FLOOR_FRAC;
  else {
    const t = (a - STALL_ON) / (STALL_FULL - STALL_ON);
    const s = t * t * (3 - 2 * t);
    cl = CL_PEAK * (1 - (1 - STALL_FLOOR_FRAC) * s);
  }
  return cl * sign;
}

// A minimal paper-airplane silhouette: nose + two wing tris + a triangular fin.
function buildPaperPlaneGeom() {
  const s = 0.75; // overall size (m)
  const verts = new Float32Array([
    0.0,        0.0,      -1.3 * s,   // 0 nose
    0.0,        0.0,       0.4 * s,   // 1 tail-center
   -0.85 * s,   0.0,       0.25 * s,  // 2 left wingtip
    0.85 * s,   0.0,       0.25 * s,  // 3 right wingtip
    0.0,        0.30 * s,  0.4 * s,   // 4 fin top (ridge above tail)
  ]);
  const indices = [
    0, 1, 2,   // left wing
    0, 3, 1,   // right wing
    0, 4, 1,   // vertical fin (double-sided material handles both faces)
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// ---- Module lifecycle ----------------------------------------------------

export function init(state) {
  // If nobody has launched us yet, kick off with trim-speed forward velocity
  // so the dev scene shows an actual glide instead of a rock dropping.
  if (state.plane.velocity.lengthSq() === 0) {
    state.plane.velocity.set(0, 0, -TRIM_SPEED);
  }
  state.plane.prevPosition.copy(state.plane.position);
  state.plane.prevQuaternion.copy(state.plane.quaternion);

  const geom = buildPaperPlaneGeom();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xddd3be,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  planeMesh = new THREE.Mesh(geom, mat);
  planeMesh.position.copy(state.plane.position);
  planeMesh.quaternion.copy(state.plane.quaternion);
  state.three.scene.add(planeMesh);
  state.plane.mesh = planeMesh;

  // Crease seams in --deep, drawn on top of the wing/fin faces.
  // Order matches buildPaperPlaneGeom(): 0 nose, 1 tail, 2 L-tip, 3 R-tip, 4 fin.
  const s = 0.75;
  const V = [
    [0.0,       0.0,     -1.3 * s],  // 0
    [0.0,       0.0,      0.4 * s],  // 1
    [-0.85 * s, 0.0,      0.25 * s], // 2
    [0.85 * s,  0.0,      0.25 * s], // 3
    [0.0,       0.30 * s, 0.4 * s],  // 4
  ];
  const seamPairs = [
    [0, 1], // spine crease
    [0, 4], // fin leading edge
    [4, 1], // fin trailing edge
    [1, 2], // left wing/body fold
    [1, 3], // right wing/body fold
  ];
  const creasePositions = new Float32Array(seamPairs.length * 2 * 3);
  for (let i = 0; i < seamPairs.length; i++) {
    const [a, b] = seamPairs[i];
    creasePositions.set(V[a], i * 6);
    creasePositions.set(V[b], i * 6 + 3);
  }
  const creaseGeom = new THREE.BufferGeometry();
  creaseGeom.setAttribute('position', new THREE.BufferAttribute(creasePositions, 3));
  const creaseMat = new THREE.LineBasicMaterial({ color: 0x12162B, linewidth: 1 });
  const creases = new THREE.LineSegments(creaseGeom, creaseMat);
  planeMesh.add(creases);
}

export function update(state, dt) {
  const p = state.plane;

  // Snapshot for render interpolation.
  p.prevPosition.copy(p.position);
  p.prevQuaternion.copy(p.quaternion);

  // Body axes in world frame.
  _forward.set(0, 0, -1).applyQuaternion(p.quaternion);
  _up.set(0, 1, 0).applyQuaternion(p.quaternion);
  _right.set(1, 0, 0).applyQuaternion(p.quaternion);

  // Wind at plane position (thermals module may not be initialised yet).
  _wind.set(0, 0, 0);
  const thermals = state.thermals;
  if (thermals && thermals.sampleAt) {
    thermals.sampleAt(p.position, _wind);
  }

  // Air-relative velocity — everything aerodynamic uses this, not ground vel.
  _airVel.copy(p.velocity).sub(_wind);
  const airspeed = _airVel.length();
  p.airspeed = airspeed;

  // AoA — angle between body forward and air velocity, in the body pitch plane.
  // Positive AoA = nose above the relative wind.
  let aoa = 0;
  let liftAxisMag = 0;
  if (airspeed > 1e-3) {
    _airDir.copy(_airVel).multiplyScalar(1 / airspeed);
    const along = _forward.dot(_airDir);
    const above = -_up.dot(_airDir);
    aoa = Math.atan2(above, along);

    // Lift direction: cross(right, airVel) then normalize.
    _lift.copy(_right).cross(_airVel);
    liftAxisMag = _lift.length();
  }
  p.aoa = aoa;
  p.stalled = aoa > STALL_ON;

  const CL = computeCL(aoa);
  const CD = CD0 + K_INDUCED * CL * CL;

  if (liftAxisMag > 1e-6) {
    const qDyn = Q * airspeed * airspeed;
    _lift.multiplyScalar((qDyn * CL) / liftAxisMag);
    _drag.copy(_airDir).multiplyScalar(-qDyn * CD);
  } else {
    _lift.set(0, 0, 0);
    _drag.set(0, 0, 0);
  }

  // Linear acceleration = (lift + drag)/mass + gravity.
  _accel.copy(_lift).add(_drag).multiplyScalar(1 / MASS).add(_grav);

  p.velocity.addScaledVector(_accel, dt);
  p.position.addScaledVector(p.velocity, dt);

  // Cheap ground clamp so the sim doesn't sink to -infinity while other
  // tickets fill in real terrain / crash handling.
  if (p.position.y < 0) {
    p.position.y = 0;
    if (p.velocity.y < 0) p.velocity.y = 0;
  }

  // ---- Angular dynamics ----
  // Control authority scales with airspeed so a slow plane handles like a brick.
  const authority = Math.min(airspeed / TRIM_SPEED, AUTHORITY_CAP);

  // Positive pitch input = nose up = positive rotation around +right axis.
  // Add a tail-like restoring moment proportional to AoA deviation from trim,
  // scaled by dynamic pressure (airspeed² / trim²). This provides pitch
  // stability and lets the plane recover after a stall on its own.
  const dynPressureRatio = (airspeed * airspeed) / (TRIM_SPEED * TRIM_SPEED);
  const pitchAeroMoment = -PITCH_STIFFNESS * (aoa - AOA_TRIM) * dynPressureRatio;
  const pitchAccel = PITCH_AUTH * authority * state.input.pitch + pitchAeroMoment;
  // Positive roll input = roll right = positive rotation around +forward axis.
  const rollAccel  = ROLL_AUTH  * authority * state.input.roll;
  // Weathercock — yaw the nose toward the relative wind (kills sideslip and
  // makes banked turns coordinate naturally).
  const sideSlip = airspeed > 1e-3 ? _airDir.dot(_right) : 0;
  const yawAccel = -YAW_WEATHERCOCK * sideSlip * authority;

  _torque.set(0, 0, 0);
  _torque.addScaledVector(_right,   pitchAccel);
  _torque.addScaledVector(_forward, rollAccel);
  _torque.addScaledVector(_up,      yawAccel);

  p.angularVel.addScaledVector(_torque, dt);
  p.angularVel.multiplyScalar(Math.exp(-ANG_DAMP * dt));

  // Integrate quaternion from world-space angular velocity.
  const omegaMag = p.angularVel.length();
  if (omegaMag > 1e-6) {
    const halfAngle = omegaMag * dt * 0.5;
    const s = Math.sin(halfAngle) / omegaMag;
    _deltaQ.set(
      p.angularVel.x * s,
      p.angularVel.y * s,
      p.angularVel.z * s,
      Math.cos(halfAngle),
    );
    p.quaternion.premultiply(_deltaQ).normalize();
  }
}

// Lerp position + slerp quaternion between the previous and current step.
// Returns a stable module-scope object — do not retain references across frames.
export function interpolate(state, alpha) {
  const p = state.plane;
  _interpPos.copy(p.prevPosition).lerp(p.position, alpha);
  _interpQuat.copy(p.prevQuaternion).slerp(p.quaternion, alpha);
  return _interpOut;
}

export function render(state, alpha) {
  if (!planeMesh) return;
  const pose = interpolate(state, alpha);
  planeMesh.position.copy(pose.position);
  planeMesh.quaternion.copy(pose.quaternion);
}
