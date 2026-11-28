// The ziti's body: a head and a body on a noodle that pops up out of a plate of ziti.
//
// It's still one ziti noodle: a straight tube with the sauce on top. The top of the tube is the head,
// with your real eyes and mouth up near the sauce; below it the body runs down into a low bed of ziti
// in sauce on a plate (see ziti-plate.js).
//
// How it moves, the way a face-tracked puppet does: the head is pinned to your face, and everything below
// it follows less and less of it, smoothed so it trails behind and settles without bouncing:
//   head   all of it, instantly: where your head is, which way it faces, how it tilts
//   body   about half of the turn and tilt, a beat late, and it leans over to reach the head, so the whole
//          noodle faces where you face and leans where you lean
//   plate  the least: it slides and turns a little toward you, slowest of all
// The body is a smooth spine of joints from the plate to the head, so it bows in one continuous curve
// instead of creasing at a neck, and it slides up out of the pasta or back in to keep its length as the
// head moves away from or toward the plate. Talking gives it a small hop.
//
// Shared, unchanged, by ZitiCam Pocket and ZitiCam Nippon.

import * as THREE from 'three';
import { buildDish, HERO_BASE_Y, HERO_SHADOW, fbm } from './ziti-plate.js';

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

const HEAD_PIVOT = -0.17;   // the head turns about here, just under the mouth: the top of the spine
// where the noodle comes up out of the pasta: the bottom of the spine
const PIVOT_Y = HERO_BASE_Y - 0.04;
const SPINE = 8;            // joints from the plate up to the head (the head is the last one)
const spineY = (k) => PIVOT_Y + (HEAD_PIVOT - PIVOT_Y) * (k / SPINE);
const SPINE_LEN = HEAD_PIVOT - PIVOT_Y;

const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const remapY = (y) => (y >= CUT_TOP ? y : y >= CUT_BOT ? CUT_TOP + (y - CUT_TOP) * STRETCH : y - DROP);
const sauceY = (y) => (y >= SAUCE_FROM ? y : SAUCE_FROM + (y - SAUCE_FROM) * SAUCE_K);
const BOTTOM = remapY(-0.82);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// how much of the way to go this frame, to trail a target by `tau` seconds without ever overshooting it
const ease = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-3, tau));

// Shape the tall noodle from the modeled one, keeping the shading right (normals follow the stretch), weight
// each point to the two spine joints either side of it, and stain the part that's been down in the sauce.
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
    const l = Math.hypot(nx, ny, nz) || 1;
    dp.setXYZ(i, x, y, z);
    dn.setXYZ(i, nx / l, ny / l, nz / l);

    // joints: 0 where it leaves the pasta ... SPINE the head. Between two joints, a point blends them, so the
    // tube follows the spine's curve smoothly.
    const f = clamp((y - PIVOT_Y) / SPINE_LEN, 0, 1) * SPINE;
    const k0 = Math.min(SPINE, Math.floor(f)), k1 = Math.min(SPINE, k0 + 1), w = f - k0;
    skinIndex.set([k0, k1, 0, 0], i * 4);
    skinWeight.set([1 - w, w, 0, 0], i * 4);

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

  // The spine's joints sit side by side (not in a chain): each frame sets where each one is along a smooth curve
  // from the plate to the head, and the skin blends between them.
  const bones = [];
  for (let k = 0; k <= SPINE; k++) { const b = new THREE.Bone(); b.name = k === SPINE ? 'Head' : 'Spine' + k; object.add(b); bones.push(b); }
  const baseBone = bones[0], headBone = bones[SPINE];
  const REST_Y = bones.map((_, k) => spineY(k));
  bones.forEach((b, k) => b.position.set(0, REST_Y[k], 0));

  // Anything placed in headSpace / bodySpace uses the noodle's rest coordinates and rides that bone.
  const headSpace = new THREE.Group(); headSpace.name = 'HeadSpace';
  headSpace.position.y = -HEAD_PIVOT; headBone.add(headSpace);
  const bodySpace = new THREE.Group(); bodySpace.name = 'BodySpace';
  bodySpace.position.y = -PIVOT_Y; baseBone.add(bodySpace);

  let skinned = null, classic = null, dish = null, keyLight = null;
  let sauceClassic = null, sauceBody = null;
  let bodyOn = true, sauceOn = true;
  const hullHead = [], hullBody = [], hullClassic = [], hullJoint = [];
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
    ring(hullHead, r, HEAD_PIVOT - 0.04); ring(hullHead, r, top);
    ring(hullBody, r, BOTTOM - 0.03);
    ring(hullJoint, r, 0, 10);   // around each spine joint
    ring(hullClassic, r, bot); ring(hullClassic, r, top);

    // what the camera has to keep in view: the plate (as tilted) and the head with room to drift up
    object.updateMatrixWorld(true);
    const toObj = new THREE.Matrix4().copy(object.matrixWorld).invert().multiply(dish.space.matrixWorld);
    framePts.body = [];
    for (const dx of [-0.13, 0.13]) for (const p of dish.hull) framePts.body.push(p.clone().applyMatrix4(toObj).add(new THREE.Vector3(dx, 0, 0)));   // the plate drifts a little
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
  }
  function setBody(on) {
    if (bodyOn !== !!on) reset();
    bodyOn = !!on;
    showParts();
  }
  function setSauce(on) { sauceOn = !!on; showParts(); }

  // the key light the noodle's shadow falls away from. No shadow map: the plate's own shadows are baked when
  // it's built, and the noodle's is worked out per pixel from where it is (see ziti-plate.js), which costs a
  // fraction of drawing and sampling a shadow map every frame.
  function useLight(light) { keyLight = light; }
  const heroA = new THREE.Vector3(), heroB = new THREE.Vector3();
  function placeShadow() {
    const U = HERO_SHADOW;
    U.uZitiK.value = bodyOn ? 0.4 : 0;
    if (!bodyOn) return;
    // the visible noodle, from where it leaves the pasta to the top of its head, in world space
    heroA.copy(baseBone.position);
    heroB.set(0, 0.9 - HEAD_PIVOT, 0).multiply(headBone.scale).applyQuaternion(headBone.quaternion).add(headBone.position);
    U.uZitiA.value.copy(heroA).applyMatrix4(object.matrixWorld);
    U.uZitiB.value.copy(heroB).applyMatrix4(object.matrixWorld);
    if (keyLight) U.uZitiL.value.copy(keyLight.getWorldPosition(tmpB)).normalize();
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
  // how far the head roams over the plate, compared with the classic noodle's drift
  const REACH_X = 1.8, REACH_Y = 1.6;
  const IDENT = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  const st = { bodyQ: new THREE.Quaternion(), lean: new THREE.Vector3(0, 1, 0), slide: 0, talk: 0, hz: 0, plateX: 0, plateZ: 0, plateYaw: 0 };
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const qT = new THREE.Quaternion(), qK = new THREE.Quaternion(), qA = new THREE.Quaternion();
  const P0 = new THREE.Vector3(), P1 = new THREE.Vector3(), T0 = new THREE.Vector3(), T1 = new THREE.Vector3(), anchor = new THREE.Vector3();
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpS = new THREE.Vector3(), tan = new THREE.Vector3();

  // in: head turn (quaternion, already smoothed), head drift (x, y: where your head is in the camera, in glTF
  // units, as the classic noodle drifts), jaw 0..1, lean (+ = toward the camera). opts: bounce (talk squash and
  // hop), follow (0..1, how much of the head's turn and tilt the body takes), wobble (0..1, how far behind it
  // trails). dt in seconds.
  function update({ quat, x = 0, y = 0, jaw = 0, lean = 0 }, opts, dt) {
    const bounce = opts.bounce ?? 2, follow = opts.follow ?? 0.5, wobble = opts.wobble ?? 0.5;

    // talking squashes the head up and in, about its base (on the plate) or its middle (classic)
    const sy = 1 + 0.035 * jaw * bounce, sxz = 1 - 0.015 * jaw * bounce;
    tmpS.set(sxz, sy, sxz);
    headBone.scale.lerp(tmpS, 0.5);

    if (!bodyOn) {
      // the original rigid noodle: turns about its middle, drifts as a whole
      headBone.quaternion.copy(quat);
      tmpA.set(0, HEAD_PIVOT, 0).multiply(headBone.scale).applyQuaternion(quat);
      headBone.position.set(x, y, 0).add(tmpA);
      placeShadow();
      return;
    }

    const share = 0.3 + 0.5 * follow;   // the body takes this much of the head's turn and tilt (0.55 by default)
    const lag = 0.1 + 0.45 * wobble;     // seconds the body trails behind (a third of a second by default)
    e.setFromQuaternion(quat, 'YXZ');

    // ---- head: pinned to your face. Crisp, no smoothing of its own: this is the part people read.
    st.hz += (clamp(lean, -0.25, 0.4) - st.hz) * ease(dt, 0.12);
    st.talk += (jaw * bounce * 0.03 - st.talk) * ease(dt, 0.05);
    P1.set(clamp(x * REACH_X, -0.62, 0.62), HEAD_PIVOT + clamp(y * REACH_Y, -0.24, 0.32) + st.talk, st.hz);
    T1.copy(UP).applyQuaternion(quat);

    // ---- plate: follows least and slowest. It slides and turns a little toward where you are.
    const pl = ease(dt, lag * 1.8);
    st.plateX += (P1.x * 0.2 - st.plateX) * pl;
    st.plateZ += (st.hz * 0.12 - st.plateZ) * pl;
    st.plateYaw += (e.y * 0.15 - st.plateYaw) * pl;
    if (dish) { dish.group.position.set(st.plateX, 0, st.plateZ); dish.group.rotation.set(0, st.plateYaw, 0); }
    anchor.set(st.plateX, PIVOT_Y, st.plateZ);   // the hole in the pasta it comes up through

    // ---- body: takes part of the head's turn and tilt, a beat late, and leans over toward the head.
    const bl = ease(dt, lag);
    qT.slerpQuaternions(IDENT, quat, share);
    st.bodyQ.slerp(qT, bl);
    // its own share of the head's tilt, plus most of the lean it takes to reach the head where it's gone
    tmpA.subVectors(P1, anchor).normalize().sub(UP);
    tmpB.copy(UP).applyQuaternion(st.bodyQ).addScaledVector(tmpA, 0.85).normalize();
    st.lean.lerp(tmpB, bl).normalize();
    T0.copy(st.lean);
    // it keeps its length by sliding out of the pasta or back in, so reaching for the head never stretches it
    const want = clamp(P1.distanceTo(anchor) - SPINE_LEN, -0.3, 0.32);
    st.slide += (want - st.slide) * bl;
    P0.copy(anchor).addScaledVector(T0, st.slide);

    // ---- the spine: one smooth curve from the base to the head (Hermite), so the noodle never creases. A long
    // lead-out at the base keeps the body fairly straight, like a stiff noodle leaning; a short one at the head
    // gathers the bend in the top third, just under the head. The turn passes up it the same way: the body's
    // share at the bottom, all of the head's at the top.
    const L = P0.distanceTo(P1), m0 = L * 1.15, m1 = L * 0.55;
    for (let k = 0; k <= SPINE; k++) {
      const u = k / SPINE, u2 = u * u, u3 = u2 * u;
      const b = bones[k];
      b.position.copy(P0).multiplyScalar(2 * u3 - 3 * u2 + 1)
        .addScaledVector(T0, m0 * (u3 - 2 * u2 + u))
        .addScaledVector(P1, -2 * u3 + 3 * u2)
        .addScaledVector(T1, m1 * (u3 - u2));
      tan.copy(P0).multiplyScalar(6 * u2 - 6 * u)
        .addScaledVector(T0, m0 * (3 * u2 - 4 * u + 1))
        .addScaledVector(P1, -6 * u2 + 6 * u)
        .addScaledVector(T1, m1 * (3 * u2 - 2 * u)).normalize();
      qK.slerpQuaternions(st.bodyQ, quat, u2 * u2 * (5 - 4 * u));   // mostly in the top third
      // stand the joint along the curve, keeping its twist
      qA.setFromUnitVectors(tmpA.copy(UP).applyQuaternion(qK), tan);
      b.quaternion.copy(qA).multiply(qK);
      if (k < SPINE) b.scale.set(1, 1, 1);
    }
    headBone.position.copy(P1);
    headBone.quaternion.copy(quat);
    placeShadow();
  }

  function reset() {
    st.bodyQ.identity(); st.lean.copy(UP);
    st.slide = st.talk = st.hz = st.plateX = st.plateZ = st.plateYaw = 0;
  }

  // the figure's outline points in world space (call after the scene's matrices are up to date)
  const outHull = [];
  function hullWorld() {
    let k = 0;
    const add = (pts, space) => {
      for (const p of pts) { (outHull[k] ||= new THREE.Vector3()).copy(p).applyMatrix4(space.matrixWorld); k++; }
    };
    if (bodyOn) {
      add(hullHead, headSpace); add(hullBody, bodySpace);
      for (let j = 0; j < SPINE; j++) add(hullJoint, bones[j]);
      if (dish) add(dish.hull, dish.space);
    } else add(hullClassic, headSpace);
    outHull.length = k;
    return outHull;
  }

  return {
    object, headSpace, bodySpace, bones, attachModel, setBody, setSauce, useLight, frameFor, update, reset, hullWorld,
    get body() { return bodyOn; },
    get ready() { return !!skinned; },
    // how far the eyes and mouth sit above where the classic noodle has them
    get faceLift() { return bodyOn ? FACE_LIFT : 0; },
  };
}
