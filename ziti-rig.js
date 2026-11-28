// The ziti's body: a head, a neck and a body on a noodle that pops up out of a plate of ziti.
//
// It's still one ziti noodle: a straight tube with the sauce on top. The top of the tube is the head,
// with your real eyes and mouth up near the sauce. Right under the mouth the noodle softens into a neck,
// and below that the body carries on down into a low bed of ziti in sauce on a plate (see ziti-plate.js).
//
// How it moves (the same idea as a face-tracked puppet whose head is pinned to your face and whose lower
// half smooth-follows): the head is bound to your face, crisp, no lag. The body's foot is stuck in the
// plate, so it works like a stalk:
//   move your head sideways   -> the noodle leans from its base to follow, a beat late, and settles
//   sit up / slouch           -> it slides up out of the plate / sinks back into it
//   lean in toward the camera -> it bends toward you
//   turn or tilt your head    -> the body twists and tilts part of the way with it
//   talk                      -> the whole noodle bobs with your voice
// The neck bends and stretches to keep head and body joined, like one piece of cooked pasta.
//
// Shared, unchanged, by ZitiCam Pocket and ZitiCam Nippon.

import * as THREE from 'three';
import { buildDish, HERO_BASE_Y, fbm } from './ziti-plate.js';

// ---- rest shape (glTF space: +Y up, +Z = the face side). ziti v2 is modeled 1.64 tall, its face in the middle.
// The head is the modeled noodle above CUT_TOP, untouched. The band between CUT_TOP and CUT_BOT is stretched into
// the neck and body; the bottom rim below it moves down whole, so the tube keeps its rounded pasta end.
const CUT_TOP = -0.15;
const CUT_BOT = -0.70;
const STRETCH = 2.09;
const DROP = (CUT_TOP - CUT_BOT) * (STRETCH - 1);   // ~0.6: how far the bottom rim moves down
// the sauce drips are shortened (not cut) so the sauce stays on the head
const SAUCE_FROM = 0.5, SAUCE_K = 0.67;
// the eyes and mouth move up the head by this much, so they sit near the top with the neck right under the mouth
const FACE_LIFT = 0.22;

const HEAD_PIVOT = -0.17;   // the head turns about the top of the neck, just under the mouth
const NECK_Y = -0.30;       // the middle of the soft part
const BODY_TOP = -0.46;     // below this, all body
// where the noodle comes up out of the pasta: the body bends about this point, like a stalk
const PIVOT_Y = HERO_BASE_Y - 0.04;
const WAIST_C = -0.27, WAIST_H = 0.14, WAIST = 0.04;   // only a hint of a dip: enough to read as a neck, still a tube

const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const remapY = (y) => (y >= CUT_TOP ? y : y >= CUT_BOT ? CUT_TOP + (y - CUT_TOP) * STRETCH : y - DROP);
const sauceY = (y) => (y >= SAUCE_FROM ? y : SAUCE_FROM + (y - SAUCE_FROM) * SAUCE_K);
const BOTTOM = remapY(-0.82);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// the tube's radius at height y, relative to the modeled noodle: 1 everywhere but a slight waist at the neck
function girth(y) {
  const u = (y - WAIST_C) / WAIST_H;
  return Math.abs(u) >= 1 ? 1 : 1 - WAIST * 0.5 * (1 + Math.cos(Math.PI * u));
}
const girthSlope = (y) => (girth(y + 1e-3) - girth(y - 1e-3)) / 2e-3;

// A damped spring, stepped in small slices so a slow frame never makes it explode.
class Spring {
  constructor() { this.x = 0; this.v = 0; }
  step(target, omega, zeta, dt) {
    const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(x = 0) { this.x = x; this.v = 0; }
}

// Shape the tall noodle from the modeled one, keeping the shading right: normals follow the stretch and the
// change in radius exactly (inverse-transpose of the deformation). Weight each point to the bones, and stain
// the part that's been down in the sauce.
const STAIN = new THREE.Color('#ff7a5c');
function buildBodyGeometry(src) {
  const g = src.clone();
  const sp = src.attributes.position, sn = src.attributes.normal;
  const dp = g.attributes.position, dn = g.attributes.normal;
  const n = sp.count;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), color = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x = sp.getX(i), y0 = sp.getY(i), z = sp.getZ(i);
    let nx = sn.getX(i), ny = sn.getY(i), nz = sn.getZ(i);
    if (y0 < CUT_TOP && y0 >= CUT_BOT) ny /= STRETCH;
    const y = remapY(y0);
    const f = girth(y);
    if (f !== 1) {
      ny -= (x * nx + z * nz) * girthSlope(y) / f;
      nx /= f; nz /= f;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    dp.setXYZ(i, x * f, y, z * f);
    dn.setXYZ(i, nx / l, ny / l, nz / l);

    // bones: 0 body, 1 neck, 2 head
    let wB = 0, wN = 0, wH = 0;
    if (y >= HEAD_PIVOT) wH = 1;
    else if (y >= NECK_Y) { wH = smooth01(NECK_Y, HEAD_PIVOT, y); wN = 1 - wH; }
    else if (y >= BODY_TOP) { wN = smooth01(BODY_TOP, NECK_Y, y); wB = 1 - wN; }
    else wB = 1;
    skinIndex.set([0, 1, 2, 0], i * 4);
    skinWeight.set([wB, wN, wH, 0], i * 4);

    // sauce clings to the noodle a little above where it comes out of the heap, in an uneven line with a few runs
    const ang = Math.atan2(z, x), ca = Math.cos(ang), sa = Math.sin(ang);
    const edge = HERO_BASE_Y + 0.1 + 0.08 * (fbm(ca * 2.2 + 1, sa * 2.2 + 3) - 0.5) + 0.18 * Math.pow(fbm(ca * 4 + 7, sa * 4 - 2), 5);
    const stain = smooth01(edge, edge - 0.06, y);
    const deep = smooth01(HERO_BASE_Y, HERO_BASE_Y - 0.28, y);   // down in the heap, out of the light
    c.setRGB(1, 1, 1).lerp(STAIN, 0.8 * stain).multiplyScalar(1 - 0.5 * deep);
    color.set([c.r, c.g, c.b], i * 3);
  }
  dp.needsUpdate = true; dn.needsUpdate = true;
  g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function shortDrips(src) {
  const g = src.clone();
  const p = g.attributes.position, nm = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y >= SAUCE_FROM) continue;
    p.setY(i, sauceY(y));
    const nx = nm.getX(i), ny = nm.getY(i) / SAUCE_K, nz = nm.getZ(i), l = Math.hypot(nx, ny, nz) || 1;
    nm.setXYZ(i, nx / l, ny / l, nz / l);
  }
  p.needsUpdate = true; nm.needsUpdate = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function ring(out, r, y, sides = 16) {
  const R = r / Math.cos(Math.PI / sides);   // a polygon that fully contains the circle
  for (let i = 0; i < sides; i++) out.push(new THREE.Vector3(R * Math.cos(2 * Math.PI * i / sides), y, R * Math.sin(2 * Math.PI * i / sides)));
}

// Fit a camera that looks down on the figure from `el` radians up, `D` units away, so every point fits with a margin.
function fitCamera(points, aspect, el, D, margin) {
  let lookY = 0, fov = 30;
  const cam = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), v = new THREE.Vector3();
  for (let it = 0; it < 6; it++) {
    cam.set(0, lookY + D * Math.sin(el), D * Math.cos(el));
    fwd.set(0, lookY, 0).sub(cam).normalize();
    right.crossVectors(fwd, up.set(0, 1, 0)).normalize();
    up.crossVectors(right, fwd);
    let top = -Infinity, bot = Infinity, side = 0;
    for (const p of points) {
      v.subVectors(p, cam);
      const zc = v.dot(fwd);
      top = Math.max(top, Math.atan2(v.dot(up), zc)); bot = Math.min(bot, Math.atan2(v.dot(up), zc));
      side = Math.max(side, Math.abs(v.dot(right) / zc));
    }
    lookY += Math.tan((top + bot) / 2) * D;   // re-center vertically
    const halfV = Math.max((top - bot) / 2, Math.atan(side / aspect));
    fov = 2 * halfV * (1 + margin) * 180 / Math.PI;
  }
  return { fov, camY: lookY + D * Math.sin(el), camZ: D * Math.cos(el), lookY };
}

export function createZitiRig() {
  const object = new THREE.Group();
  object.name = 'ZitiRig';

  // Bones sit side by side (not in a chain): each frame sets where each one is, the skin blends between them.
  const bones = ['Body', 'Neck', 'Head'].map((name) => { const b = new THREE.Bone(); b.name = name; object.add(b); return b; });
  const [bodyBone, neckBone, headBone] = bones;
  const REST_Y = [PIVOT_Y, NECK_Y, HEAD_PIVOT];
  bones.forEach((b, i) => b.position.set(0, REST_Y[i], 0));
  const LEVER = NECK_Y - PIVOT_Y;   // from where it leaves the heap up to the neck

  // Anything placed in headSpace / bodySpace uses the noodle's rest coordinates and rides that bone.
  const headSpace = new THREE.Group(); headSpace.name = 'HeadSpace';
  headSpace.position.y = -HEAD_PIVOT; headBone.add(headSpace);
  const bodySpace = new THREE.Group(); bodySpace.name = 'BodySpace';
  bodySpace.position.y = -PIVOT_Y; bodyBone.add(bodySpace);

  let skinned = null, classic = null, dish = null, keyLight = null;
  let sauceClassic = null, sauceBody = null;
  let bodyOn = true, sauceOn = true;
  const hullHead = [], hullBody = [], hullClassic = [];
  const framePts = { body: [], classic: [] };

  // root: the loaded ziti.glb scene. prepare(material): the app's finishing touch for new materials (its tone curve).
  function attachModel(root, { prepare = () => {} } = {}) {
    root.updateMatrixWorld(true);
    const bodyMesh = root.getObjectByName('ZitiBody');
    const sauceMesh = root.getObjectByName('Sauce');
    if (!bodyMesh) throw new Error('ziti.glb has no ZitiBody');
    const src = bodyMesh.geometry.clone().applyMatrix4(bodyMesh.matrixWorld);

    classic = new THREE.Mesh(src, bodyMesh.material);
    classic.name = 'ZitiClassic';
    headSpace.add(classic);

    const stained = bodyMesh.material.clone();
    stained.vertexColors = true;
    prepare(stained);
    skinned = new THREE.SkinnedMesh(buildBodyGeometry(src), stained);
    skinned.name = 'ZitiBody';
    skinned.frustumCulled = false;
    skinned.castShadow = true; skinned.receiveShadow = true;
    object.add(skinned);
    // bind in the rest pose; from then on only the bones' local poses matter
    const keep = bones.map((b) => [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
    bones.forEach((b, i) => { b.position.set(0, REST_Y[i], 0); b.quaternion.identity(); b.scale.set(1, 1, 1); });
    object.updateMatrixWorld(true);
    skinned.bind(new THREE.Skeleton(bones), skinned.matrixWorld);
    bones.forEach((b, i) => { b.position.copy(keep[i][0]); b.quaternion.copy(keep[i][1]); b.scale.copy(keep[i][2]); });

    if (sauceMesh) {
      const baked = sauceMesh.geometry.clone().applyMatrix4(sauceMesh.matrixWorld);
      sauceClassic = new THREE.Mesh(baked, sauceMesh.material); sauceClassic.name = 'Sauce';
      sauceBody = new THREE.Mesh(shortDrips(baked), sauceMesh.material); sauceBody.name = 'SauceBody';
      sauceBody.castShadow = true; sauceBody.receiveShadow = true;
      headSpace.add(sauceClassic, sauceBody);
    }

    dish = buildDish({ pasta: bodyMesh.material, sauce: sauceMesh ? sauceMesh.material : bodyMesh.material, prepare });
    object.add(dish.group);

    // bounds, as upright prisms in each part's rest space (a box would stick out past a round noodle as it turns)
    const v = new THREE.Vector3();
    let r = 0.55, top = -Infinity, bot = Infinity;
    for (const m of [classic, sauceClassic]) {
      const p = m?.geometry.attributes.position;
      if (!p) continue;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); r = Math.max(r, Math.hypot(v.x, v.z)); top = Math.max(top, v.y); bot = Math.min(bot, v.y); }
    }
    r *= 1.04; top += 0.03; bot -= 0.03;
    ring(hullHead, r, NECK_Y - 0.06); ring(hullHead, r, top);
    ring(hullBody, r, BOTTOM - 0.03); ring(hullBody, r, CUT_TOP);
    ring(hullClassic, r, bot); ring(hullClassic, r, top);

    // what the camera has to keep in view: the plate (as tilted) and the head with room to drift up
    object.updateMatrixWorld(true);
    const toObj = new THREE.Matrix4().copy(object.matrixWorld).invert().multiply(dish.space.matrixWorld);
    framePts.body = [...dish.hull.map((p) => p.clone().applyMatrix4(toObj))];
    // room for the head to roam: popped up, and leaning out to either side
    for (const dx of [-0.42, 0, 0.42]) {
      const pts = []; ring(pts, r, top + (dx ? 0.12 : 0.3));
      for (const p of pts) framePts.body.push(p.add(new THREE.Vector3(dx, 0, 0)));
    }
    framePts.classic = hullClassic;
    showParts();
  }

  function showParts() {
    if (skinned) skinned.visible = bodyOn;
    if (classic) classic.visible = !bodyOn;
    if (dish) dish.group.visible = bodyOn;
    if (sauceClassic) sauceClassic.visible = sauceOn && !bodyOn;
    if (sauceBody) sauceBody.visible = sauceOn && bodyOn;
    if (keyLight) keyLight.castShadow = bodyOn;   // the classic noodle stays exactly as it always looked
  }
  function setBody(on) {
    if (bodyOn !== !!on) reset();
    bodyOn = !!on;
    showParts();
  }
  function setSauce(on) { sauceOn = !!on; showParts(); }

  // soft shadows from the key light: the heap gets its depth, the noodle sits in it instead of on it
  function useShadows(renderer, light) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    keyLight = light;
    const sc = light.shadow.camera;
    Object.assign(sc, { left: -2.4, right: 2.4, top: 2.4, bottom: -2.4, near: 0.5, far: 14 });
    sc.updateProjectionMatrix();
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    showParts();
  }

  // camera framing for the current mode and picture shape (the apps add their own zoom and up/down on top)
  const frameCache = new Map();
  function frameFor(aspect) {
    if (!bodyOn || !framePts.body.length) return { fov: 28, camY: 0.25, camZ: 6, lookY: 0.05 };
    const k = aspect.toFixed(3);
    if (!frameCache.has(k)) frameCache.set(k, fitCamera(framePts.body, aspect, 0.17, 6, 0.04));
    return frameCache.get(k);
  }

  // ---- motion
  const S = {
    rise: new Spring(),                                           // how far it's popped up out of the plate
    yaw: new Spring(), pitch: new Spring(), roll: new Spring(),   // how it's twisted and leaning
    hz: new Spring(), talk: new Spring(),
  };
  // how far the head roams over the plate, compared with the classic noodle's drift
  const REACH_X = 1.8, REACH_Y = 1.6;
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const qB = new THREE.Quaternion(), qN = new THREE.Quaternion();
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpS = new THREE.Vector3();
  let t0 = null;

  // in: head turn (quaternion, already smoothed), head drift (x, y: where your head is in the camera, in glTF
  // units, as the classic noodle drifts), jaw 0..1, lean (+ = toward the camera). opts: bounce (talk squash and
  // bob), follow (0..1, how much the body copies the head's turn), wobble (0..1, how springy it is).
  // dt in seconds, now in ms.
  function update({ quat, x = 0, y = 0, jaw = 0, lean = 0 }, opts, dt, now) {
    const bounce = opts.bounce ?? 2, follow = opts.follow ?? 0.5, wobble = opts.wobble ?? 0.5;
    if (t0 === null) t0 = now;
    const t = (now - t0) / 1000;

    // talking squashes the head up and in, about its base (on the plate) or its middle (classic)
    const sy = 1 + 0.035 * jaw * bounce, sxz = 1 - 0.015 * jaw * bounce;
    tmpS.set(sxz, sy, sxz);
    headBone.scale.lerp(tmpS, 0.5);

    if (!bodyOn) {
      // the original rigid noodle: turns about its middle, drifts as a whole
      headBone.quaternion.copy(quat);
      tmpA.set(0, HEAD_PIVOT, 0).multiply(headBone.scale).applyQuaternion(quat);
      headBone.position.set(x, y, 0).add(tmpA);
      return;
    }

    e.setFromQuaternion(quat, 'YXZ');
    const zeta = 0.95 - 0.6 * wobble, omega = 10.5 + 6 * wobble;
    const breath = Math.sin(t * 2 * Math.PI * 0.21);   // a slow breath, so it's never quite still

    // where the head wants to be: your head's spot in the camera, scaled up to roam over the plate
    const hx = clamp(x * REACH_X, -0.62, 0.62);
    const hy = clamp(y * REACH_Y, -0.24, 0.32);
    const hz = S.hz.step(clamp(lean, -0.25, 0.4), 9, 0.9, dt);
    // talking: a quick springy hop with your voice
    const talk = S.talk.step(jaw * bounce * 0.035, 22, 0.32, dt);

    // ---- body: a stalk stuck in the plate. Up/down slides it out of the pasta or back in; sideways and
    // toward-the-camera bend it from its base so its top reaches the head. All on springs, a beat late.
    const rise = S.rise.step(hy, 7, 0.7, dt);
    const reach = LEVER + rise;
    const leanZ = -Math.atan2(hx, reach) + e.z * 0.5 * follow;
    const leanX = Math.atan2(hz, reach) + e.x * 0.35 * follow;
    const roll = S.roll.step(leanZ, omega, zeta, dt);
    const pitch = S.pitch.step(leanX, omega, zeta, dt);
    const yaw = S.yaw.step(e.y * 0.7 * follow, omega * 0.85, zeta, dt);
    qB.setFromEuler(e.set(pitch, yaw, roll, 'YXZ'));
    bodyBone.quaternion.copy(qB);
    // it slides along its own leaning axis, so it always comes up out of the same spot in the pasta
    tmpA.set(0, rise + talk, 0).applyQuaternion(qB);
    bodyBone.position.set(0, PIVOT_Y, 0).add(tmpA);
    bodyBone.scale.set(1 - 0.004 * breath, 1 + 0.006 * breath, 1 - 0.004 * breath);

    // ---- head: bound to the face. Crisp, no springs: this is the part people read. It rides the talk hop.
    headBone.quaternion.copy(quat);
    headBone.position.set(hx, HEAD_PIVOT + hy + talk + 0.006 * breath, hz);

    // ---- neck: halfway between, in place and in turn, so the soft part bends evenly
    tmpA.set(0, NECK_Y - PIVOT_Y, 0).multiply(bodyBone.scale).applyQuaternion(qB).add(bodyBone.position);
    tmpB.set(0, NECK_Y - HEAD_PIVOT, 0).applyQuaternion(quat).add(headBone.position);
    neckBone.position.addVectors(tmpA, tmpB).multiplyScalar(0.5);
    neckBone.quaternion.copy(qN.slerpQuaternions(qB, quat, 0.5));
  }

  function reset() { for (const s of Object.values(S)) s.reset(); }

  // the figure's outline points in world space (call after the scene's matrices are up to date)
  const outHull = [];
  function hullWorld() {
    let k = 0;
    const add = (pts, space) => {
      for (const p of pts) { (outHull[k] ||= new THREE.Vector3()).copy(p).applyMatrix4(space.matrixWorld); k++; }
    };
    if (bodyOn) { add(hullHead, headSpace); add(hullBody, bodySpace); if (dish) add(dish.hull, dish.space); } else add(hullClassic, headSpace);
    outHull.length = k;
    return outHull;
  }

  return {
    object, headSpace, bodySpace, bones, attachModel, setBody, setSauce, useShadows, frameFor, update, reset, hullWorld,
    get body() { return bodyOn; },
    get ready() { return !!skinned; },
    // how far the eyes and mouth sit above where the classic noodle has them
    get faceLift() { return bodyOn ? FACE_LIFT : 0; },
  };
}
