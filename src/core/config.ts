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

    // ── Longitudinal ────────────────────────────────────────────────────────
    // thrust/mass = 12.86 m/s². With the drag pair below, full throttle settles
    // on topSpeed and full throttle + boost settles on boostTopSpeed, so those
    // two numbers are the actual top speeds rather than aspirations.
    /** Peak forward thrust, newtons-ish (arcade units). */
    thrust: 6100,
    reverseThrust: 2600,
    boostForce: 4000,
    /** Top speed in m/s at full throttle on flat water (~29 m/s ≈ 105 km/h). */
    topSpeed: 29,
    boostTopSpeed: 39,
    /** Drag = dragLinear·v + dragQuadratic·v|v|, in m/s². */
    dragLinear: 0.18,
    dragQuadratic: 0.00909,
    /** Extra drag per metre of draft beyond restDraft — stops bow submarining. */
    ploughDrag: 26,
    /** Engine spool. Slower up than down, so a stab of throttle has a beat of lag. */
    throttleUpRate: 2.7,
    throttleDownRate: 4.4,
    /** Fraction of thrust a propeller in mid-air still delivers. */
    airThrust: 0.3,

    // ── Yaw ─────────────────────────────────────────────────────────────────
    /** Steering authority at low and high speed — steering tightens with speed. */
    turnRateLow: 2.35,
    turnRateHigh: 1.15,
    /** How fast yaw rate chases the commanded rate. Lower = heavier. */
    yawResponse: 5.6,
    /** Yaw-rate multiplier while powersliding. */
    driftYawGain: 1.15,
    /** Steering authority while airborne, as a fraction. */
    airControl: 0.24,

    // ── Lateral ─────────────────────────────────────────────────────────────
    /** Lateral grip, as an exponential decay rate on sway. Lower = slidier. */
    lateralGrip: 12.0,
    driftGrip: 3.8,
    airGrip: 0.35,
    /** Roll induced per (yaw rate × speed) — the boat banks into its turn. */
    bankGain: 0.0085,
    /** Roll induced by sideways slip — heels away from the direction of slide. */
    slipLeanGain: 0.026,
    /** Static nose-up trim at top speed, radians. */
    planeTrim: 0.1,

    // ── Drift / boost ───────────────────────────────────────────────────────
    /** Minimum forward speed to start a powerslide, m/s. */
    driftMinSpeed: 5,
    /** Sway above this counts as a genuine slide and charges the boost. */
    driftSlipThreshold: 2.2,
    /** Fraction of surviving sway converted to surge when a drift is released. */
    driftExitKick: 0.4,
    /**
     * Fraction of the speed the grip model takes out of sway that is handed back
     * as surge. 1.0 = a frictionless redirect (cornering costs nothing), 0 = the
     * momentum is simply deleted (a hard corner is a handbrake). Cornering
     * should be nearly free; a powerslide should cost about a fifth of the boat's
     * speed, which is what makes the boost a trade rather than a freebie.
     */
    gripRecovery: 0.85,
    driftRecovery: 0.52,
    /** Seconds of clean drift needed for each boost tier. */
    driftTiers: [0.85, 1.8, 2.9],
    boostDuration: [0.75, 1.35, 2.1],

    // ── Buoyancy ────────────────────────────────────────────────────────────
    /** Buoyancy probe points sampled against the Gerstner field. */
    probeCount: 6,
    /** m/s² of lift per metre of draft. Rest draft is g / buoyancy = 0.14 m. */
    buoyancy: 70,
    /** Heave damping against the *water's* vertical velocity, not the world's. */
    buoyancyDamping: 7.2,
    /** Clamp on buoyant acceleration so a deep trough cannot fire the boat. */
    maxBuoyantAccel: 46,
    /** Draft the hull settles at on flat water, metres. Emergent, listed for clarity. */
    restDraft: 0.14,
    /** Deepest a probe can read, and the hard anti-tunnelling floor. */
    maxDraft: 0.85,
    /** Vertical lift per (speed² × submersion) — the hull climbs onto its bow wave. */
    planingLift: 0.0008,

    // ── Attitude springs. ω = √(stiffness · probe inertia). ──────────────────
    pitchStiffness: 17,
    pitchDamping: 2.8,
    rollStiffness: 90,
    rollDamping: 3.2,
    /** Nose-up pitch-rate impulse per m/s of landing impact. */
    slamPitchKick: 0.075,

    /** Airtime detection: every probe this far above the surface = airborne. */
    airborneThreshold: 0.45,

    // ── Collision ───────────────────────────────────────────────────────────
    /** Radius of each of the two spheres approximating a hull. */
    collisionRadius: 1.0,
    collisionRestitution: 0.42,
    /** Yaw impulse per m/s of closing speed. */
    collisionSpin: 0.055,
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
