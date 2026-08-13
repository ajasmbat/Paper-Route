// TODO ticket 2 — flight model: aerodynamics, no engine.
// Owns: state.plane (position, velocity, quaternion, angularVel, airspeed, aoa, stalled).

export function init(state) {
  // TODO ticket 2
}

export function update(state, dt) {
  // TODO ticket 2 — integrate aerodynamics at the fixed step.
}

export function render(state, alpha) {
  // TODO ticket 2 — interpolate plane mesh between prev/current step.
}
