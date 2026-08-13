// TODO ticket 10 — levels: 3 JSON levels + localStorage bests.

/**
 * @typedef {Object} Vec3
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {Object} LevelStart
 * @property {Vec3} pos
 * @property {Vec3} dir
 */

/**
 * @typedef {Object} LevelTarget
 * @property {Vec3} pos
 * @property {number} innerR
 * @property {number} outerR
 */

/**
 * @typedef {Object} LevelBuilding
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} w
 * @property {number} h
 * @property {number} d
 * @property {string} color
 */

/**
 * @typedef {Object} LevelThermal
 * @property {number} x
 * @property {number} z
 * @property {number} radius
 * @property {number} strength
 * @property {number} height
 */

/**
 * @typedef {Object} LevelBounds
 * @property {Vec3} min
 * @property {Vec3} max
 */

/**
 * @typedef {Object} Level
 * @property {string} name
 * @property {LevelStart} start
 * @property {LevelTarget} target
 * @property {LevelBuilding[]} buildings
 * @property {LevelThermal[]} thermals
 * @property {LevelBounds} bounds
 * @property {number} timeLimitSec
 */

export function init(state) {
  // TODO ticket 10 — load level 0 into state.level.loaded.
}

export function update(state, dt) {
  // TODO ticket 10
}
