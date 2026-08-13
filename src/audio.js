// TODO ticket 6 — WebAudio wind + thermal catch + mute.

export function init(state) {
  // TODO ticket 6 — create AudioContext, wire nodes; do not resume until user gesture.
}

export function update(state, dt) {
  // TODO ticket 6 — modulate wind gain from state.plane.airspeed.
}

export function unlock(state) {
  // TODO ticket 6 — resume() the AudioContext on first user gesture.
}
