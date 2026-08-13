import * as THREE from 'three';

// Shared mutable game state singleton. Every module reads and mutates this.
// Hot-path rule: no allocations inside `update`. Use `state.scratch.*` below.

export const state = {
  plane: {
    position: new THREE.Vector3(0, 100, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    quaternion: new THREE.Quaternion(),
    angularVel: new THREE.Vector3(0, 0, 0),
    airspeed: 0,
    aoa: 0,
    stalled: false,
    // Previous-step snapshot for render interpolation.
    prevPosition: new THREE.Vector3(0, 100, 0),
    prevQuaternion: new THREE.Quaternion(),
  },

  input: {
    pitch: 0,        // -1..1
    roll: 0,         // -1..1
    throttleIsh: 0,  // -1..1
  },

  level: {
    index: 0,
    loaded: null,    // Ticket 10 will assign a level JSON
  },

  camera: {
    fov: 70,
    chasePos: new THREE.Vector3(0, 100, 0),
    chaseQuat: new THREE.Quaternion(),
  },

  hud: {
    alt: 0,
    speed: 0,
    distToTarget: 0,
    bearingDeg: 0,
    stalled: false,
    failMsg: '',
  },

  audio: {
    muted: false,
  },

  thermals: {
    // Index into the currently-loaded thermal array of the thermal the plane
    // is inside (w * strength argmax), or -1. Ticket 6 fires the catch sound
    // on transition from -1 → i; Ticket 5 uses it for the FOV swell trigger.
    activeThermalIndex: -1,
  },

  time: {
    elapsed: 0,      // seconds since app start (integrated in fixed steps)
    stepDt: 1 / 120, // fixed timestep
  },

  // Pre-allocated scratch. Do NOT `new` anything inside update loops.
  scratch: {
    v0: new THREE.Vector3(),
    v1: new THREE.Vector3(),
    v2: new THREE.Vector3(),
    v3: new THREE.Vector3(),
    v4: new THREE.Vector3(),
    v5: new THREE.Vector3(),
    q0: new THREE.Quaternion(),
    q1: new THREE.Quaternion(),
    q2: new THREE.Quaternion(),
    m0: new THREE.Matrix4(),
    e0: new THREE.Euler(),
  },
};

export default state;
