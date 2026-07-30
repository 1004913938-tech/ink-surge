/**
 * Global tunables. Anything a designer would want to twiddle lives here so the
 * subsystems stay free of magic numbers.
 */

export const CONFIG = {
  render: {
    /** Retina cap. The adaptive controller scales between min and max. */
    maxPixelRatio: 2.0,
    minPixelRatio: 0.75,
    /** Target frame budget in ms. Above this the resolution scaler backs off. */
    frameBudgetMs: 16.6,
    fov: 58,
    near: 0.35,
    far: 4200,
    /** Extra FOV added at top speed, degrees. */
    fovSpeedKick: 13,
  },

  ocean: {
    /** Half-extent of the simulated ocean grid in metres. */
    extent: 2600,
    /** Vertices along one edge of the highest-detail ring. */
    baseResolution: 192,
    /** Number of concentric LOD rings around the camera. */
    lodRings: 5,
    /** World units the ocean re-centres by (snapped, to avoid vertex swimming). */
    snap: 4.0,
  },

  boat: {
    /** Metres. Hull is modelled around these. */
    length: 4.6,
    beam: 1.9,
    mass: 420,
    /** Peak forward thrust, newtons-ish (arcade units). */
    thrust: 15800,
    reverseThrust: 5200,
    /** Top speed in m/s at full throttle on flat water (~29 m/s ≈ 105 km/h). */
    topSpeed: 29,
    boostTopSpeed: 39,
    /** Steering authority at low and high speed — steering tightens with speed. */
    turnRateLow: 2.35,
    turnRateHigh: 1.15,
    /** Lateral grip. Lower = slidier. Drops hard during a powerslide. */
    lateralGrip: 5.6,
    driftGrip: 1.15,
    /** Seconds of clean drift needed for each boost tier. */
    driftTiers: [0.85, 1.8, 2.9],
    boostDuration: [0.75, 1.35, 2.1],
    boostForce: 21000,
    /** Buoyancy probe points sampled against the Gerstner field. */
    probeCount: 6,
    buoyancy: 12.4,
    buoyancyDamping: 2.6,
    /** Airtime detection: hull centre this far above the surface = airborne. */
    airborneThreshold: 0.55,
  },

  race: {
    laps: 3,
    racerCount: 4,
    countdownSeconds: 4.0,
    /** Radius within which a checkpoint gate counts as passed. */
    gateRadius: 17,
    /** Dot product below this against track forward = going the wrong way. */
    wrongWayDot: -0.35,
  },

  ai: {
    /** Lookahead distance along the spline, metres, scaled by speed. */
    lookaheadBase: 14,
    lookaheadPerSpeed: 0.95,
    /** Rubber-banding: max +/- fraction of top speed applied by distance. */
    rubberBand: 0.11,
    avoidRadius: 6.5,
  },

  camera: {
    /** Chase rig offsets in the boat's local frame. */
    distance: 11.2,
    height: 4.15,
    lookAhead: 9.0,
    /** Critically-damped spring constants. */
    posStiffness: 9.5,
    rotStiffness: 7.0,
    shakeDecay: 3.4,
  },

  audio: {
    masterGain: 0.62,
    engineGain: 0.3,
    waterGain: 0.28,
  },

  debug: {
    /** Set by ?debug=1 — draws probe points, spline frames, LOD ring colours. */
    enabled: new URLSearchParams(location.search).has('debug'),
    /** Set by ?harness=1 — deterministic time, no audio, harness API exposed. */
    harness: new URLSearchParams(location.search).has('harness'),
  },
} as const;

export type Config = typeof CONFIG;
