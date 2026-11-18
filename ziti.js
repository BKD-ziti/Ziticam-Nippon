// The live-face ziti: same model, tracker and tuning as ZitiCam Pocket, rendered on a
// transparent canvas so it can sit on top of anything without a key color.

import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import { RoomEnvironment } from './RoomEnvironment.js';

export const ZITI_ASPECT = 3 / 4;   // width / height of the ziti box
const MP_VER = '0.10.35';

const SURFACE_R = 0.524;
const FACE_SPAN = 0.92;
const FACE_REF = new THREE.Vector2(0.0, 0.20);
const LM = {
  rEyeOuter: 33, rEyeInner: 133, lEyeInner: 362, lEyeOuter: 263,
  rBrowTop: 105, lBrowTop: 334,
  mouthL: 61, mouthR: 291, lipTop: 0, lipBot: 17,
  bridge: 168, cheekR: 234, cheekL: 454, forehead: 10, chin: 152,
};

class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.03, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null }); }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

const insetVert = /* glsl */`
  uniform vec2 uCenter; uniform vec2 uSize; uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float x = uCenter.x + position.x * uSize.x;
    float y = uCenter.y + position.y * uSize.y;
    float z = sqrt(max(uRadius * uRadius - x * x, 0.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, z, 1.0);
  }`;
const insetFrag = /* glsl */`
  uniform sampler2D uMap; uniform vec2 uVideo; uniform vec2 uCropC; uniform vec2 uCropH;
  uniform float uAngle; uniform float uMirror; uniform float uFeather; uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 d2 = (vUv - 0.5) * 2.0;
    float d = length(d2);
    float a = 1.0 - smoothstep(1.0 - uFeather, 1.0, d);
    if (a <= 0.002) discard;
    vec2 o = vec2(d2.x * uCropH.x, -d2.y * uCropH.y);
    float c = cos(uAngle), s = sin(uAngle);
    vec2 p = uCropC + vec2(c * o.x - s * o.y, s * o.x + c * o.y);
    vec2 n = p / uVideo;
    if (uMirror > 0.5) n.x = 1.0 - n.x;
    vec4 col = texture2D(uMap, vec2(n.x, 1.0 - n.y));
    float edge = smoothstep(0.5, 1.0, d);
    col.rgb *= 1.0 - 0.12 * edge;
    gl_FragColor = vec4(col.rgb, a * uOpacity);
    #include <colorspace_fragment>
  }`;

export function createZiti({ CFG, store, videoEl, mpBase, onChange = () => {} }) {
  const status = { tracker: 'loading', trackerSrc: '', det: 0, face: false, err: '', ready: false, loadPct: 0, camFrames: 0 };

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(28, ZITI_ASPECT, 0.1, 50);
  const world = new THREE.Group();
  scene.add(world);
  world.add(new THREE.HemisphereLight(0xfff1dc, 0x3b2a1e, 0.9));
  const key = new THREE.DirectionalLight(0xffe7cc, 2.4); key.position.set(-2.2, 3.2, 4.0); world.add(key);
  const fill = new THREE.DirectionalLight(0xd8e4ff, 0.7); fill.position.set(3.0, 0.5, 2.5); world.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.6); rim.position.set(1.2, 2.5, -3.5); world.add(rim);
  const rig = new THREE.Group();
  const bob = new THREE.Group();
  rig.add(bob);
  world.add(rig);
  let sauceNode = null;

  let size = [0, 0];
  function setSize(w, h) {
    // the ziti is drawn at about the size it appears in the video; snap to steps so live resizing stays cheap
    const rh = Math.max(128, Math.min(1080, Math.round(h / 48) * 48));
    const rw = Math.round(rh * ZITI_ASPECT);
    if (rw === size[0] && rh === size[1]) return;
    size = [rw, rh];
    renderer.setSize(rw, rh, false);
  }
  setSize(480, 640);

  function applyFraming() {
    camera.fov = 28 / Math.max(0.3, CFG.zoom);
    camera.position.set(0, 0.25 - CFG.lift, 6.0);
    camera.lookAt(0, 0.05 - CFG.lift, 0);
    camera.updateProjectionMatrix();
  }
  function applyLook() {
    world.scale.x = CFG.flip ? -1 : 1;
    if (sauceNode) sauceNode.visible = CFG.sauce;
    applyFraming();
  }

  // ---- face insets
  const snap = document.createElement('canvas');
  const snapCtx = snap.getContext('2d', { alpha: false });
  const videoTex = new THREE.CanvasTexture(snap);
  videoTex.colorSpace = THREE.SRGBColorSpace;
  videoTex.minFilter = THREE.LinearFilter;
  videoTex.magFilter = THREE.LinearFilter;
  videoTex.generateMipmaps = false;
  function snapshotFrame() {
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w) return false;
    if (snap.width !== w || snap.height !== h) { snap.width = w; snap.height = h; videoTex.dispose(); }
    snapCtx.drawImage(videoEl, 0, 0, w, h);
    videoTex.needsUpdate = true;
    return true;
  }
  function makeInset(name, feather) {
    const mat = new THREE.ShaderMaterial({
      name,
      uniforms: {
        uMap: { value: videoTex }, uVideo: { value: new THREE.Vector2(720, 1280) },
        uCropC: { value: new THREE.Vector2() }, uCropH: { value: new THREE.Vector2(1, 1) },
        uAngle: { value: 0 }, uMirror: { value: 0 }, uFeather: { value: feather }, uOpacity: { value: 0 },
        uCenter: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(0.1, 0.1) }, uRadius: { value: SURFACE_R },
      },
      vertexShader: insetVert, fragmentShader: insetFrag,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 24, 12), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    bob.add(mesh);
    return mesh;
  }
  const insets = { eyeR: makeInset('eyeR', 0.28), eyeL: makeInset('eyeL', 0.28), mouth: makeInset('mouth', 0.26) };

  // ---- model
  new GLTFLoader().load('./ziti.glb', (gltf) => {
    const root = gltf.scene;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (o.name.startsWith('Sauce')) { m.roughness = 0.22; if ('clearcoat' in m) { m.clearcoat = 0.6; m.clearcoatRoughness = 0.08; } }
      else m.roughness = 0.55;
      m.envMapIntensity = 0.9;
    });
    sauceNode = root.getObjectByName('Sauce');
    bob.add(root);
    status.ready = true;
    applyLook();
    onChange();
  }, (e) => { if (e.total) { status.loadPct = Math.round(100 * e.loaded / e.total); onChange(); } },
  (e) => { status.err = 'model: ' + e.message; onChange(); });

  // ---- smoothing
  const filters = new Map();
  const baseCut = () => 3.0 - 2.7 * Math.min(1, Math.max(0, CFG.smooth));
  const smooth = (k, v, t, scale = 1, b = 0.03) => {
    if (!filters.has(k)) filters.set(k, new OneEuro(1, b));
    const f = filters.get(k);
    f.minCutoff = baseCut() * scale; f.beta = b;
    return f.filter(v, t);
  };
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  // ---- head pose + insets
  const target = { quat: new THREE.Quaternion(), pos: new THREE.Vector2(), jaw: 0, seen: -1e9 };
  const neutralInv = new THREE.Quaternion();
  const savedNeutral = store.get('nippon.neutral', null);
  if (Array.isArray(savedNeutral)) neutralInv.fromArray(savedNeutral);
  const lastRawQuat = new THREE.Quaternion();
  let lastRawT = -1e9;
  const mB = new THREE.Matrix4();
  const vx = new THREE.Vector3(), vy = new THREE.Vector3(), vz = new THREE.Vector3();

  function onFace(lm, blend, t) {
    const W = videoEl.videoWidth, H = videoEl.videoHeight;
    const mx = CFG.mirror ? (x) => 1 - x : (x) => x;
    const P2 = (i) => new THREE.Vector2(mx(lm[i].x) * W, lm[i].y * H);
    const P3 = (i) => new THREE.Vector3(mx(lm[i].x) * W, -lm[i].y * H, -lm[i].z * W);

    vx.subVectors(P3(LM.cheekL), P3(LM.cheekR)).normalize();
    vy.subVectors(P3(LM.forehead), P3(LM.chin)).normalize();
    vz.crossVectors(vx, vy).normalize();
    vy.crossVectors(vz, vx).normalize();
    mB.makeBasis(vx, vy, vz);
    const raw = new THREE.Quaternion().setFromRotationMatrix(mB);
    lastRawQuat.copy(raw); lastRawT = t;
    const rel = neutralInv.clone().multiply(raw);
    if (CFG.turn !== 1) rel.slerp(new THREE.Quaternion(), 1 - CFG.turn);
    euler.setFromQuaternion(rel, 'YXZ');
    euler.set(smooth('rx', euler.x, t, 1, 0.6), smooth('ry', euler.y, t, 1, 0.6), smooth('rz', euler.z, t, 1, 0.6), 'YXZ');
    target.quat.setFromEuler(euler);

    const faceW = smooth('faceW', P3(LM.cheekL).distanceTo(P3(LM.cheekR)), t, 0.7, 0.004);
    const eR = P2(LM.rEyeOuter).add(P2(LM.rEyeInner)).multiplyScalar(0.5);
    const eL = P2(LM.lEyeOuter).add(P2(LM.lEyeInner)).multiplyScalar(0.5);
    const roll = Math.atan2(eL.y - eR.y, eL.x - eR.x);
    const cr = Math.cos(-roll), sr = Math.sin(-roll);
    const bridge = P2(LM.bridge);
    const toFace = (p) => {
      const dx = p.x - bridge.x, dy = p.y - bridge.y;
      return new THREE.Vector2((cr * dx - sr * dy) / faceW, (sr * dx + cr * dy) / faceW);
    };

    target.pos.set(smooth('px', (bridge.x / W - 0.5) * 2, t, 1, 1.0), smooth('py', -(bridge.y / H - 0.5) * 2, t, 1, 1.0));

    const eye = (outer, inner, browTop, k) => {
      const a = P2(outer), b = P2(inner);
      const w = a.distanceTo(b);
      const c = a.clone().add(b).multiplyScalar(0.5);
      let halfW = w * 0.95, halfH = w * 0.62;
      if (CFG.brows) {
        const brow = P2(browTop);
        const up = Math.max(0, (c.y - brow.y) * Math.cos(roll)) * 1.25;
        halfH = Math.max(halfH, (up + w * 0.55) / 2);
        c.x += Math.sin(roll) * (halfH - w * 0.55);
        c.y -= Math.cos(roll) * (halfH - w * 0.55);
      }
      const f = toFace(c);
      const s = CFG.eyes;
      const cx = smooth(k + 'cx', c.x, t, 1.6, 0.03), cy = smooth(k + 'cy', c.y, t, 1.6, 0.03);
      const hw = smooth(k + 'hw', halfW, t, 0.5, 0.002), hh = smooth(k + 'hh', halfH, t, 0.5, 0.002);
      return {
        crop: [cx, cy, hw, hh],
        center: [FACE_REF.x + smooth(k + 'fx', f.x, t, 0.6, 0.5) * FACE_SPAN * CFG.eyeSpread, FACE_REF.y - smooth(k + 'fy', f.y, t, 0.6, 0.5) * FACE_SPAN + CFG.eyeLift],
        size: [(2 * hw / faceW) * FACE_SPAN * s, (2 * hh / faceW) * FACE_SPAN * s],
      };
    };
    insets.eyeR.userData.v = eye(LM.rEyeOuter, LM.rEyeInner, LM.rBrowTop, 'eR');
    insets.eyeL.userData.v = eye(LM.lEyeOuter, LM.lEyeInner, LM.lBrowTop, 'eL');

    {
      const a = P2(LM.mouthL), b = P2(LM.mouthR);
      const w = a.distanceTo(b);
      const top = P2(LM.lipTop), bot = P2(LM.lipBot);
      const c = new THREE.Vector2((a.x + b.x) / 2, (top.y + bot.y) / 2);
      c.x = (c.x + (top.x + bot.x) / 2) / 2;
      const open = top.distanceTo(bot);
      const halfW = w * 0.72, halfH = Math.max(w * 0.42, open * 0.85);
      const f = toFace(c);
      const s = CFG.mouth;
      const cx = smooth('mcx', c.x, t, 1.6, 0.03), cy = smooth('mcy', c.y, t, 1.6, 0.03);
      const hw = smooth('mhw', halfW, t, 0.6, 0.003), hh = smooth('mhh', halfH, t, 3.0, 0.05);
      insets.mouth.userData.v = {
        crop: [cx, cy, hw, hh],
        center: [FACE_REF.x + smooth('mfx', f.x, t, 0.6, 0.5) * FACE_SPAN, FACE_REF.y - smooth('mfy', f.y, t, 0.6, 0.5) * FACE_SPAN + CFG.mouthLift],
        size: [(2 * hw / faceW) * FACE_SPAN * s, (2 * hh / faceW) * FACE_SPAN * s],
      };
    }
    const sRoll = smooth('roll', roll, t, 1.2, 0.5);
    for (const m of Object.values(insets)) m.userData.roll = sRoll;

    const jaw = blend?.categories?.find((c) => c.categoryName === 'jawOpen')?.score ?? 0;
    target.jaw = smooth('jaw', jaw, t, 4.0, 2.0);
    target.seen = t;
  }

  function applyInsets(t) {
    const visible = t - target.seen < 350;
    for (const m of Object.values(insets)) {
      const u = m.material.uniforms;
      u.uOpacity.value += ((visible && m.userData.v ? 1 : 0) - u.uOpacity.value) * 0.25;
      u.uMirror.value = CFG.mirror ? 1 : 0;
      u.uVideo.value.set(videoEl.videoWidth || 720, videoEl.videoHeight || 1280);
      const v = m.userData.v;
      if (!v) continue;
      u.uCropC.value.set(v.crop[0], v.crop[1]);
      u.uCropH.value.set(v.crop[2], v.crop[3]);
      u.uAngle.value = m.userData.roll || 0;
      u.uCenter.value.set(v.center[0], v.center[1]);
      u.uSize.value.set(v.size[0], v.size[1]);
    }
  }

  // ---- tracker: local copy first (works offline), then CDNs
  let landmarker = null;
  async function startTracker() {
    const bases = mpBase ? [mpBase] : [
      new URL('./vendor/mediapipe', location.href).href,
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`,
      `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}`,
    ];
    let lastErr;
    for (const base of bases) {
      try {
        const { FaceLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: new URL('./face_landmarker.task', location.href).href, delegate },
          runningMode: 'VIDEO', numFaces: 1,
          outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
          minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); status.tracker = 'GPU'; }
        catch (e) { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); status.tracker = 'CPU (' + String(e.message || e).slice(0, 40) + ')'; }
        status.trackerSrc = new URL(base).host === location.host ? 'local' : new URL(base).host;
        onChange();
        return;
      } catch (e) { lastErr = e; }
    }
    status.tracker = 'failed';
    throw lastErr || new Error('no tracker source reachable');
  }

  // ---- per frame
  let lastVideoTime = -1;
  const curQuat = new THREE.Quaternion();
  const IDENT = new THREE.Quaternion();
  function update(now, dt, draw = true) {
    if (landmarker && videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;
      status.camFrames++;
      const t0 = performance.now();
      try {
        if (snapshotFrame()) {
          const res = landmarker.detectForVideo(snap, now);
          status.det = performance.now() - t0;
          status.face = !!res.faceLandmarks?.length;
          if (status.face) onFace(res.faceLandmarks[0], res.faceBlendshapes?.[0], now);
        }
      } catch (e) { status.err = 'detect: ' + e.message; }
    } else if (!landmarker && videoEl.readyState >= 2) {
      snapshotFrame();
    }
    if (!draw) return;

    const tracking = now - target.seen < 500;
    const goal = tracking ? target.quat : IDENT;
    const follow = 1 - Math.exp(-dt * (16 - 10 * Math.min(1, Math.max(0, CFG.smooth))));
    curQuat.slerp(goal, tracking ? follow : 1 - Math.exp(-dt * 2));
    rig.quaternion.copy(curQuat);
    const px = tracking ? target.pos.x * CFG.sway * 0.6 : 0, py = tracking ? target.pos.y * CFG.sway * 0.45 : 0;
    rig.position.x += (px - rig.position.x) * follow;
    rig.position.y += (py - rig.position.y) * follow;
    const jaw = tracking ? target.jaw : 0;
    const sy = 1 + 0.035 * jaw * CFG.bounce, sxz = 1 - 0.015 * jaw * CFG.bounce;
    bob.scale.set(sxz + (bob.scale.x - sxz) * 0.5, sy + (bob.scale.y - sy) * 0.5, sxz + (bob.scale.z - sxz) * 0.5);

    applyInsets(now);
    renderer.render(scene, camera);
  }

  function straighten() {
    if (performance.now() - lastRawT > 1000) return false;
    neutralInv.copy(lastRawQuat).invert();
    store.set('nippon.neutral', neutralInv.toArray());
    return true;
  }

  applyLook();
  return {
    canvas, status, setSize, update, applyLook, straighten, startTracker,
    resetFilters: () => filters.clear(),
    get landmarker() { return landmarker; },
    _internals: { onFace, insets, renderer, scene, camera, rig },
  };
}
