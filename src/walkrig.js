import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural gait rig for an UNRIGGED character mesh.
//
// The Meshy runner is a single static mesh (skins:0, animations:[]), so there is
// nothing for an AnimationMixer to play. This bends it in the vertex shader:
// ankle -> knee -> hip forward kinematics below the hip, a shoulder swing on the
// upper arms, and counter-twist / roll / lean on the torso, every joint weighted
// smoothly so the silhouette never tears.
//
// The gait blends from a walk to a run with `vrGait` (0..1). `game.js` advances
// `phase` by ground actually covered, so the planted foot does not slip.
//
// Landmarks come from the model's own bounding box, so this works for any
// humanoid GLB at any size or origin.
// ---------------------------------------------------------------------------

const PARS = `
uniform float vrPhase, vrGait, vrSwing, vrKnee, vrArm, vrLean, vrTwist;
uniform float vrHipY, vrKneeY, vrAnkleY, vrFootY, vrTopY, vrNeckY, vrShoulderY, vrArmLowY;
uniform float vrLegSep, vrArmX0, vrArmX1;
uniform float vrHipB, vrKneeB, vrAnkleB, vrArmB;   // joint blend spans
uniform mat4 vrToRig, vrFromRig;
vec3 vrRX(vec3 v, float a){ float c=cos(a), s=sin(a); return vec3(v.x, v.y*c - v.z*s, v.y*s + v.z*c); }
vec3 vrRY(vec3 v, float a){ float c=cos(a), s=sin(a); return vec3(v.x*c + v.z*s, v.y, -v.x*s + v.z*c); }
vec3 vrRZ(vec3 v, float a){ float c=cos(a), s=sin(a); return vec3(v.x*c - v.y*s, v.x*s + v.y*c, v.z); }
float vrS(float t){ t = clamp(t, 0.0, 1.0); return t*t*(3.0 - 2.0*t); }

void vrDeform(inout vec3 pos, inout vec3 nrm){
  if (vrGait < 0.002) return;
  vec3 p = (vrToRig * vec4(pos, 1.0)).xyz;
  vec3 n = mat3(vrToRig) * nrm;
  vec3 o = p;                                   // rest pose drives every weight

  // Each joint blends over a SHORT span and then holds at 1, the way a skin
  // weight does. Ramping across the whole limb instead bends the shin into a
  // banana rather than hinging it at the knee.
  float legW   = vrS((vrHipY   - o.y) / vrHipB);
  float kneeW  = vrS((vrKneeY  - o.y) / vrKneeB);
  float ankleW = vrS((vrAnkleY - o.y) / vrAnkleB);
  float upW    = vrS((o.y - vrHipY)   / max(1e-4, vrTopY   - vrHipY));
  float side   = clamp(o.x / max(1e-4, vrLegSep), -1.0, 1.0);   // -1 left leg, +1 right
  float sp = sin(vrPhase) * side;
  float cp = cos(vrPhase) * side;

  // ---- leg: ankle -> knee -> hip (deepest joint first = forward kinematics) ----
  // legW/kneeW are both 1 down at the foot, so these are the angles the foot sees.
  float hipFull  = vrSwing * sp;
  // Knee flexion over the leg's own cycle: sin(psi - 0.83), where sin(psi)=sp and
  // cos(psi)=cp. Peaks just after toe-off, still tucked as the leg passes under,
  // and back to zero at heel strike — a straight leg at contact, bent in recovery.
  float kneeFull = vrKnee * max(0.0, 0.675 * sp - 0.738 * cp);
  // The ankle counters the HIP only, which keeps the sole roughly level through
  // the stride. Countering the knee too drove it past -80 degrees and smeared
  // the boot into a spike.
  float ankleA = -hipFull * 0.75 * ankleW;
  vec3 ap = vec3(0.0, vrAnkleY, 0.0);
  p = ap + vrRX(p - ap, ankleA); n = vrRX(n, ankleA);

  float kneeA = kneeFull * kneeW;
  vec3 kp = vec3(0.0, vrKneeY, 0.0);
  p = kp + vrRX(p - kp, kneeA); n = vrRX(n, kneeA);

  float hipA = hipFull * legW;
  vec3 hp = vec3(0.0, vrHipY, 0.0);
  p = hp + vrRX(p - hp, hipA); n = vrRX(n, hipA);

  // ---- upper arms: swing opposite the same-side leg, pivoting at the shoulder ----
  // The arms are welded to the torso in this mesh, so the weight is a soft band:
  // outer-x only, shoulder down to just above the (much wider) hips.
  float armW = smoothstep(vrArmX0, vrArmX1, abs(o.x))
             * vrS((vrShoulderY - o.y) / vrArmB)
             * (1.0 - vrS((vrArmLowY - o.y) / max(1e-4, 0.5 * (vrArmLowY - vrHipY))));
  float armA = -vrArm * sin(vrPhase) * clamp(o.x / max(1e-4, vrArmX1), -1.0, 1.0) * armW;
  vec3 sh = vec3(0.0, vrShoulderY, 0.0);
  p = sh + vrRX(p - sh, armA); n = vrRX(n, armA);

  // ---- torso: counter-twist against the stride, roll, forward lean ----
  float twist = -vrTwist * sin(vrPhase) * upW;
  float roll  =  0.055 * vrGait * cos(vrPhase) * upW;
  float lean  =  vrLean * upW;
  p -= hp;
  p = vrRY(p, twist); n = vrRY(n, twist);
  p = vrRZ(p, roll);  n = vrRZ(n, roll);
  p = vrRX(p, lean);  n = vrRX(n, lean);
  p += hp;

  // (No head counter-rotation. Opposing the torso lean about a second pivot
  //  shears this model's tall hood into a slab — the head rides with the torso.)

  pos = (vrFromRig * vec4(p, 1.0)).xyz;
  nrm = normalize(mat3(vrFromRig) * n);
}
`;

// Landmarks as fractions of total height.
const HIP = 0.53, KNEE = 0.285, ANKLE = 0.065, NECK = 0.855,
      SHOULDER = 0.82, ARM_LOW = 0.63, LEG_SEP = 0.05,
      ARM_X0 = 0.075, ARM_X1 = 0.115;
// How far below each joint its rotation blends in, as a fraction of height.
const HIP_B = 0.13, KNEE_B = 0.085, ANKLE_B = 0.045, ARM_B = 0.075;

// Gait curves, all driven by `g` (0 = still, 1 = full sprint). Exported so the
// driver and the pelvis-drop maths cannot disagree about the hip amplitude.
export const gaitSwing = g => g * (0.40 + 0.22 * g);   // hip, radians (max ~35 deg)

// Ground a planted foot covers in one full cycle at this gait: each leg sweeps
// 2*legLen*sin(swing) while it is down, and two legs alternate. Advance `phase`
// by distance/gaitStride and the planted foot cannot slip.
export const gaitStride = (g, legLen) => 4 * legLen * Math.sin(gaitSwing(g));

// Full-run pose from here up. Keeping this in metres/second (rather than as a
// fraction of RULES.sprint) means the gait stays correct if the speeds change.
export const RUN_MPS = 6.0;
// Cadence ceiling. Above it the foot does slip, but a character churning at six
// cycles a second reads as a sewing machine, which is worse.
export const MAX_CADENCE = 3.0;
const gaitKnee  = g => g * (0.70 + 0.50 * g);
const gaitArm   = g => g * (0.30 + 0.25 * g);
const gaitLean  = g => g * g * 0.13;
const gaitTwist = g => g * 0.14;

// Attach the rig to every mesh under `root`. Materials are cloned so each
// character animates independently. Returns the shared uniform set.
export function attachWalkRig(root) {
  const u = {
    vrPhase: { value: 0 }, vrGait: { value: 0 }, vrSwing: { value: 0 },
    vrKnee: { value: 0 }, vrArm: { value: 0 }, vrLean: { value: 0 }, vrTwist: { value: 0 },
    vrHipY: { value: 0 }, vrKneeY: { value: 0 }, vrAnkleY: { value: 0 }, vrFootY: { value: 0 },
    vrTopY: { value: 1 }, vrNeckY: { value: 0 }, vrShoulderY: { value: 0 }, vrArmLowY: { value: 0 },
    vrLegSep: { value: 0.1 }, vrArmX0: { value: 0.1 }, vrArmX1: { value: 0.2 },
    vrHipB: { value: 0.2 }, vrKneeB: { value: 0.15 }, vrAnkleB: { value: 0.08 }, vrArmB: { value: 0.15 },
  };

  // bounding box of the whole model in ROOT space (parent transforms cancel out)
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const bb = new THREE.Box3();
  const meshes = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    meshes.push(o);
    o.geometry.computeBoundingBox();
    const toRig = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    bb.union(o.geometry.boundingBox.clone().applyMatrix4(toRig));
    o.userData.vrToRig = toRig;
  });
  if (!meshes.length) return u;

  const h = Math.max(1e-4, bb.max.y - bb.min.y);
  const at = f => bb.min.y + f * h;
  u.vrFootY.value = bb.min.y;      u.vrTopY.value = bb.max.y;
  u.vrHipY.value = at(HIP);        u.vrKneeY.value = at(KNEE);
  u.vrAnkleY.value = at(ANKLE);    u.vrNeckY.value = at(NECK);
  u.vrShoulderY.value = at(SHOULDER); u.vrArmLowY.value = at(ARM_LOW);
  u.vrLegSep.value = LEG_SEP * h;
  u.vrArmX0.value = ARM_X0 * h;    u.vrArmX1.value = ARM_X1 * h;
  u.vrHipB.value = HIP_B * h;      u.vrKneeB.value = KNEE_B * h;
  u.vrAnkleB.value = ANKLE_B * h;  u.vrArmB.value = ARM_B * h;
  u.legLenRig = u.vrHipY.value - u.vrFootY.value;

  for (const mesh of meshes) {
    const toRig = mesh.userData.vrToRig;
    const local = { ...u, vrToRig: { value: toRig }, vrFromRig: { value: toRig.clone().invert() } };
    const wasArray = Array.isArray(mesh.material);
    const mats = wasArray ? mesh.material : [mesh.material];
    const cloned = mats.map(m => {
      const c = m.clone();
      c.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, local);
        shader.vertexShader = PARS + shader.vertexShader
          .replace('#include <beginnormal_vertex>',
                   '#include <beginnormal_vertex>\n\tvec3 vrPos = position;\n\tvrDeform(vrPos, objectNormal);')
          .replace('#include <begin_vertex>', '\tvec3 transformed = vrPos;');
      };
      c.customProgramCacheKey = () => 'vr-walkrig';
      c.userData.vrOwned = true;   // this clone is ours to dispose
      c.needsUpdate = true;
      return c;
    });
    mesh.material = wasArray ? cloned : cloned[0];
  }
  return u;
}

// Per-character driver. `wrap` is the group the model hangs off (feet at y=0);
// it carries the body's translation, the shader carries every joint.
//
// Rotating the legs about the hip lifts both feet by legLen*(1-cos a), so the
// pelvis must drop by exactly that or the character walks on air — that drop is
// also the bob you see in a real stride. At speed a flight term lifts the body
// between contacts, and the hips shift toward whichever leg is carrying.
//
// Signature matches the procedural runner's `anim(phase, gait, crouch)`.
export function makeWalkDriver(u, wrap, legLen) {
  let g = 0, duck = 0;
  return (phase, gait, crouch) => {
    g    += (Math.min(1, Math.max(0, gait || 0)) - g) * 0.16;
    duck += ((crouch ? 1 : 0) - duck) * 0.2;
    const swing = gaitSwing(g);
    u.vrPhase.value = phase;
    u.vrGait.value  = g;
    u.vrSwing.value = swing;
    u.vrKnee.value  = gaitKnee(g);
    u.vrArm.value   = gaitArm(g);
    u.vrLean.value  = gaitLean(g);
    u.vrTwist.value = gaitTwist(g);
    if (!wrap) return;
    const squash = 1 - 0.22 * duck;
    wrap.scale.y = squash;
    const drop   = legLen * squash * (1 - Math.cos(swing * Math.sin(phase)));
    const flight = 0.085 * g * g * (0.5 + 0.5 * Math.cos(2 * phase));  // 0 at contact
    wrap.position.y = flight - drop;
    wrap.position.x = 0.03 * g * Math.sin(phase);                      // weight shift
  };
}
