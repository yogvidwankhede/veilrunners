import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Build a stylised hooded "runner". Returns a Group with an `anim(phase, speed, crouch)` method
// and a `tint(color)` method. Designed to be swapped out for a Meshy GLB of the same height (~1.8m).
export function buildRunner(color = 0x7fe3ff) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x3a2d26, roughness: 0.8, metalness: 0.0 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x1d2a28, roughness: 0.9, metalness: 0.0 });
  const trim = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1, emissive: color, emissiveIntensity: 0.25 });
  g.userData.trim = trim;

  const hips = new THREE.Group(); hips.position.y = 0.95; g.add(hips);

  // torso
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.42, 6, 12), cloth);
  torso.position.y = 0.30; torso.castShadow = true; hips.add(torso);
  // chest sash / trim
  const sash = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 20), trim);
  sash.rotation.x = Math.PI / 2; sash.position.y = 0.32; sash.scale.set(1, 1, 0.5); hips.add(sash);

  // cloak (back drape)
  const cloakGeo = new THREE.PlaneGeometry(0.5, 0.8, 1, 6);
  const cloakMat = new THREE.MeshStandardMaterial({ color: 0x14201e, roughness: 1, side: THREE.DoubleSide });
  const cloak = new THREE.Mesh(cloakGeo, cloakMat);
  cloak.position.set(0, 0.2, -0.2); cloak.rotation.x = 0.25; cloak.castShadow = true; hips.add(cloak);
  g.userData.cloak = cloak;

  // head + hood
  const head = new THREE.Group(); head.position.y = 0.66; hips.add(head);
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), skin);
  face.castShadow = true; head.add(face);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.42, 14, 1, true), cloth);
  hood.position.y = 0.06; hood.castShadow = true; head.add(hood);
  const hoodRim = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 16), trim);
  hoodRim.rotation.x = Math.PI / 2.1; hoodRim.position.set(0, 0.0, 0.05); head.add(hoodRim);

  // limbs — pivot groups so we can swing them
  const mkLimb = (len, rad, mat) => {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len, 4, 8), mat);
    m.position.y = -len / 2 - rad; m.castShadow = true; pivot.add(m);
    return pivot;
  };
  const armL = mkLimb(0.38, 0.06, cloth), armR = mkLimb(0.38, 0.06, cloth);
  armL.position.set(-0.26, 0.5, 0); armR.position.set(0.26, 0.5, 0); hips.add(armL, armR);
  const legL = mkLimb(0.44, 0.08, cloth), legR = mkLimb(0.44, 0.08, cloth);
  legL.position.set(-0.11, 0.02, 0); legR.position.set(0.11, 0.02, 0); hips.add(legL, legR);

  g.userData.parts = { hips, torso, head, armL, armR, legL, legR };

  g.tint = (c) => { trim.color.setHex(c); trim.emissive.setHex(c); hoodRim.material.color.setHex(c); };
  g.setCarrying = (on) => { trim.emissiveIntensity = on ? 0.9 : 0.25; };

  // simple procedural run/idle cycle
  g.anim = (phase, moveSpeed, crouch) => {
    const sw = Math.min(1, moveSpeed) * 0.9;
    const s = Math.sin(phase), c = Math.cos(phase);
    legL.rotation.x = s * sw; legR.rotation.x = -s * sw;
    armL.rotation.x = -s * sw * 0.8; armR.rotation.x = s * sw * 0.8;
    torso.rotation.z = c * 0.04 * sw;
    hips.position.y = (crouch ? 0.62 : 0.95) + Math.abs(s) * 0.03 * sw;
    head.rotation.z = -c * 0.03 * sw;
    cloak.rotation.x = 0.25 + 0.15 * Math.sin(phase * 0.6) + sw * 0.2;
  };
  return g;
}

// Try to load a Meshy (or any) GLB from /characters/runner.glb. Falls back silently.
export function loadRunnerGLB(url, onReady) {
  const loader = new GLTFLoader();
  loader.load(url, (gltf) => {
    const model = gltf.scene;
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // normalise height to ~1.9m
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y || 1;
    const sc = 1.9 / h; model.scale.setScalar(sc);
    const b2 = new THREE.Box3().setFromObject(model);
    model.position.y -= b2.min.y;
    onReady(model, gltf.animations || []);
  }, undefined, () => {/* no GLB present — use procedural runner */});
}
