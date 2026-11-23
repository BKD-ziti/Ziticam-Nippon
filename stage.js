// The stage: pages, backdrop and ziti drawn together on one GPU canvas.
// One pass per frame and no copying between canvases, so the ziti can move and resize at full frame rate.

import * as THREE from 'three';

const bdVert = /* glsl */`
  uniform vec2 uQuad;
  varying vec2 vP;
  void main() {
    vP = position.xy * uQuad;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const bdFrag = /* glsl */`
  uniform vec3 uColor; uniform float uMode; uniform vec2 uHalf; uniform float uCorner;
  uniform vec2 uCircle; uniform float uRadius; uniform float uBlur; uniform float uDrop;
  varying vec2 vP;
  float sdShape(vec2 p) {
    if (uMode < 0.5) return length(p - uCircle) - uRadius;
    vec2 q = abs(p) - (uHalf - vec2(uCorner));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uCorner;
  }
  void main() {
    float fill = 1.0 - smoothstep(-1.0, 1.0, sdShape(vP));
    float sh = 0.35 * (1.0 - smoothstep(-uBlur, uBlur, sdShape(vP - vec2(0.0, uDrop))));
    float a = fill + sh * (1.0 - fill);
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * fill / max(a, 1e-4), a);
    #include <colorspace_fragment>
  }`;

const zVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// the ziti image is premultiplied linear color; encode for the screen without darkening its soft edges
const zFrag = /* glsl */`
  uniform sampler2D uMap; uniform vec2 uUv;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv * uUv);
    if (c.a < 0.003) discard;
    gl_FragColor = vec4(c.rgb / c.a, c.a);
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;
  }`;

export function createStage(canvas) {
  // No anti-aliasing on the full frame: pages are straight-edged rectangles, and smoothing every pixel of a
  // 4K frame 60 times a second is most of the graphics work. Only the ziti, which has curves, gets it (below).
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;   // the noodle applies its own (see ziti.js)
  renderer.autoClear = false;
  const maxTex = renderer.capabilities.maxTextureSize;
  const aniso = renderer.capabilities.getMaxAnisotropy();

  let W = 1080, H = 1920;
  // y runs down the screen, like the 2D canvas it replaces
  const cam = new THREE.OrthographicCamera(0, W, 0, H, -10, 10);
  const scene = new THREE.Scene();
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;

  const pageMat = () => new THREE.MeshBasicMaterial({ map: blank, toneMapped: false, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
  const quad = new THREE.PlaneGeometry(1, 1);
  const pages = [new THREE.Mesh(quad, pageMat()), new THREE.Mesh(quad, pageMat())];
  const empty = new THREE.Mesh(quad, pageMat());
  for (const m of [...pages, empty]) { m.frustumCulled = false; m.visible = false; scene.add(m); }

  const bdMat = new THREE.ShaderMaterial({
    uniforms: {
      uQuad: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color() }, uMode: { value: 0 },
      uHalf: { value: new THREE.Vector2() }, uCorner: { value: 0 }, uCircle: { value: new THREE.Vector2() },
      uRadius: { value: 0 }, uBlur: { value: 0 }, uDrop: { value: 0 },
    },
    vertexShader: bdVert, fragmentShader: bdFrag,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const backdrop = new THREE.Mesh(quad, bdMat);
  backdrop.frustumCulled = false; backdrop.renderOrder = 5; backdrop.visible = false;
  scene.add(backdrop);

  // ---- the ziti's own image: 4x anti-aliased, sized to the ziti box (capped), stored as sRGB for precision.
  // It's kept between frames, so moving the box never redraws the noodle, and at 60 fps it can be redrawn every other frame.
  let zMax = 1080, zScale = 1, zRT = null, zLast = '';
  function zitiTarget(w, h) {
    // grow in 64 px steps and only shrink when much too big, so pinching the ziti rarely reallocates
    const fits = zRT && zRT.width >= w && zRT.height >= h && zRT.width * zRT.height <= 2.2 * w * h;
    if (fits) return zRT;
    zRT?.dispose();
    zRT = new THREE.WebGLRenderTarget(Math.ceil(w / 64) * 64, Math.ceil(h / 64) * 64, { samples: 4, depthBuffer: true, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    zRT.texture.colorSpace = THREE.SRGBColorSpace;
    zQuad.material.uniforms.uMap.value = zRT.texture;
    zLast = '';
    return zRT;
  }
  const zQuad = new THREE.Mesh(quad, new THREE.ShaderMaterial({
    uniforms: { uMap: { value: null }, uUv: { value: new THREE.Vector2(1, 1) } },
    vertexShader: zVert, fragmentShader: zFrag,
    transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  }));
  zQuad.frustumCulled = false; zQuad.renderOrder = 10; zQuad.visible = false;
  scene.add(zQuad);
  const clear0 = new THREE.Color(0, 0, 0);

  // ---- page textures: uploaded once per page, mipmapped so screentones don't shimmer when scaled down
  const texCache = new Map();
  function texFor(img) {
    let t = texCache.get(img);
    if (t) return t;
    let src = img.src;
    if (img.w > maxTex || img.h > maxTex) {
      const k = maxTex / Math.max(img.w, img.h);
      const c = document.createElement('canvas');
      c.width = Math.floor(img.w * k); c.height = Math.floor(img.h * k);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, c.width, c.height);
      src = c;
    }
    t = new THREE.Texture(src);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    t.needsUpdate = true;
    texCache.set(img, t);
    return t;
  }
  // upload now, while nothing is moving, so a page turn never waits on it
  function prewarm(img) { if (img) renderer.initTexture(texFor(img)); }
  function prune(keep) {
    for (const [k, t] of texCache) if (!keep.has(k)) { t.dispose(); texCache.delete(k); }
  }

  // ---- empty state, drawn once into a texture
  let emptyKey = '', emptyTex = null;
  function emptyTexture(paper) {
    const key = `${W}x${H}:${paper.bg}`;
    if (key === emptyKey) return emptyTex;
    emptyKey = key;
    const c = document.createElement('canvas');
    c.width = Math.round(W / 2); c.height = Math.round(H / 2);
    const g = c.getContext('2d');
    const w = c.width, h = c.height, r = Math.min(w, h) * 0.16;
    g.fillStyle = paper.bg; g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.9; g.fillStyle = '#c8432b';
    g.beginPath(); g.arc(w / 2, h * 0.4, r, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1; g.fillStyle = paper.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${Math.round(r * 0.42)}px system-ui, sans-serif`;
    g.fillText('Open a manga to begin', w / 2, h * 0.4 + r * 1.6);
    emptyTex?.dispose();
    emptyTex = new THREE.CanvasTexture(c);
    emptyTex.colorSpace = THREE.SRGBColorSpace;
    return emptyTex;
  }

  function setSize(w, h) {
    W = w; H = h;
    renderer.setSize(W, H, false);
    cam.right = W; cam.bottom = H; cam.updateProjectionMatrix();
  }

  const bg = new THREE.Color();
  // frame: { paper: {bg, fg}, pages: [{img, x, y, w, h}], backdrop: {mode, color, rect} | null,
  //          ziti: { rect, draw(w, h), redraw: bool } | null }
  // returns true if the ziti was redrawn this frame
  function render(frame) {
    const z = frame.ziti;
    let drew = false;
    zQuad.visible = !!z;
    if (z) {
      const r = z.rect;
      const rh = Math.max(64, Math.min(Math.round(zMax * zScale), Math.round(r.h)));
      const rw = Math.max(48, Math.round(rh * r.w / r.h));
      const rt = zitiTarget(rw, rh);
      const key = `${rw}x${rh}`;
      if (z.redraw !== false || key !== zLast) {
        zLast = key;
        rt.viewport.set(0, 0, rw, rh);
        rt.scissor.set(0, 0, rw, rh);
        rt.scissorTest = true;   // clear only the part in use
        renderer.setRenderTarget(rt);
        renderer.setClearColor(clear0, 0);
        renderer.clear(true, true, false);
        z.draw(rw, rh);
        drew = true;
      }
      zQuad.material.uniforms.uUv.value.set(rw / rt.width, rh / rt.height);
      zQuad.position.set(r.x + r.w / 2, r.y + r.h / 2, 0);
      zQuad.scale.set(r.w, -r.h, 1);
    }
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, W, H);
    renderer.setClearColor(bg.set(frame.paper.bg), 1);
    renderer.clear(true, true, false);

    empty.visible = !frame.pages.length;
    if (empty.visible) {
      const t = emptyTexture(frame.paper);
      if (empty.material.map !== t) { empty.material.map = t; }
      empty.position.set(W / 2, H / 2, 0); empty.scale.set(W, -H, 1);
    }
    pages.forEach((m, i) => {
      const p = frame.pages[i];
      m.visible = !!p;
      if (!p) return;
      m.material.map = texFor(p.img);
      m.position.set(p.x + p.w / 2, p.y + p.h / 2, 0);
      m.scale.set(p.w, -p.h, 1);   // negative: texture rows run top to bottom on this y-down stage
    });

    const b = frame.backdrop;
    backdrop.visible = !!b;
    if (b) {
      const r = b.rect, blur = r.w * 0.06, drop = r.w * 0.02, m = blur * 2 + drop;
      const u = bdMat.uniforms;
      backdrop.position.set(r.x + r.w / 2, r.y + r.h / 2, 0);
      backdrop.scale.set(r.w + 2 * m, r.h + 2 * m, 1);
      u.uQuad.value.set(r.w + 2 * m, r.h + 2 * m);
      u.uColor.value.set(b.color);
      u.uMode.value = b.mode === 'circle' ? 0 : 1;
      u.uHalf.value.set(r.w / 2, r.h / 2);
      u.uCorner.value = r.w * 0.09;
      u.uCircle.value.set(0, r.h * 0.02);
      u.uRadius.value = r.h * 0.42;
      u.uBlur.value = blur; u.uDrop.value = drop;
    }
    renderer.render(scene, cam);
    return drew;
  }

  return {
    renderer, setSize, render, prewarm, prune,
    // the sharpest the ziti is drawn; bigger boxes are scaled up from this
    setZitiMax(h) { zMax = Math.round(h / 4) * 4; },
    // the smoothness ladder trades a little ziti sharpness for frame rate on a busy device
    setZitiScale(s) { zScale = s; },
    get size() { return [W, H]; },
  };
}
