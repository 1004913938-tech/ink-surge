/**
 * INK TIDE — rider rig: skeleton + procedural cel geometry.
 *
 * ── Why a hand-rolled skin instead of THREE.SkinnedMesh ─────────────────────
 * The cel pipeline owns the vertex stage: `createCelMaterial` builds the main,
 * prepass and outline materials from *one* set of vertex chunks, and the
 * inverted-hull outline pushes along `aSmoothNormal` inside that same stage.
 * Three's skinning lives in `MeshStandardMaterial`-style shader chunks we do
 * not have (and must not add — no PBR). So the skinning is a `chunks.vertexBody`
 * snippet: two bone matrices per vertex, a scalar blend weight, applied to
 * `transformed`, `objectNormal` *and* `smoothNormal`. Because all three
 * materials share the chunk, the outline hull and the G-buffer deform with the
 * pose for free — which is the whole reason the chunk hook exists.
 *
 * ── Why one merged geometry per rider ───────────────────────────────────────
 * The perf contract says a rider is ~12 parts and must not cost 12 draw calls.
 * Every part of a rider is emitted into one of *two* merged BufferGeometries —
 * `soft` (suit, skin, gloves, scarf) and `hard` (helmet, visor, pads, boots) —
 * split only because those two families want different specular/rim treatment.
 * Part colour is carried per-vertex in a custom `aTint` attribute and multiplied
 * into `baseColor` in `chunks.fragmentBody`, so one material paints a dozen
 * palette tones. That is 2 shaded meshes + 2 outline hulls = 4 draw calls per
 * rider.
 *
 * (`aTint` rather than the material's `vertexColors` option on purpose: the
 * prepass material is built without `vertexColors`, so the `USE_VERTEX_COLORS`
 * define would reference an undeclared `color` attribute there and fail to
 * compile. A chunk-declared attribute is shared correctly by all three.)
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  Quaternion,
  Sphere,
  Vector3,
} from 'three';
import { PAL, RACER_COLORS } from '../core/palette';
import { applyCel, createCelMaterial, type CelMaterialSet } from '../render/celMaterial';
// The hull publishes its seat and handlebar geometry for exactly this purpose —
// see the "Seat contract for the rider subsystem" block in boatMesh.ts. Reading
// it beats hard-coding an offset that a hull re-proportion would silently break.
import { GRIP_HALF_WIDTH, GRIP_LOCAL, SEAT_LOCAL } from '../boat/boatMesh';

// ─────────────────────────────────────────────────────────────────────────────
// Bones
// ─────────────────────────────────────────────────────────────────────────────

export const B = {
  hips: 0,
  spine: 1,
  chest: 2,
  neck: 3,
  head: 4,
  clavL: 5,
  upArmL: 6,
  loArmL: 7,
  handL: 8,
  clavR: 9,
  upArmR: 10,
  loArmR: 11,
  handR: 12,
  thighL: 13,
  shinL: 14,
  footL: 15,
  thighR: 16,
  shinR: 17,
  footR: 18,
  scarfA: 19,
  scarfB: 20,
  scarfC: 21,
} as const;

export const BONE_COUNT = 22;

/** Per-racer physique. Same rig, different animal. */
export interface RiderBuild {
  /** Vertical scale on the whole skeleton. */
  height: number;
  /** Limb + torso radius multiplier. */
  girth: number;
  armLen: number;
  legLen: number;
  headSize: number;
  /** Baseline forward pitch of the spine, radians. Posture, not animation. */
  hunch: number;
  /** Shoulders raised toward the ears — reads as tension. */
  shrug: number;
  shoulderPad: 'none' | 'left' | 'both';
  crest: 'none' | 'fin' | 'mohawk';
  /** 0 = no scarf. Otherwise a length multiplier. */
  scarf: number;
  /** Animation rate multiplier — a twitchy rider vs a smooth one. */
  tempo: number;
  /** Phase offset so the four riders never bob in lockstep. */
  phase: number;
}

export const RIDER_BUILDS: RiderBuild[] = [
  // 0 — player. Compact, neutral, textbook racing crouch.
  {
    height: 1.12, girth: 1.02, armLen: 1.0, legLen: 1.0, headSize: 1.08,
    hunch: 0.0, shrug: 0.0, shoulderPad: 'left', crest: 'fin',
    scarf: 1.0, tempo: 1.0, phase: 0.0,
  },
  // 1 — KAIRA. Tall, long-limbed, upright and loose.
  {
    height: 1.2, girth: 0.92, armLen: 1.1, legLen: 1.06, headSize: 1.02,
    hunch: -0.1, shrug: -0.05, shoulderPad: 'none', crest: 'mohawk',
    scarf: 1.35, tempo: 0.88, phase: 1.9,
  },
  // 2 — NOX. Heavy, hunched over the bars, shoulders up.
  {
    height: 1.07, girth: 1.22, armLen: 0.94, legLen: 0.94, headSize: 1.14,
    hunch: 0.18, shrug: 0.12, shoulderPad: 'both', crest: 'none',
    scarf: 0.0, tempo: 1.12, phase: 3.6,
  },
  // 3 — PIP. Small, springy, very fast timing.
  {
    height: 1.01, girth: 0.96, armLen: 0.96, legLen: 0.9, headSize: 1.24,
    hunch: 0.07, shrug: 0.04, shoulderPad: 'left', crest: 'fin',
    scarf: 1.15, tempo: 1.3, phase: 5.1,
  },
];

interface BoneDef {
  parent: number;
  head: Vector3;
  tip: Vector3;
  /** Reference axis used to fix the bind twist; 'z' for bones that run roughly
   *  vertically, 'y' for bones that run roughly horizontally. Picking the wrong
   *  one leaves the basis near-degenerate and boxy parts twist randomly. */
  hint: 'y' | 'z';
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);

/**
 * Bind skeleton, authored as joint *positions* in rider space, which is the
 * boat's `"seat"` node: **origin at the hips**, +Y up, +Z forward. That is the
 * contract `boatMesh.ts` publishes (`SEAT_LOCAL` is documented as the hips
 * position), so parenting the rig root straight onto the seat with no offset is
 * correct and survives the hull being re-proportioned.
 *
 * The pose is a jet-racer crouch: knees folded up beside the saddle hump, torso
 * pitched forward, hands down and out on the bars.
 *
 * Note what `height` does and does not scale. The seat and the footwell are
 * fixed by the hull, so the *leg* chain keeps its vertical reach for every
 * rider — a short rider is short above the waist, not floating above the deck.
 */
function boneDefs(b: RiderBuild): BoneDef[] {
  const H = b.height;
  const A = b.armLen;
  const L = b.legLen;
  const g = b.girth;
  const hy = (y: number) => y * H;

  // Torso chain.
  const hips = V(0, 0, 0);
  const spine = V(0, hy(0.16), 0.03);
  const chest = V(0, hy(0.36), 0.09);
  const neck = V(0, hy(0.52), 0.13);
  const headBase = V(0, hy(0.6), 0.14);
  const headTip = V(0, hy(0.6) + 0.22 * b.headSize, 0.155);

  // Arm chain, left side; mirrored below. Reach scales with `armLen` about the
  // shoulder; the IK then puts the wrist on the bar whatever the reach is.
  const shoulder = V(-0.185 * g, hy(0.455), 0.125);
  const clav = V(-0.05, hy(0.485), 0.115);
  const elbow = V(shoulder.x - 0.15 * A * g, shoulder.y - 0.14 * A * H, shoulder.z + 0.13 * A);
  const wrist = V(elbow.x + 0.025 * A * g, elbow.y - 0.16 * A * H, elbow.z + 0.195 * A);
  const handTip = V(wrist.x, wrist.y - 0.022, wrist.z + 0.095);

  // Leg chain, left side. Ankle height is deliberately independent of `height`.
  const hipJ = V(-0.115 * g, -0.02, 0.01);
  const knee = V(-0.215 * g, -0.185, 0.2 + 0.07 * L);
  const ankle = V(-0.235 * g, -0.415, 0.08);
  const toe = V(-0.24 * g, -0.465, 0.2);

  const mir = (v: Vector3) => V(-v.x, v.y, v.z);

  // Scarf: authored already arced, each segment dropping further than the last,
  // so even the rest pose has cloth curvature instead of a straight spar.
  const s = b.scarf > 0 ? b.scarf : 1;
  const sA = V(0, hy(0.5), 0.05);
  const sB = V(0, hy(0.46) - 0.015 * s, 0.05 - 0.115 * s);
  const sC = V(0.012, hy(0.4) - 0.04 * s, 0.05 - 0.215 * s);
  const sT = V(0.03, hy(0.31) - 0.08 * s, 0.05 - 0.295 * s);

  const defs: BoneDef[] = [];
  defs[B.hips] = { parent: -1, head: hips, tip: spine, hint: 'z' };
  defs[B.spine] = { parent: B.hips, head: spine, tip: chest, hint: 'z' };
  defs[B.chest] = { parent: B.spine, head: chest, tip: neck, hint: 'z' };
  defs[B.neck] = { parent: B.chest, head: neck, tip: headBase, hint: 'z' };
  defs[B.head] = { parent: B.neck, head: headBase, tip: headTip, hint: 'z' };

  defs[B.clavL] = { parent: B.chest, head: clav, tip: shoulder, hint: 'z' };
  defs[B.upArmL] = { parent: B.clavL, head: shoulder, tip: elbow, hint: 'z' };
  defs[B.loArmL] = { parent: B.upArmL, head: elbow, tip: wrist, hint: 'y' };
  defs[B.handL] = { parent: B.loArmL, head: wrist, tip: handTip, hint: 'y' };

  defs[B.clavR] = { parent: B.chest, head: mir(clav), tip: mir(shoulder), hint: 'z' };
  defs[B.upArmR] = { parent: B.clavR, head: mir(shoulder), tip: mir(elbow), hint: 'z' };
  defs[B.loArmR] = { parent: B.upArmR, head: mir(elbow), tip: mir(wrist), hint: 'y' };
  defs[B.handR] = { parent: B.loArmR, head: mir(wrist), tip: mir(handTip), hint: 'y' };

  defs[B.thighL] = { parent: B.hips, head: hipJ, tip: knee, hint: 'z' };
  defs[B.shinL] = { parent: B.thighL, head: knee, tip: ankle, hint: 'z' };
  defs[B.footL] = { parent: B.shinL, head: ankle, tip: toe, hint: 'y' };

  defs[B.thighR] = { parent: B.hips, head: mir(hipJ), tip: mir(knee), hint: 'z' };
  defs[B.shinR] = { parent: B.thighR, head: mir(knee), tip: mir(ankle), hint: 'z' };
  defs[B.footR] = { parent: B.shinR, head: mir(ankle), tip: mir(toe), hint: 'y' };

  defs[B.scarfA] = { parent: B.chest, head: sA, tip: sB, hint: 'y' };
  defs[B.scarfB] = { parent: B.scarfA, head: sB, tip: sC, hint: 'y' };
  defs[B.scarfC] = { parent: B.scarfB, head: sC, tip: sT, hint: 'y' };
  return defs;
}

export interface Bone {
  name: string;
  parent: number;
  /** Length head→tip in the bind pose, metres. */
  len: number;
  bindWorld: Matrix4;
  invBind: Matrix4;
  bindLocalPos: Vector3;
  bindLocalQuat: Quaternion;
  /** Animation rotation, *relative to bind*. Written by the animator. */
  anim: Quaternion;
  /**
   * Animation translation, added to the bind offset. Used on the root bone for
   * crouch / heave / weight shift. Deliberately *not* applied to the rider's
   * Object3D: the handlebar IK targets live in rider space, so if the whole
   * rider translated the bars would follow the body instead of the boat.
   */
  animPos: Vector3;
  world: Matrix4;
  worldQuat: Quaternion;
}

const _q = new Quaternion();
const _m = new Matrix4();
const _m2 = new Matrix4();
const _p = new Vector3();
const ONE = new Vector3(1, 1, 1);

/**
 * A bind-posed bone hierarchy plus the flat `mat4[]` the shader reads.
 * Bones are stored parents-first so one forward pass resolves the whole tree.
 */
export class RiderSkeleton {
  readonly bones: Bone[] = [];
  /** Column-major skinning matrices, BONE_COUNT × 16. Uploaded as a uniform. */
  readonly skin = new Float32Array(BONE_COUNT * 16);
  /** Bind-pose joint positions in rider space, for IK targets and debugging. */
  readonly bindHead: Vector3[] = [];

  constructor(build: RiderBuild) {
    const defs = boneDefs(build);
    const names = Object.keys(B) as (keyof typeof B)[];

    for (let i = 0; i < BONE_COUNT; i++) {
      const d = defs[i];
      const dir = new Vector3().subVectors(d.tip, d.head);
      const len = dir.length() || 1e-4;
      dir.multiplyScalar(1 / len);

      // Right-handed basis with +Y along the bone. The hint axis pins the twist.
      const hint = d.hint === 'z' ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
      const x = new Vector3().crossVectors(dir, hint);
      if (x.lengthSq() < 1e-6) x.crossVectors(dir, new Vector3(1, 0, 0));
      x.normalize();
      const z = new Vector3().crossVectors(x, dir);

      const bindWorld = new Matrix4().makeBasis(x, dir, z).setPosition(d.head);

      this.bones[i] = {
        name: names[i],
        parent: d.parent,
        len,
        bindWorld,
        invBind: bindWorld.clone().invert(),
        bindLocalPos: new Vector3(),
        bindLocalQuat: new Quaternion(),
        anim: new Quaternion(),
        animPos: new Vector3(),
        world: new Matrix4(),
        worldQuat: new Quaternion(),
      };
      this.bindHead[i] = d.head.clone();
    }

    // Bind pose expressed in each parent's frame.
    for (const bone of this.bones) {
      if (bone.parent < 0) _m.copy(bone.bindWorld);
      else _m.multiplyMatrices(this.bones[bone.parent].invBind, bone.bindWorld);
      _m.decompose(bone.bindLocalPos, bone.bindLocalQuat, new Vector3());
    }

    this.update();
  }

  /** Resolve every bone's world matrix and repack the skinning array. */
  update() {
    for (let i = 0; i < this.bones.length; i++) this.refresh(i);
  }

  /** Resolve one bone (and repack it). Parents must already be resolved. */
  refresh(i: number) {
    const b = this.bones[i];
    _q.copy(b.bindLocalQuat).multiply(b.anim);
    _p.addVectors(b.bindLocalPos, b.animPos);
    _m.compose(_p, _q, ONE);
    if (b.parent < 0) b.world.copy(_m);
    else b.world.multiplyMatrices(this.bones[b.parent].world, _m);
    b.worldQuat.setFromRotationMatrix(b.world);
    _m2.multiplyMatrices(b.world, b.invBind);
    _m2.toArray(this.skin, i * 16);
  }

  worldPos(i: number, out: Vector3): Vector3 {
    const e = this.bones[i].world.elements;
    return out.set(e[12], e[13], e[14]);
  }

  resetAnim() {
    for (const b of this.bones) b.anim.identity();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry construction
// ─────────────────────────────────────────────────────────────────────────────

/** A 2D lathe profile point: radius, height along the bone. */
type Profile = [number, number][];

/**
 * Emits primitives into flat arrays, transforming each vertex by the current
 * bone's bind matrix so the merged geometry ends up in a single bind-pose space
 * that the skinning chunk can then deform. Build-time only — allocates freely.
 */
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  tint: number[] = [];
  bone: number[] = [];
  wt: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  private m = new Matrix4();
  private nm = new Matrix3();
  private boneA = 0;
  private boneB = 0;
  /** Blend weight toward boneA as a function of the *pre-transform* local y. */
  private weightFn: ((y: number) => number) | null = null;
  private _v = new Vector3();
  private _n = new Vector3();

  constructor(private skel: RiderSkeleton) {}

  /** Author the next primitives in `boneA`'s space, optionally offset by `local`. */
  at(boneA: number, local?: Matrix4, boneB = boneA, weightFn: ((y: number) => number) | null = null) {
    this.m.copy(this.skel.bones[boneA].bindWorld);
    if (local) this.m.multiply(local);
    this.nm.setFromMatrix4(this.m);
    this.boneA = boneA;
    this.boneB = boneB;
    this.weightFn = weightFn;
    return this;
  }

  private push(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: Color) {
    this._v.set(x, y, z).applyMatrix4(this.m);
    this._n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.pos.push(this._v.x, this._v.y, this._v.z);
    this.nrm.push(this._n.x, this._n.y, this._n.z);
    this.uv.push(u, v);
    this.tint.push(c.r, c.g, c.b);
    this.bone.push(this.boneA, this.boneB);
    this.wt.push(this.weightFn ? this.weightFn(y) : 1);
  }

  /**
   * Revolve a profile around +Y.
   *
   * Each quad is emitted with its **own four vertices** and a single tint taken
   * from the quad centre. That is not wasteful bookkeeping, it is the whole
   * point: on a shared vertex grid a colour change interpolates across a full
   * quad, so a racing stripe on a 14-sided limb arrives as a soft gradient —
   * exactly the airbrushed mush a cel look must not have. Independent corners
   * put the colour break on a polygon edge, hard.
   *
   * Normals stay *per-corner* (computed from the profile tangent), so the
   * surface still shades smoothly — flat tint, smooth form. And because
   * `computeSmoothNormals` welds by position afterwards, the outline hull is
   * unaffected by the duplication.
   */
  lathe(
    profile: Profile,
    seg: number,
    color: Color | ((u: number, v: number) => Color),
    sx = 1,
    sz = 1,
    /** Partial revolve, in turns. Used for shell-hugging patches like a visor. */
    t0 = 0,
    t1 = 1,
  ) {
    const rings = profile.length;
    // Per-ring: radius, height, profile normal (r, y component), v coordinate.
    const R: number[] = [];
    const Y: number[] = [];
    const NR: number[] = [];
    const NY: number[] = [];
    for (let i = 0; i < rings; i++) {
      R[i] = profile[i][0];
      Y[i] = profile[i][1];
      const p0 = profile[Math.max(0, i - 1)];
      const p1 = profile[Math.min(rings - 1, i + 1)];
      let tr = p1[0] - p0[0];
      let ty = p1[1] - p0[1];
      const tl = Math.hypot(tr, ty) || 1;
      tr /= tl;
      ty /= tl;
      NR[i] = ty;
      NY[i] = -tr;
    }
    const CA: number[] = [];
    const SA: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const a = (t0 + (j / seg) * (t1 - t0)) * Math.PI * 2;
      CA[j] = Math.cos(a);
      SA[j] = Math.sin(a);
    }

    const vAt = (i: number) => i / (rings - 1 || 1);
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const c =
          typeof color === 'function' ? color((j + 0.5) / seg, vAt(i) + 0.5 / (rings - 1 || 1)) : color;
        const base = this.pos.length / 3;
        // a = (i,j)  b = (i,j+1)  c2 = (i+1,j+1)  d = (i+1,j)
        const corner = (ri: number, cj: number) =>
          this.push(
            R[ri] * CA[cj] * sx,
            Y[ri],
            R[ri] * SA[cj] * sz,
            // Inverse-scale the normal so flattened parts still shade correctly.
            (NR[ri] * CA[cj]) / sx,
            NY[ri],
            (NR[ri] * SA[cj]) / sz,
            cj / seg,
            vAt(ri),
            c,
          );
        corner(i, j);
        corner(i, j + 1);
        corner(i + 1, j + 1);
        corner(i + 1, j);
        // Wound outward: at theta = 0 this gives a +X-facing normal.
        this.idx.push(base, base + 3, base + 1, base + 3, base + 2, base + 1);
      }
    }
  }

  /**
   * Axis-aligned box in the current local space. Each face gets its own four
   * vertices with a hard normal — `computeSmoothNormals` later merges them into
   * one averaged normal for the outline hull, so the box keeps crisp shading
   * *and* a watertight ink silhouette.
   */
  box(w: number, h: number, d: number, cx: number, cy: number, cz: number, color: Color) {
    const hx = w * 0.5;
    const hy = h * 0.5;
    const hz = d * 0.5;
    const normals = [
      [+1, 0, 0],
      [-1, 0, 0],
      [0, +1, 0],
      [0, -1, 0],
      [0, 0, +1],
      [0, 0, -1],
    ];
    const corners = [
      [-1, -1],
      [+1, -1],
      [+1, +1],
      [-1, +1],
    ];
    for (const n of normals) {
      const base = this.pos.length / 3;
      const nv = new Vector3(n[0], n[1], n[2]);
      // bt = nv × t, so t × bt = nv: the quad below winds outward by construction.
      const up = Math.abs(nv.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
      const t = new Vector3().crossVectors(up, nv).normalize();
      const bt = new Vector3().crossVectors(nv, t);
      const cen = new Vector3(cx + nv.x * hx, cy + nv.y * hy, cz + nv.z * hz);
      const sT = Math.abs(t.x) * hx + Math.abs(t.y) * hy + Math.abs(t.z) * hz;
      const sB = Math.abs(bt.x) * hx + Math.abs(bt.y) * hy + Math.abs(bt.z) * hz;
      for (let k = 0; k < 4; k++) {
        const [su, sv] = corners[k];
        this.push(
          cen.x + t.x * sT * su + bt.x * sB * sv,
          cen.y + t.y * sT * su + bt.y * sB * sv,
          cen.z + t.z * sT * su + bt.z * sB * sv,
          nv.x,
          nv.y,
          nv.z,
          (su + 1) * 0.5,
          (sv + 1) * 0.5,
          color,
        );
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 3));
    g.setAttribute('aBone', new BufferAttribute(new Float32Array(this.bone), 2));
    g.setAttribute('aBoneW', new BufferAttribute(new Float32Array(this.wt), 1));
    g.setIndex(this.idx);
    // The skinning happens on the GPU, so the bind-pose bounds are wrong once
    // the rider moves. A generous hand-set sphere beats per-frame recomputation
    // and stops limbs popping at the edge of frame.
    g.boundingSphere = new Sphere(new Vector3(0, 0.7, -0.1), 1.5);
    return g;
  }

  get triCount() {
    return this.idx.length / 3;
  }
}

/** Rounded limb profile: cap, taper, cap. */
function limbProfile(
  rBot: number,
  rTop: number,
  len: number,
  capBot: number,
  capTop: number,
  capSegs = 3,
  bulge = 0,
): Profile {
  const p: Profile = [];
  if (capBot > 0) {
    const h = rBot * capBot;
    for (let i = 0; i <= capSegs; i++) {
      const t = (i / capSegs) * (Math.PI / 2);
      p.push([rBot * Math.sin(t), -h * Math.cos(t)]);
    }
  } else {
    p.push([rBot, 0]);
  }
  if (bulge !== 0) p.push([((rBot + rTop) * 0.5) * (1 + bulge), len * 0.5]);
  p.push([rTop, len]);
  if (capTop > 0) {
    const h = rTop * capTop;
    for (let i = capSegs - 1; i >= 0; i--) {
      const t = (i / capSegs) * (Math.PI / 2);
      p.push([rTop * Math.sin(t), len + h * Math.cos(t)]);
    }
  }
  return p;
}

/** Sphere/ellipsoid centred at `cy`, poles on Y. */
function sphereProfile(r: number, cy: number, rings = 8, yScale = 1): Profile {
  return sphereBand(r, cy, 0, 1, rings, yScale);
}

/**
 * A latitude band of a sphere, `v0`…`v1` measured from the south pole.
 * Combined with a partial revolve this is how the visor is built: a patch that
 * lies exactly on the helmet shell. A box pressed into a sphere pokes its
 * corners out through the surface — which is precisely what the first pass did.
 */
function sphereBand(r: number, cy: number, v0: number, v1: number, rings = 6, yScale = 1): Profile {
  const p: Profile = [];
  for (let i = 0; i <= rings; i++) {
    const t = (v0 + (i / rings) * (v1 - v0)) * Math.PI;
    p.push([r * Math.sin(t), cy - r * yScale * Math.cos(t)]);
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rider mesh
// ─────────────────────────────────────────────────────────────────────────────

export interface RiderMesh {
  root: Group;
  skel: RiderSkeleton;
  soft: Mesh;
  hard: Mesh;
  /** Handlebar grip targets in rider space, one per hand. */
  gripL: Vector3;
  gripR: Vector3;
  triangles: number;
  sets: CelMaterialSet[];
}

/**
 * Shading ramp for the riders.
 *
 * Every part colour arrives per-vertex, so the material's own colour is white
 * and the ramp has to be a neutral *multiplier*: cool and dark in shadow,
 * neutral at the terminator, warm-white in the hot band. Built from palette
 * tones only (same trick `celMaterial`'s `defaultRamp` uses internally) — the
 * shadow leans on `waterDeep` so a rider in shadow sits in the sea's colour
 * family instead of going muddy grey.
 *
 * The stops are pulled tighter than the default: a 1.3 m character seen at
 * 5 m needs its terminator inside the silhouette, not smeared across it.
 */
function riderRamp(): Color[] {
  const w = PAL.cloudLit;
  return [
    w.clone().lerp(PAL.waterDeep, 0.42).multiplyScalar(0.88),
    w.clone().lerp(PAL.waterMid, 0.2).multiplyScalar(0.95),
    w.clone(),
    w.clone().lerp(PAL.sun, 0.4).multiplyScalar(1.1),
  ];
}
const RIDER_RAMP_STOPS = [0.0, 0.4, 0.54, 0.83];

function skinChunks(bones: { value: Float32Array }) {
  return {
    uniforms: { uBones: bones as unknown as { value: Float32Array } },
    vertexHead: /* glsl */ `
      attribute vec3 aTint;
      attribute vec2 aBone;
      attribute float aBoneW;
      uniform mat4 uBones[${BONE_COUNT}];
      varying vec3 vTint;
    `,
    // Two-bone linear blend. `smoothNormal` is deformed alongside `objectNormal`
    // because the inverted-hull outline pushes along it — skip that and the ink
    // line stays in the bind pose while the model animates out from under it.
    vertexBody: /* glsl */ `
      {
        mat4 mA = uBones[int(aBone.x)];
        mat4 mB = uBones[int(aBone.y)];
        vec3 pA = (mA * vec4(transformed, 1.0)).xyz;
        vec3 pB = (mB * vec4(transformed, 1.0)).xyz;
        transformed = mix(pB, pA, aBoneW);
        mat3 rA = mat3(mA);
        mat3 rB = mat3(mB);
        objectNormal = normalize(mix(rB * objectNormal, rA * objectNormal, aBoneW));
        smoothNormal = normalize(mix(rB * smoothNormal, rA * smoothNormal, aBoneW));
        vTint = aTint;
      }
    `,
    fragmentHead: /* glsl */ `varying vec3 vTint;`,
    fragmentBody: /* glsl */ `baseColor *= vTint;`,
  };
}

/**
 * Build one rider: skeleton, two merged geometries, two cel material sets.
 *
 * Part layout (soft / hard):
 *   soft — pelvis, torso (2-bone blend), neck, face, upper+lower arms, gloves,
 *          thighs, shins, scarf
 *   hard — helmet, visor wedge, crest, shoulder pad(s), boots
 */
export function createRiderMesh(racerId: number, build: RiderBuild): RiderMesh {
  const colors = RACER_COLORS[racerId];
  const skel = new RiderSkeleton(build);
  const g = build.girth;

  // ── Value plan ────────────────────────────────────────────────────────────
  // Four values and one accent, because a cel figure is read as *shapes of
  // value* long before anyone sees its hue:
  //   pale   back panel, shoulder caps, pads      (reads first, at the top)
  //   mid    the suit itself                      (most of the body)
  //   dark   gloves, boots, forearm cuffs         (terminates the limbs)
  //   ink    visor                                (the one true black)
  //   accent racer hull colour: helmet, yoke, stripes, scarf
  //
  // The palette's `suit0..3` tones are gorgeous but they sit at ~0.03 relative
  // luminance — at 1.3 m tall and 5 m away, a whole rider painted in them is a
  // black silhouette with no internal drawing at all (verified in a raw capture,
  // no post). So the *fabric* tones are derived from the committed suit colour by
  // mixing toward `skyHorizon`, the same shift `celMaterial`'s own ramp uses.
  // Flagged in the hand-off: the palette wants a mid-value rider fabric tone.
  const hull = colors.hull;
  const suit = colors.suit;
  // Lifted toward `skyHorizon` for value, then pulled a little way toward the
  // racer's own hull colour for hue — otherwise all four riders end up wearing
  // the same cyan and only the helmet tells them apart.
  const fabric = suit.clone().lerp(PAL.skyHorizon, 0.4).lerp(hull, 0.18);
  const fabricDark = suit.clone().lerp(PAL.skyHorizon, 0.26).lerp(hull, 0.12);
  const light = PAL.foamShade;
  const litePanel = PAL.foam;
  const skin = PAL.skin;
  const skinDark = PAL.skinShade;
  // Gloves and boots keep the *committed* suit tone, undiluted. They are the
  // one place its near-black value is an asset: dark extremities terminate the
  // limbs and give the figure weight, the way ink does in a cel drawing.
  const dark = suit;
  const visorInk = PAL.ink;

  /** True on the outward-facing columns of a limb, for either side. */
  const outerStripe = (side: number, u: number) =>
    side < 0 ? u > 0.42 && u < 0.58 : u < 0.08 || u > 0.92;

  const soft = new Builder(skel);
  const hard = new Builder(skel);
  const local = new Matrix4();
  const localPos = new Vector3();
  const localQuat = new Quaternion();

  const AX = new Vector3(1, 0, 0);
  const AY = new Vector3(0, 1, 0);
  const AZ = new Vector3(0, 0, 1);
  const spare = new Quaternion();
  /** Offset transform inside a bone's space, for parts that are not lathes. */
  const setLocal = (px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0) => {
    localQuat.identity();
    if (rx) localQuat.multiply(spare.setFromAxisAngle(AX, rx));
    if (ry) localQuat.multiply(spare.setFromAxisAngle(AY, ry));
    if (rz) localQuat.multiply(spare.setFromAxisAngle(AZ, rz));
    local.compose(localPos.set(px, py, pz), localQuat, ONE);
    return local;
  };

  // ── Pelvis ────────────────────────────────────────────────────────────────
  soft.at(B.hips);
  soft.lathe(limbProfile(0.13 * g, 0.115 * g, skel.bones[B.hips].len, 0.9, 0.2, 3), 12, fabric, 1.12, 0.9);

  // ── Torso: blended across spine → chest so the waist bends, not creases ───
  const torsoLen = skel.bones[B.spine].len + skel.bones[B.chest].len;
  soft.at(B.spine, undefined, B.chest, (y) => 1 - Math.min(1, Math.max(0, (y / torsoLen - 0.15) / 0.7)));
  soft.lathe(
    [
      [0.115 * g, -0.02],
      [0.135 * g, torsoLen * 0.2],
      [0.155 * g, torsoLen * 0.52],
      [0.16 * g, torsoLen * 0.8],
      [0.135 * g, torsoLen * 1.02],
      [0.1 * g, torsoLen * 1.12],
    ],
    14,
    (u, v) => {
      // Two values, one boundary. An earlier pass painted a belt band, a spine
      // stripe and a chest panel here; with 5 rings and 14 columns that lands as
      // a patchwork of large blocks — cel art wants few, big shapes. So: dark
      // waist and dark front, pale upper back, and let the yoke and the sleeve
      // stripes carry the accent. u = 0 faces +X, 0.25 is the chest, 0.75 the back.
      if (v < 0.38) return fabric;
      return u > 0.5 ? light : fabric;
    },
    1.2,
    0.82,
  );

  // Shoulder yoke — a wide cap in the racer's own colour over the top of the
  // torso. Two jobs: the torso stops being one tapering tube, and the strongest
  // identity colour lands on the highest, most-lit, least-occluded surface.
  soft.at(B.chest);
  soft.lathe(
    [
      [0.15 * g, skel.bones[B.chest].len * 0.4],
      [0.176 * g, skel.bones[B.chest].len * 0.6],
      [0.17 * g, skel.bones[B.chest].len * 0.86],
      [0.12 * g, skel.bones[B.chest].len * 1.0],
    ],
    14,
    hull,
    1.32,
    0.8,
  );

  // ── Neck + face ───────────────────────────────────────────────────────────
  soft.at(B.neck);
  soft.lathe(limbProfile(0.052 * g, 0.047 * g, skel.bones[B.neck].len * 1.15, 0.2, 0, 2), 8, skinDark);
  soft.at(B.head);
  soft.lathe(sphereProfile(0.088 * build.headSize, 0.085, 9, 1.12), 12, (_u, v) => (v < 0.4 ? skinDark : skin), 1, 1.05);

  // ── Arms ──────────────────────────────────────────────────────────────────
  for (const side of [-1, 1] as const) {
    const up = side < 0 ? B.upArmL : B.upArmR;
    const lo = side < 0 ? B.loArmL : B.loArmR;
    const hand = side < 0 ? B.handL : B.handR;

    // Deltoid — a light shoulder cap. It hides the arm/torso join and keeps the
    // high value at the top of the figure where the eye lands first.
    soft.at(up);
    soft.lathe(sphereProfile(0.068 * g, 0.008, 8, 1), 10, light);
    // Sleeve: mid-value, with an accent stripe down the *outer* face. u = 0.5
    // faces -X and u = 0/1 faces +X, so the stripe has to flip with the side —
    // painted at a fixed u it runs down the inside of one arm.
    soft.lathe(
      limbProfile(0.056 * g, 0.045 * g, skel.bones[up].len, 0, 0.4, 3),
      10,
      (u) => (outerStripe(side, u) ? hull : fabric),
    );
    soft.at(lo);
    soft.lathe(sphereProfile(0.047 * g, 0.0, 6, 1), 8, fabricDark);
    soft.lathe(limbProfile(0.045 * g, 0.038 * g, skel.bones[lo].len, 0, 0.3, 2), 10, fabricDark);
    // Glove: a rounded fist, deeper than it is wide so the knuckles read.
    soft.at(hand);
    soft.lathe(limbProfile(0.046 * g, 0.04 * g, skel.bones[hand].len * 0.95, 0.85, 0.9, 3), 8, dark, 1, 1.2);
  }

  // ── Legs ──────────────────────────────────────────────────────────────────
  for (const side of [-1, 1] as const) {
    const th = side < 0 ? B.thighL : B.thighR;
    const sh = side < 0 ? B.shinL : B.shinR;
    const ft = side < 0 ? B.footL : B.footR;
    soft.at(th);
    soft.lathe(
      limbProfile(0.082 * g, 0.062 * g, skel.bones[th].len, 0.3, 0.2, 3, 0.04),
      10,
      (u) => (outerStripe(side, u) ? hull : fabric),
    );
    soft.at(sh);
    soft.lathe(sphereProfile(0.062 * g, 0, 7, 0.9), 10, fabricDark);
    soft.lathe(limbProfile(0.056 * g, 0.044 * g, skel.bones[sh].len, 0, 0.2, 2), 10, fabric);
    // Boot — hard family: it wants the tight, glossy highlight. Built as a
    // tapered lathe along the foot bone rather than a box: a brick on the end of
    // a leg is the single most obvious "programmer art" tell.
    hard.at(ft);
    hard.lathe(limbProfile(0.056 * g, 0.04 * g, skel.bones[ft].len * 1.5, 0.9, 0.7, 3), 10, dark, 1.0, 0.95);
    // Ankle cuff, half a size up, so the boot has a top edge to ink.
    hard.at(ft);
    hard.lathe(limbProfile(0.066 * g, 0.058 * g, 0.045, 0.3, 0.2, 2), 10, dark, 1.0, 1.0);
  }

  // ── Helmet ────────────────────────────────────────────────────────────────
  const hr = 0.118 * build.headSize;
  hard.at(B.head);
  hard.lathe(sphereProfile(hr, 0.088, 11, 1.06), 14, (_u, v) => (v < 0.2 ? dark : hull), 1.02, 1.04);
  // Visor: an ink band lying *on* the helmet shell — same sphere, 3% larger,
  // revolved only across the front 150°. That guarantees it hugs the helmet at
  // every corner, and because it is a shell the inverted hull inks only its
  // rim, which is exactly the drawn line a visor wants.
  // +Z is a quarter turn round from +X, so the front arc is centred on 0.25.
  hard.at(B.head);
  hard.lathe(sphereBand(hr * 1.03, 0.088, 0.4, 0.62, 3, 1.06), 12, visorInk, 1.02, 1.04, 0.03, 0.47);
  // Brow: a second, thinner band above the visor in the racer colour.
  hard.lathe(sphereBand(hr * 1.05, 0.088, 0.62, 0.7, 2, 1.06), 12, hull, 1.02, 1.04, 0.02, 0.48);
  // Chin guard below the visor, closing the face opening.
  hard.lathe(sphereBand(hr * 1.04, 0.088, 0.29, 0.4, 2, 1.06), 12, dark, 1.02, 1.04, 0.06, 0.44);

  // Crown detail. Sits half-buried in the helmet shell — a fin that floats
  // clear of the sphere reads as a modelling mistake, not a design.
  const crown = 0.088 + hr * 1.06;
  if (build.crest === 'fin') {
    hard.at(B.head, setLocal(0, crown - 0.028, -0.012));
    hard.box(0.015, hr * 0.46, hr * 1.15, 0, 0, 0, litePanel);
  } else if (build.crest === 'mohawk') {
    for (let i = 0; i < 3; i++) {
      hard.at(B.head, setLocal(0, crown - 0.02 - i * 0.016, 0.03 - i * 0.045));
      hard.box(0.013, hr * (0.44 - i * 0.09), hr * 0.34, 0, 0, 0, litePanel);
    }
  }

  // ── Shoulder pad(s) — the silhouette break that makes a rider read ────────
  const padSides: number[] = build.shoulderPad === 'both' ? [-1, 1] : build.shoulderPad === 'left' ? [-1] : [];
  for (const side of padSides) {
    const up = side < 0 ? B.upArmL : B.upArmR;
    // Profile points must run in *increasing* y. The lathe derives its normals
    // from the profile tangent, so a descending profile silently produces
    // inward-facing normals — the pad renders as a black hole where you can see
    // the inside of the shell. (It did exactly that for two capture rounds.)
    hard.at(up, setLocal(0, 0.012, 0));
    hard.lathe(
      [
        [0.03 * g, -0.085],
        [0.088 * g, -0.072],
        [0.112 * g, -0.03],
        [0.1 * g, 0.022],
        [0.045 * g, 0.058],
      ],
      10,
      (_u, v) => (v < 0.3 ? hull : litePanel),
      1.15,
      0.95,
    );
  }

  // ── Scarf ─────────────────────────────────────────────────────────────────
  if (build.scarf > 0) {
    // Collar wrap.
    soft.at(B.neck, setLocal(0, 0.02, 0));
    soft.lathe(limbProfile(0.082 * g, 0.075 * g, 0.045, 0.5, 0.4, 2), 10, hull, 1.05, 1.1);
    // A ribbon, not a sausage: wide across the rider's back (local X, which is
    // the world side axis for these bones) and thin vertically, so from the
    // chase camera — where it is actually seen — it presents its broad face.
    // The twist in the animator keeps it from reading as a plank.
    const seg = [B.scarfA, B.scarfB, B.scarfC];
    for (let i = 0; i < seg.length; i++) {
      const b = seg[i];
      const w = (0.135 - i * 0.032) * g;
      soft.at(b);
      soft.lathe(
        limbProfile(w, w * 0.74, skel.bones[b].len * 1.06, 0, i === 2 ? 0.8 : 0, 2),
        8,
        hull,
        1,
        0.14,
      );
    }
  }

  // ── Materials ─────────────────────────────────────────────────────────────
  const bonesUniform = { value: skel.skin };
  const ramp = riderRamp();

  const softSet = createCelMaterial({
    color: PAL.cloudLit,
    rampColors: ramp,
    rampStops: RIDER_RAMP_STOPS,
    rimColor: PAL.skyHorizon,
    rimPower: 2.6,
    rimStrength: 0.55,
    // Blinn thresholds have to be *tight*. `step(0.93, dot(N,H))` sounds small
    // but on a sphere it is a 21-degree cap — a pale disc the size of the whole
    // helmet, which is what turned the racer's red shell into a grey blob in the
    // first captures. These sizes give a glint, not a headlamp.
    specColor: PAL.foam,
    specSize: 0.978,
    specSize2: 0.995,
    specStrength: 0.13,
    outlineWidthPx: 2.0,
    edgeBias: 1.15,
    name: `riderSoft${racerId}`,
    chunks: skinChunks(bonesUniform),
  });

  const hardSet = createCelMaterial({
    color: PAL.cloudLit,
    rampColors: ramp,
    rampStops: RIDER_RAMP_STOPS,
    rimColor: PAL.skyHorizon,
    rimPower: 3.6,
    // Kept modest deliberately: a strong rim on an ink-dark visor lifts it to
    // pale blue and the helmet stops reading as a helmet. The banded spec does
    // the "hard shell" job instead.
    rimStrength: 0.42,
    specColor: PAL.foam,
    specSize: 0.966,
    specSize2: 0.991,
    specStrength: 0.5,
    outlineWidthPx: 2.2,
    edgeBias: 1.3,
    name: `riderHard${racerId}`,
    chunks: skinChunks(bonesUniform),
  });

  const root = new Group();
  root.name = `rider${racerId}`;

  const softMesh = new Mesh(soft.toGeometry());
  softMesh.name = `rider${racerId}:soft`;
  applyCel(softMesh, softSet);
  root.add(softMesh);

  const hardMesh = new Mesh(hard.toGeometry());
  hardMesh.name = `rider${racerId}:hard`;
  applyCel(hardMesh, hardSet);
  root.add(hardMesh);

  // Handlebar grips, straight from the hull's published contract and expressed
  // in seat space, which is rider space. The animator IKs the wrists here, so a
  // rider with longer arms simply carries a deeper elbow bend.
  const gripL = new Vector3(-GRIP_HALF_WIDTH, 0, 0).add(GRIP_LOCAL).sub(SEAT_LOCAL);
  const gripR = new Vector3(GRIP_HALF_WIDTH, 0, 0).add(GRIP_LOCAL).sub(SEAT_LOCAL);

  return {
    root,
    skel,
    soft: softMesh,
    hard: hardMesh,
    gripL,
    gripR,
    triangles: soft.triCount + hard.triCount,
    sets: [softSet, hardSet],
  };
}
