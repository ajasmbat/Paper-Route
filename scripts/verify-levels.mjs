// Headless flight simulator — ports flight.js and thermals.js math to verify
// each level's design goals (Level 2 unreachable straight, Level 1 in-ring on
// naive glide, ...) without booting a browser.
//
// Usage: node scripts/verify-levels.mjs
//
// WARNING: constants below are copied from src/flight.js. Re-tune them here
// after any flight-model change or these reports will silently lie.

import { LEVELS } from '../src/levels.js';

const DEG = Math.PI / 180;

// ---- Aero constants (mirror src/flight.js) --------------------------------
const GRAVITY = 9.81;
const MASS = 0.02;
const TRIM_SPEED = 12;
const Q = 0.0021;

const CL_SLOPE = 4.5;
const CL_PEAK_AOA = 15 * DEG;
const CL_PEAK = CL_SLOPE * CL_PEAK_AOA;
const STALL_ON = 16 * DEG;
const STALL_FULL = 22 * DEG;
const STALL_FLOOR_FRAC = 0.4;

const CD0 = 0.045;
const K_INDUCED = 0.13;

const PITCH_AUTH = 2.5;
const ROLL_AUTH = 3.5;
const YAW_WEATHERCOCK = 1.5;
const ANG_DAMP = 4.0;
const AUTHORITY_CAP = 3.0;

const AOA_TRIM = 8 * DEG;
const PITCH_STIFFNESS = 14.0;

const STEP_DT = 1 / 120;
const MAX_STEPS = 300 * 120; // 300 seconds — trim glide from y=250 takes ~135 s

// ---- Vec3 / Quat helpers (small, allocating — this is offline) ------------

const v = (x, y, z) => ({ x, y, z });
const vc = (a) => ({ x: a.x, y: a.y, z: a.z });
const vlen = (a) => Math.hypot(a.x, a.y, a.z);
const vnorm = (a) => {
  const L = vlen(a);
  return L > 1e-9 ? { x: a.x / L, y: a.y / L, z: a.z / L } : { x: 0, y: 0, z: 0 };
};
const vsub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const vadd = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const vscl = (a, s) => v(a.x * s, a.y * s, a.z * s);
const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a, b) => v(
  a.y * b.z - a.z * b.y,
  a.z * b.x - a.x * b.z,
  a.x * b.y - a.y * b.x,
);
const qmul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qnorm = (q) => {
  const L = Math.hypot(q.x, q.y, q.z, q.w);
  return L > 1e-9 ? { x: q.x / L, y: q.y / L, z: q.z / L, w: q.w / L } : { x: 0, y: 0, z: 0, w: 1 };
};
const qApply = (q, a) => {
  const ix = q.w * a.x + q.y * a.z - q.z * a.y;
  const iy = q.w * a.y + q.z * a.x - q.x * a.z;
  const iz = q.w * a.z + q.x * a.y - q.y * a.x;
  const iw = -q.x * a.x - q.y * a.y - q.z * a.z;
  return v(
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  );
};
const qFromUnitVectors = (from, to) => {
  const d = vdot(from, to);
  if (d < -0.999999) {
    // 180° rotation about any axis perpendicular to `from`.
    const axis = Math.abs(from.x) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const p = vnorm(vcross(from, axis));
    return { x: p.x, y: p.y, z: p.z, w: 0 };
  }
  const c = vcross(from, to);
  const s = Math.sqrt((1 + d) * 2);
  return qnorm({ x: c.x / s, y: c.y / s, z: c.z / s, w: s * 0.5 });
};

// ---- Thermal sample -------------------------------------------------------

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  let t = (x - edge0) / (edge1 - edge0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

const EDGE_BAND = 6;

function sampleWind(pos, thermals) {
  let vy = 0;
  for (const t of thermals) {
    const dx = pos.x - t.x;
    const dz = pos.z - t.z;
    if (dx > t.radius || dx < -t.radius || dz > t.radius || dz < -t.radius) continue;
    const dist = Math.hypot(dx, dz);
    const wr = smoothstep(t.radius, t.radius * 0.4, dist);
    if (pos.y <= 0 || pos.y >= t.height) continue;
    const wv = smoothstep(0, EDGE_BAND, pos.y) * smoothstep(t.height, t.height - EDGE_BAND, pos.y);
    vy += wr * wv * t.strength;
  }
  return { x: 0, y: vy, z: 0 };
}

// ---- computeCL — mirror src/flight.js -------------------------------------
function computeCL(aoa) {
  const sign = aoa >= 0 ? 1 : -1;
  const a = aoa * sign;
  let cl;
  if (a <= CL_PEAK_AOA) cl = CL_SLOPE * a;
  else if (a <= STALL_ON) cl = CL_PEAK;
  else if (a >= STALL_FULL) cl = CL_PEAK * STALL_FLOOR_FRAC;
  else {
    const t = (a - STALL_ON) / (STALL_FULL - STALL_ON);
    const s = t * t * (3 - 2 * t);
    cl = CL_PEAK * (1 - (1 - STALL_FLOOR_FRAC) * s);
  }
  return cl * sign;
}

// ---- Simulator ------------------------------------------------------------

function simulate(level, { pitchInput = 0, useThermals = true, offsetX = 0 } = {}) {
  const pos = vc(level.start.pos);
  pos.x += offsetX;
  const dir = vnorm(level.start.dir);
  let vel = vscl(dir, TRIM_SPEED);
  let quat = qFromUnitVectors({ x: 0, y: 0, z: -1 }, dir);
  let angVel = v(0, 0, 0);

  const target = level.target.pos;
  const thermals = useThermals ? level.thermals : [];
  let bestDist = Infinity;
  let firstGroundDist = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    // Body axes.
    const forward = qApply(quat, { x: 0, y: 0, z: -1 });
    const up = qApply(quat, { x: 0, y: 1, z: 0 });
    const right = qApply(quat, { x: 1, y: 0, z: 0 });

    const wind = sampleWind(pos, thermals);
    const airVel = vsub(vel, wind);
    const airspeed = vlen(airVel);

    let aoa = 0;
    let lift = v(0, 0, 0);
    let drag = v(0, 0, 0);
    if (airspeed > 1e-3) {
      const airDir = vscl(airVel, 1 / airspeed);
      const along = vdot(forward, airDir);
      const above = -vdot(up, airDir);
      aoa = Math.atan2(above, along);

      const liftAxis = vcross(right, airVel);
      const liftAxisMag = vlen(liftAxis);
      const CL = computeCL(aoa);
      const CD = CD0 + K_INDUCED * CL * CL;
      const qDyn = Q * airspeed * airspeed;
      if (liftAxisMag > 1e-6) {
        lift = vscl(liftAxis, (qDyn * CL) / liftAxisMag);
        drag = vscl(airDir, -qDyn * CD);
      }
    }

    const accel = vadd(vscl(vadd(lift, drag), 1 / MASS), { x: 0, y: -GRAVITY, z: 0 });
    vel = vadd(vel, vscl(accel, STEP_DT));
    pos.x += vel.x * STEP_DT;
    pos.y += vel.y * STEP_DT;
    pos.z += vel.z * STEP_DT;

    if (pos.y < 0) {
      pos.y = 0;
      if (vel.y < 0) vel.y = 0;
    }

    // Angular dynamics.
    const authority = Math.min(airspeed / TRIM_SPEED, AUTHORITY_CAP);
    const dynRatio = (airspeed * airspeed) / (TRIM_SPEED * TRIM_SPEED);
    const pitchAero = -PITCH_STIFFNESS * (aoa - AOA_TRIM) * dynRatio;
    const pitchAccel = PITCH_AUTH * authority * pitchInput + pitchAero;
    let torque = v(0, 0, 0);
    torque = vadd(torque, vscl(right, pitchAccel));
    // No roll / yaw input for a straight-line test.
    const airDir = airspeed > 1e-3 ? vscl(airVel, 1 / airspeed) : { x: 0, y: 0, z: 0 };
    const sideSlip = airspeed > 1e-3 ? vdot(airDir, right) : 0;
    const yawAccel = -YAW_WEATHERCOCK * sideSlip * authority;
    torque = vadd(torque, vscl(up, yawAccel));

    angVel = vadd(angVel, vscl(torque, STEP_DT));
    angVel = vscl(angVel, Math.exp(-ANG_DAMP * STEP_DT));

    const omegaMag = vlen(angVel);
    if (omegaMag > 1e-6) {
      const halfAngle = omegaMag * STEP_DT * 0.5;
      const s = Math.sin(halfAngle) / omegaMag;
      const dq = { x: angVel.x * s, y: angVel.y * s, z: angVel.z * s, w: Math.cos(halfAngle) };
      quat = qnorm(qmul(dq, quat));
    }

    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dh = Math.hypot(dx, dz);
    if (dh < bestDist) bestDist = dh;
    if (firstGroundDist == null && pos.y <= 0.05) firstGroundDist = dh;

    // Stop when the plane is on the ground and moving slowly enough that
    // it's coasting to a stop.
    if (pos.y <= 0.05 && Math.abs(vel.y) < 0.5) {
      break;
    }
  }

  return {
    finalPos: pos,
    bestDist,
    firstGroundDist: firstGroundDist ?? bestDist,
    horizontalReach: Math.hypot(pos.x - level.start.pos.x, pos.z - level.start.pos.z),
  };
}

// ---- Report ---------------------------------------------------------------

function fmt(sim) {
  return `reach ${sim.horizontalReach.toFixed(0)}m, ground-dist-from-ring ${sim.firstGroundDist.toFixed(0)}m (best-approach ${sim.bestDist.toFixed(0)}m)`;
}

for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  console.log('---', i + 1, L.name, '---');
  const targetDist = Math.hypot(L.target.pos.x - L.start.pos.x, L.target.pos.z - L.start.pos.z);
  console.log(`  start y=${L.start.pos.y}, target at horiz ${targetDist.toFixed(0)}m, outerR=${L.target.outerR}, innerR=${L.target.innerR}`);
  console.log(`  neutral, no thermals    : ${fmt(simulate(L, { pitchInput: 0, useThermals: false }))}`);
  console.log(`  neutral, WITH thermals  : ${fmt(simulate(L, { pitchInput: 0, useThermals: true }))}`);
  console.log(`  pitch -0.3, no thermals : ${fmt(simulate(L, { pitchInput: -0.3, useThermals: false }))}`);
  console.log(`  pitch -0.3, WITH thermals: ${fmt(simulate(L, { pitchInput: -0.3, useThermals: true }))}`);

  // Level 1 acceptance: neutral straight glide lands inside outerR of ring.
  if (i === 0) {
    const s = simulate(L, { pitchInput: 0, useThermals: false });
    const s2 = simulate(L, { pitchInput: 0, useThermals: true });
    const inRingNoLift = s.firstGroundDist <= L.target.outerR;
    const inRingWithLift = s2.firstGroundDist <= L.target.outerR;
    console.log(`  [L1] neutral straight glide lands in outerR? no-lift=${inRingNoLift} with-lift=${inRingWithLift}`);
  }
  // Level 2 acceptance: straight glide FAILS the ring in every config.
  if (i === 1) {
    const cases = [
      simulate(L, { pitchInput: 0, useThermals: false }),
      simulate(L, { pitchInput: -0.3, useThermals: false }),
      simulate(L, { pitchInput: 0.2, useThermals: false }),
    ];
    const anyIn = cases.some((c) => c.firstGroundDist <= L.target.outerR);
    console.log(`  [L2] any straight-line reaches ring? ${anyIn} (should be FALSE)`);
    // And confirm the offset thermal is off the straight line so the detour is real.
    const t = L.thermals[0];
    const offset = Math.abs(t.x - L.start.pos.x);
    console.log(`  [L2] thermal offset from straight line: ${offset}m (should be ≥ radius ${t.radius})`);
  }
}
