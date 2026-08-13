// WebAudio-only audio layer for Paper Route.
//
// Wind bed: looped pink-noise buffer → bandpass → wind gain → master.
// Cutoff and gain track state.plane.airspeed once per frame.
//
// One-shots (thermal catch, crash, landing) build small transient graphs
// per fire — WebAudio idiom, and not in the flight-model hot path.
//
// Autoplay policy: nothing plays until unlock() is called from a user
// gesture (Ticket 8 wires this up on first pointer-lock / keydown).

const WIND_BUFFER_SECONDS = 3;
const BANDPASS_Q = 1.2;

// Airspeed → wind mapping (exponential in frequency, linear in gain).
const AIRSPEED_MIN = 5;
const AIRSPEED_MAX = 30;
const CUTOFF_MIN_HZ = 350;
const CUTOFF_MAX_HZ = 4200;
const WIND_GAIN_MIN = 0.02;
const WIND_GAIN_MAX = 0.35;

// setTargetAtTime time constants — short enough to feel responsive,
// long enough to stay click-free.
const WIND_PARAM_TC = 0.08;   // ~80ms follower on filter+gain
const MUTE_RAMP_TC = 0.008;   // ~30-40ms perceived fade on master

const MASTER_GAIN_TARGET = 0.9;

// Module-level singletons — one AudioContext per app.
let ctx = null;
let masterGain = null;
let windSource = null;
let windFilter = null;
let windGain = null;
let started = false;      // wind source .start() called
let prevActiveThermal = -1;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Voss-McCartney pink noise — cheap and good enough for a wind bed.
function fillPinkNoise(channelData) {
  const n = channelData.length;
  const rows = 16;
  const buf = new Float32Array(rows);
  let runningSum = 0;
  let counter = 0;
  for (let i = 0; i < n; i++) {
    counter++;
    // Find the lowest bit that changed — determines which row updates.
    let row = 0;
    let c = counter;
    while ((c & 1) === 0 && row < rows - 1) {
      c >>= 1;
      row++;
    }
    const old = buf[row];
    const val = Math.random() * 2 - 1;
    buf[row] = val;
    runningSum += val - old;
    // Extra white row keeps high-frequency content.
    const white = Math.random() * 2 - 1;
    channelData[i] = (runningSum + white) / (rows + 1);
  }
}

function buildWindBuffer(context) {
  const length = Math.floor(context.sampleRate * WIND_BUFFER_SECONDS);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  fillPinkNoise(buffer.getChannelData(0));
  return buffer;
}

function airspeedToCutoff(airspeed) {
  const t = clamp(
    (airspeed - AIRSPEED_MIN) / (AIRSPEED_MAX - AIRSPEED_MIN),
    0,
    1,
  );
  // Exponential (log-linear) — pitch perception is log.
  const logMin = Math.log(CUTOFF_MIN_HZ);
  const logMax = Math.log(CUTOFF_MAX_HZ);
  return Math.exp(lerp(logMin, logMax, t));
}

function airspeedToWindGain(airspeed) {
  const t = clamp(
    (airspeed - AIRSPEED_MIN) / (AIRSPEED_MAX - AIRSPEED_MIN),
    0,
    1,
  );
  return lerp(WIND_GAIN_MIN, WIND_GAIN_MAX, t);
}

export function init(state) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();

  masterGain = ctx.createGain();
  // Start silent — mute state is applied by first update(), and the
  // context is suspended until unlock() anyway.
  masterGain.gain.value = state.audio.muted ? 0 : MASTER_GAIN_TARGET;
  masterGain.connect(ctx.destination);

  const buffer = buildWindBuffer(ctx);
  windSource = ctx.createBufferSource();
  windSource.buffer = buffer;
  windSource.loop = true;

  windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass';
  windFilter.frequency.value = CUTOFF_MIN_HZ;
  windFilter.Q.value = BANDPASS_Q;

  windGain = ctx.createGain();
  windGain.gain.value = WIND_GAIN_MIN;

  windSource.connect(windFilter);
  windFilter.connect(windGain);
  windGain.connect(masterGain);

  prevActiveThermal = -1;
}

export function unlock(state) {
  if (!ctx) return Promise.resolve();
  const resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
  return resumed.then(() => {
    if (!started && windSource) {
      windSource.start(0);
      started = true;
    }
  });
}

export function update(state, dt) {
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;

  // Mute ramp — cheap to set every frame; setTargetAtTime is idempotent
  // when the target already matches.
  const targetMaster = state.audio.muted ? 0 : MASTER_GAIN_TARGET;
  masterGain.gain.setTargetAtTime(targetMaster, now, MUTE_RAMP_TC);

  // Wind follows airspeed.
  const airspeed = state.plane?.airspeed ?? 0;
  windFilter.frequency.setTargetAtTime(
    airspeedToCutoff(airspeed),
    now,
    WIND_PARAM_TC,
  );
  windGain.gain.setTargetAtTime(
    airspeedToWindGain(airspeed),
    now,
    WIND_PARAM_TC,
  );

  // Thermal catch edge detection.
  const active = state.thermals?.activeThermalIndex ?? -1;
  if (prevActiveThermal === -1 && active !== -1) {
    fireThermalCatch();
  }
  prevActiveThermal = active;
}

// ---- One-shot SFX ---------------------------------------------------------

function fireThermalCatch() {
  if (!ctx) return;
  const now = ctx.currentTime;

  // Sine sweep 200 → 800Hz over 180ms — the "aha" pitch rise.
  const sweep = ctx.createOscillator();
  sweep.type = 'sine';
  sweep.frequency.setValueAtTime(200, now);
  sweep.frequency.exponentialRampToValueAtTime(800, now + 0.18);

  const sweepGain = ctx.createGain();
  sweepGain.gain.setValueAtTime(0.0001, now);
  sweepGain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

  sweep.connect(sweepGain).connect(masterGain);
  sweep.start(now);
  sweep.stop(now + 0.4);

  // Shaped noise burst — the "whoosh" tail.
  const noiseLen = Math.floor(ctx.sampleRate * 0.25);
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.setValueAtTime(600, now);
  noiseFilter.frequency.exponentialRampToValueAtTime(2200, now + 0.2);
  noiseFilter.Q.value = 0.8;

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.2, now + 0.03);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

  noise.connect(noiseFilter).connect(noiseGain).connect(masterGain);
  noise.start(now);
  noise.stop(now + 0.3);
}

export function playCrash() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;

  // Low-frequency sine thump — 90Hz → 30Hz over 250ms.
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(90, now);
  thump.frequency.exponentialRampToValueAtTime(30, now + 0.25);

  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.0001, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.7, now + 0.01);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

  thump.connect(thumpGain).connect(masterGain);
  thump.start(now);
  thump.stop(now + 0.45);

  // Rough noise crack layered on top.
  const noiseLen = Math.floor(ctx.sampleRate * 0.25);
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 500;

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.4, now + 0.005);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

  noise.connect(noiseFilter).connect(noiseGain).connect(masterGain);
  noise.start(now);
  noise.stop(now + 0.25);
}

export function playLanding() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;

  // Two-note sine chime — 880Hz then 1320Hz (a perfect fifth up).
  playChimeTone(880, now, 0.6);
  playChimeTone(1320, now + 0.12, 0.7);
}

function playChimeTone(freq, when, duration) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.25, when + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration);

  osc.connect(g).connect(masterGain);
  osc.start(when);
  osc.stop(when + duration + 0.05);
}
