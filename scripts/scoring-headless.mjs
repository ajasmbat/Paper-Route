// Ad-hoc headless verify of the scoring state machine.
// Stubs a minimal state and drives update() through each fail/success path.
//
// This isn't a formal test — just a smoke check that the copy strings match
// the ticket contract and that R restarts/advances correctly.

// Stub DOM before importing modules (audio/camera reach for window/canvas).
globalThis.window = { AudioContext: null, webkitAudioContext: null };
globalThis.document = { getElementById: () => null, querySelector: () => null, addEventListener: () => {} };
globalThis.HTMLCanvasElement = class {};

import * as THREE from 'three';
import * as scoring from '../src/scoring.js';
import { LEVELS } from '../src/levels.js';
import { readFileSync } from 'node:fs';

// world.collideSphere returns false without a loaded level (grid is null),
// so these tests exercise the non-collision paths. The collision copy is
// verified via a source-string check at the bottom of the file.

// Fake state singleton — mirrors the shape scoring reads/writes.
function makeState() {
  const level = LEVELS[0];
  return {
    plane: {
      position: new THREE.Vector3(0, 200, 0),
      velocity: new THREE.Vector3(0, 0, -12),
      prevPosition: new THREE.Vector3(0, 200, 0),
      quaternion: new THREE.Quaternion(),
    },
    input: { resetRequested: false, pitch: 0, roll: 0, yaw: 0 },
    hud: { failMsg: '' },
    audio: { muted: false },
    thermals: { activeThermalIndex: -1 },
    time: { elapsed: 0, stepDt: 1/120 },
    level: {
      index: 0,
      loaded: level,
      load: function (i) {
        this.index = i;
        this.loaded = LEVELS[i];
      },
      recordBest: () => true,
      getBest: () => 42,
    },
    scratch: { v0: new THREE.Vector3() },
    three: { scene: null, renderer: null, camera: null },
    camera: {
      fov: 70,
      chasePos: new THREE.Vector3(),
      chaseQuat: new THREE.Quaternion(),
    },
  };
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) console.log(`  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
}

// ---- Test 1: OOB failure copy --------------------------------------------
{
  const s = makeState();
  scoring.init(s);
  s.plane.position.x = -9999; // way outside bounds.min.x = -500
  scoring.update(s, 1/120);
  assertEq(s.hud.failMsg, 'Drifted off the map. Press R to retry.', 'OOB copy');
}

// ---- Test 2: Building collision copy (source-string check) --------------
{
  const src = readFileSync(new URL('../src/scoring.js', import.meta.url), 'utf8');
  const hasCopy = src.includes('Clipped a tower. Press R to retry.');
  const callsPlayCrash = /audio\.playCrash\?\.\(\)[\s\S]{0,120}Clipped a tower/.test(src);
  assertEq(hasCopy, true, 'Source contains "Clipped a tower" copy');
  assertEq(callsPlayCrash, true, 'Source calls audio.playCrash() before "Clipped a tower"');
}

// ---- Test 3: Hard landing inside ring -----------------------------------
{
  const s = makeState();
  scoring.init(s);
  // Touchdown edge with a big pre-clamp fall velocity. prevPlaneVy will be
  // seeded by init() from the current velocity.y (0 initially since we haven't
  // fallen yet). We need to drive one step to set prevPlaneVy first.
  s.plane.position.set(0, 1.0, LEVELS[0].target.pos.z); // above target, inside ring
  s.plane.prevPosition.set(0, 1.0, LEVELS[0].target.pos.z);
  s.plane.velocity.set(0, -20, -12);
  scoring.update(s, 1/120); // seeds prevPlaneVy = -20
  // Now simulate touchdown: prevPos.y > 0.1, pos.y = 0, velocity.y clamped 0.
  s.plane.prevPosition.set(0, 0.5, LEVELS[0].target.pos.z);
  s.plane.position.set(0, 0, LEVELS[0].target.pos.z);
  s.plane.velocity.set(0, 0, -12); // simulate clamp
  scoring.update(s, 1/120);
  assertEq(s.hud.failMsg, 'Came in too hot. Press R to retry.', 'Hard-landing copy');
}

// ---- Test 4: Soft landing inside inner ring — success -------------------
{
  const s = makeState();
  scoring.init(s);
  s.plane.position.set(0, 1.0, LEVELS[0].target.pos.z);
  s.plane.prevPosition.set(0, 1.0, LEVELS[0].target.pos.z);
  s.plane.velocity.set(0, -3, -12);
  scoring.update(s, 1/120); // prevPlaneVy = -3
  s.plane.prevPosition.set(0, 0.5, LEVELS[0].target.pos.z);
  s.plane.position.set(0, 0, LEVELS[0].target.pos.z);
  s.plane.velocity.set(0, 0, -12);
  scoring.update(s, 1/120);
  const hasSuccess = s.hud.failMsg.includes('Landed!') && s.hud.failMsg.includes('Press R for next level.');
  assertEq(hasSuccess, true, `Soft landing success copy: ${JSON.stringify(s.hud.failMsg)}`);
}

// ---- Test 5: Landing short ----------------------------------------------
{
  const s = makeState();
  scoring.init(s);
  // Land 200m short of target on the z axis (target z = -1220).
  const target = LEVELS[0].target.pos;
  s.plane.position.set(0, 1.0, target.z + 200); // z = -1020, 200m closer to start
  s.plane.prevPosition.set(0, 1.0, target.z + 200);
  s.plane.velocity.set(0, -3, -12);
  scoring.update(s, 1/120);
  s.plane.prevPosition.set(0, 0.5, target.z + 200);
  s.plane.position.set(0, 0, target.z + 200);
  s.plane.velocity.set(0, 0, -12);
  scoring.update(s, 1/120);
  assertEq(s.hud.failMsg, 'Landed short. Press R to retry.', 'Landed short copy');
}

// ---- Test 6: Landing wide (past target) ---------------------------------
{
  const s = makeState();
  scoring.init(s);
  const target = LEVELS[0].target.pos;
  s.plane.position.set(0, 1.0, target.z - 200); // past target
  s.plane.prevPosition.set(0, 1.0, target.z - 200);
  s.plane.velocity.set(0, -3, -12);
  scoring.update(s, 1/120);
  s.plane.prevPosition.set(0, 0.5, target.z - 200);
  s.plane.position.set(0, 0, target.z - 200);
  s.plane.velocity.set(0, 0, -12);
  scoring.update(s, 1/120);
  assertEq(s.hud.failMsg, 'Landed wide. Press R to retry.', 'Landed wide copy');
}

// ---- Test 7: R on failure reloads current, on success advances ----------
{
  const s = makeState();
  scoring.init(s);
  s.plane.position.x = -9999;
  scoring.update(s, 1/120); // → failure
  s.plane.position.set(0, 200, 0); // move back inside bounds
  s.input.resetRequested = true;
  scoring.update(s, 1/120);
  assertEq(s.level.index, 0, 'R on failure keeps current level index');
  assertEq(s.input.resetRequested, false, 'resetRequested is consumed');
  assertEq(s.hud.failMsg, '', 'failMsg cleared on reset');
}
{
  const s = makeState();
  scoring.init(s);
  // Force a success.
  s.plane.position.set(0, 1.0, LEVELS[0].target.pos.z);
  s.plane.prevPosition.set(0, 1.0, LEVELS[0].target.pos.z);
  s.plane.velocity.set(0, -3, -12);
  scoring.update(s, 1/120);
  s.plane.prevPosition.set(0, 0.5, LEVELS[0].target.pos.z);
  s.plane.position.set(0, 0, LEVELS[0].target.pos.z);
  s.plane.velocity.set(0, 0, -12);
  scoring.update(s, 1/120);
  // Now press R.
  s.plane.position.set(0, 200, 0);
  s.input.resetRequested = true;
  scoring.update(s, 1/120);
  assertEq(s.level.index, 1, 'R on success advances index');
}
{
  const s = makeState();
  scoring.init(s);
  s.level.index = 2; // pretend we're on level 3
  s.level.loaded = LEVELS[2];
  s.plane.position.set(0, 1.0, LEVELS[2].target.pos.z);
  s.plane.prevPosition.set(0, 1.0, LEVELS[2].target.pos.z);
  s.plane.velocity.set(0, -3, -12);
  scoring.update(s, 1/120);
  s.plane.prevPosition.set(0, 0.5, LEVELS[2].target.pos.z);
  s.plane.position.set(0, 0, LEVELS[2].target.pos.z);
  s.plane.velocity.set(0, 0, -12);
  scoring.update(s, 1/120);
  s.plane.position.set(0, 200, 0);
  s.input.resetRequested = true;
  scoring.update(s, 1/120);
  assertEq(s.level.index, 0, 'R on success from level 3 wraps to 0');
}

console.log('---');
console.log('Headless scoring smoke check complete.');
