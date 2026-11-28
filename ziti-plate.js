// The plate the ziti climbs out of: a glazed plate with a gold rim, a heap of ziti in red sauce,
// basil and a little parmesan. Built in code at load (no extra download), from the same pasta and
// sauce materials as the hero noodle, so everything on the plate reads as one dish.
//
// The pasta isn't placed by hand: small ziti are dropped onto the plate one at a time, each coming to
// rest on whatever is already there (a height map keeps track), so they settle the way real pasta does:
// a low, loose layer, a little higher right around the hero. Then the sauce is poured over that exact layer.
// It's a base, not a mountain: the hero noodle pops up out of it.
//
// Coordinates: the hero noodle's rest space (glTF units, +Y up, +Z toward the camera). The plate's
// glaze surface sits at y = DISH.plateY; the hero comes up through the middle of the heap.

import * as THREE from 'three';

export const DISH = {
  plateY: -1.28,     // the top of the glaze in the middle of the plate
  plateR: 1.2,       // outer edge of the rim
  pileR: 0.98,       // how far the pasta spreads
  heroR: 0.535,      // the hero noodle's radius where it pops up through the pasta
  tilt: 0.14,        // the plate leans toward the camera a little, like a food photo, so you see into it
};
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---- small deterministic helpers: the same plate every time
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise2(x, y) {   // smooth value noise, 0..1
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export const fbm = (x, y) => 0.6 * noise2(x, y) + 0.3 * noise2(x * 2.1 + 5.2, y * 2.1 - 1.3) + 0.1 * noise2(x * 4.3 - 2.7, y * 4.3 + 7.1);

// ---- the plate: one lathe, glazed, with a thin gold line inside the rim
const PLATE_SCALE = 1.0;
const PLATE_PROFILE = [
  // [r, y, gold] from the middle of the glaze out over the rim and back under
  [0.0, 0.0], [0.5, 0.0], [0.68, 0.01], [0.8, 0.035], [0.88, 0.07], [0.94, 0.093], [1.0, 0.104],
  [1.075, 0.11], [1.086, 0.1102, 1], [1.104, 0.1098, 1], [1.115, 0.1092], [1.165, 0.104], [1.19, 0.093],
  [1.2, 0.075], [1.193, 0.058], [1.17, 0.05], [1.0, 0.036], [0.86, -0.006], [0.64, -0.048],
  [0.6, -0.062], [0.55, -0.062], [0.52, -0.05], [0.0, -0.035],
].map(([r, y, g]) => [r * PLATE_SCALE, y, g]);
export function plateSurfaceY(r) {   // the glaze height at radius r (top side), above plateY
  for (let i = 1; i < 12; i++) {
    const [r0, y0] = PLATE_PROFILE[i - 1], [r1, y1] = PLATE_PROFILE[i];
    if (r <= r1) return y0 + (y1 - y0) * (r - r0) / Math.max(1e-6, r1 - r0);
  }
  return 0.11;
}
function buildPlate(prepare) {
  const pts = PLATE_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(pts, 128);
  const col = new Float32Array(geo.attributes.position.count * 3);
  const glaze = new THREE.Color('#efe9df'), gold = new THREE.Color('#d9a441');
  const n = PLATE_PROFILE.length;
  const pos = geo.attributes.position, c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(PLATE_PROFILE[i % n][2] ? gold : glaze);
    if (pos.getY(i) > 0.02 || Math.hypot(pos.getX(i), pos.getZ(i)) < 0.9) c.multiplyScalar(shadeAt(pos.getX(i), pos.getY(i), pos.getZ(i)));   // the pasta's shadow on the glaze
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // glazed: a low roughness gives the shine; no clearcoat, which costs a second highlight on every pixel of the plate
  const mat = new THREE.MeshStandardMaterial({ name: 'Plate', vertexColors: true, roughness: 0.12, envMapIntensity: 0.9, side: THREE.DoubleSide });
  prepare(mat);
  addHeroShadow(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Plate';
  return mesh;
}

// ---- one small ziti: a tube with softened cut ends, slightly irregular like the hero
const COAT = new THREE.Color('#d9472f');
function buildZitiTube() {
  const R = 0.5, r = 0.41, L = 1.55, SEG = 28;
  const pos = [], nrm = [], uv = [], idx = [], col = [];
  const cc = new THREE.Color();
  // tossed in sauce: smears of it around the tube (every noodle is turned differently, so no two look alike)
  const coat = (a, y, k) => { const n = fbm(Math.cos(a) * 1.4 + y * 1.6 + 3, Math.sin(a) * 1.4 - y * 1.2 + 1); cc.setRGB(1, 1, 1).lerp(COAT, k * 0.8 * clamp((n - 0.5) / 0.1, 0, 1)); col.push(cc.r, cc.g, cc.b); };
  const wob = (a, y) => 1 + 0.035 * (noise2(Math.cos(a) * 1.7 + 3, y * 2.2) - 0.5) + 0.025 * (noise2(Math.sin(a) * 2.3, y * 1.3 + 9) - 0.5);
  // outer and inner walls as rings along the length; the last rings at each end tuck in to round the edge
  const rows = [-L / 2, -L / 2 + 0.02, -L / 2 + 0.06, -0.45, -0.15, 0.15, 0.45, L / 2 - 0.06, L / 2 - 0.02, L / 2];
  const tuck = (i) => (i === 0 || i === rows.length - 1 ? 0.955 : i === 1 || i === rows.length - 2 ? 0.99 : 1);
  function wall(rad, out, v0, v1) {
    const base = pos.length / 3;
    rows.forEach((y, i) => {
      for (let j = 0; j <= SEG; j++) {
        const a = (j / SEG) * TAU;
        const k = wob(a, y) * (out ? tuck(i) : 2 - tuck(i));
        pos.push(Math.cos(a) * rad * k, y, Math.sin(a) * rad * k);
        const s = out ? 1 : -1;
        const ny = i === 0 ? -0.6 : i === rows.length - 1 ? 0.6 : i === 1 ? -0.15 : i === rows.length - 2 ? 0.15 : 0;
        const l = Math.hypot(1, ny);
        nrm.push(s * Math.cos(a) / l, ny / l, s * Math.sin(a) / l);
        uv.push(j / SEG, v0 + (v1 - v0) * (y + L / 2) / L);
        coat(a, y, out ? 1 : 0.5);
      }
    });
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < SEG; j++) {
        const a = base + i * (SEG + 1) + j, b = a + SEG + 1;
        if (out) idx.push(a, b, a + 1, b, b + 1, a + 1); else idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  wall(R, true, 0.56, 0.96);
  wall(r, false, 0.06, 0.46);
  // the cut ends: flat rings between the walls
  for (const end of [-1, 1]) {
    const y = end * L / 2, base = pos.length / 3;
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * TAU;
      const ko = wob(a, y) * 0.955, ki = wob(a, y) * 1.045;
      pos.push(Math.cos(a) * R * ko, y, Math.sin(a) * R * ko, Math.cos(a) * r * ki, y, Math.sin(a) * r * ki);
      nrm.push(0, end, 0, 0, end, 0);
      uv.push(j / SEG, 0.62, j / SEG, 0.64);
      coat(a, y, 1); coat(a, y, 0.5);
    }
    for (let j = 0; j < SEG; j++) {
      const a = base + j * 2, b = a + 2;
      if (end > 0) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// ---- the heap: drop ziti one by one onto a height map of the plate
const G = 112, EXT = 1.3, CELL = (2 * EXT) / G;
function sampler(map) {
  return (x, z) => {
    const fx = clamp((x + EXT) / CELL - 0.5, 0, G - 1.001), fz = clamp((z + EXT) / CELL - 0.5, 0, G - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = map[j * G + i], b = map[j * G + i + 1], c = map[(j + 1) * G + i], d = map[(j + 1) * G + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function simulateHeap() {
  const rand = rng(20251128);
  const hm = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = -EXT + (i + 0.5) * CELL, z = -EXT + (j + 0.5) * CELL;
    hm[j * G + i] = plateSurfaceY(Math.hypot(x, z));
  }
  const at = sampler(hm);
  const H = DISH.heroR;
  const along = (cx, cz, ux, uz, len, rad, t0, t1) => {
    let m = -1;
    for (let a = 0; a <= 6; a++) {
      const t = t0 + (t1 - t0) * a / 6, px = cx + ux * t * len, pz = cz + uz * t * len;
      for (const o of [-0.75, 0, 0.75]) m = Math.max(m, at(px - uz * o * rad, pz + ux * o * rad));
    }
    return m;
  };
  const stamp = (cx, cz, yc, ux, uz, len, rad, slope) => {
    const reach = len / 2 + rad;
    const i0 = Math.max(0, Math.floor((cx - reach + EXT) / CELL)), i1 = Math.min(G - 1, Math.ceil((cx + reach + EXT) / CELL));
    const j0 = Math.max(0, Math.floor((cz - reach + EXT) / CELL)), j1 = Math.min(G - 1, Math.ceil((cz + reach + EXT) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = -EXT + (i + 0.5) * CELL - cx, dz = -EXT + (j + 0.5) * CELL - cz;
      const t = clamp(dx * ux + dz * uz, -len / 2, len / 2);
      const d = Math.hypot(dx - ux * t, dz - uz * t);
      if (d >= rad) continue;
      const h = yc + t * slope + Math.sqrt(rad * rad - d * d);
      if (h > hm[j * G + i]) hm[j * G + i] = h;
    }
  };

  const pieces = [];
  const Y = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), spin = new THREE.Quaternion();
  const add = (pos, d, s, warm) => {
    const q = new THREE.Quaternion().setFromUnitVectors(Y, d).multiply(spin.setFromAxisAngle(Y, rand() * TAU));
    pieces.push({ m: new THREE.Matrix4().compose(pos, q, new THREE.Vector3(s, s, s)), pos: pos.clone(), rad: 0.5 * s, warm });
  };

  // the heap's outline: tallest against the hero, tapering to a thin layer at the edge
  const envelope = (r) => { const u = clamp((r - H) / (DISH.pileR - H), 0, 1); return plateSurfaceY(r) + 0.2 + 0.14 * (1 - Math.pow(u, 0.8)); };
  // lying down: most of the heap
  for (let k = 0, tries = 0; k < 150 && tries < 45000; tries++) {
    const s = 0.21 + rand() * 0.06, rad = 0.5 * s, len = 1.55 * s;
    const r0 = H + rad * 0.9, r1 = DISH.pileR - rad;
    const r = Math.sqrt(r0 * r0 + rand() * (r1 * r1 - r0 * r0));
    const th = rand() * TAU;
    const cx = Math.cos(th) * r, cz = Math.sin(th) * r;
    const yaw = r < H + 0.28 ? th + Math.PI / 2 + (rand() - 0.5) * 1.0 : rand() * TAU;
    const ux = Math.cos(yaw), uz = Math.sin(yaw);
    if (Math.hypot(cx - ux * len / 2, cz - uz * len / 2) > DISH.pileR || Math.hypot(cx + ux * len / 2, cz + uz * len / 2) > DISH.pileR) continue;
    const tc = clamp(-(cx * ux + cz * uz), -len / 2, len / 2);
    if (Math.hypot(cx + ux * tc, cz + uz * tc) < H + rad * 0.95) continue;   // clear of the hero
    const h1 = along(cx, cz, ux, uz, len, rad, -0.5, -0.05), h2 = along(cx, cz, ux, uz, len, rad, 0.05, 0.5);
    const slope = clamp((h2 - h1) / (len * 0.55), -0.85, 0.85);
    const yc = (h1 + h2) / 2 + rad * 0.78;   // settles in a little, the way cooked pasta does
    if (yc + rad > envelope(r) + 0.07) continue;   // keep the heap's shape
    stamp(cx, cz, yc, ux, uz, len, rad, slope);
    add(new THREE.Vector3(cx, DISH.plateY + yc, cz), dir.set(ux, slope, uz).normalize(), s, rand());
    k++;
  }
  // a few standing up: leaning on the hero, or poking out of the heap
  for (let k = 0; k < 7; k++) {
    const s = 0.22 + rand() * 0.05, rad = 0.5 * s, len = 1.55 * s;
    const p = 0.8 + rand() * 0.4, inward = k < 4;
    const th = rand() * TAU + k;
    const r = inward ? H + rad + Math.cos(p) * len * 0.82 + 0.015 : H + 0.22 + rand() * 0.2;
    const bx = Math.cos(th) * r, bz = Math.sin(th) * r;
    const sgn = inward ? -1 : 1, side = (rand() - 0.5) * 0.5;
    dir.set(sgn * Math.cos(th + side) * Math.cos(p), Math.sin(p), sgn * Math.sin(th + side) * Math.cos(p)).normalize();
    const base = new THREE.Vector3(bx, DISH.plateY + at(bx, bz) - rad * 0.4, bz);
    const pos = base.clone().addScaledVector(dir, len * 0.32);
    add(pos, dir.clone(), s, rand());
  }

  // a soft version of the heap for the sauce to settle on
  const soft = new Float32Array(G * G), tmp = new Float32Array(G * G);
  const K = [0.06, 0.12, 0.18, 0.28, 0.18, 0.12, 0.06];
  for (let pass = 0; pass < 4; pass++) {   // blurred twice over: sauce settles into a smooth surface, not folds
    const srcMap = pass === 0 ? hm : pass % 2 ? tmp : soft, dst = pass % 2 ? soft : tmp;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      let acc = 0;
      for (let k = -3; k <= 3; k++) {
        const ii = pass % 2 === 0 ? clamp(i + k, 0, G - 1) : i, jj = pass % 2 === 0 ? j : clamp(j + k, 0, G - 1);
        acc += srcMap[jj * G + ii] * K[k + 3];
      }
      dst[j * G + i] = acc;
    }
  }
  const hard = sampler(hm), smooth = sampler(soft);
  // shade each noodle by how buried it is: the ones underneath sit in shadow
  for (const pc of pieces) {
    const top = pc.pos.y - DISH.plateY + pc.rad;
    const over = Math.max(0, hard(pc.pos.x, pc.pos.z) - top);
    pc.tone = (1 - 0.55 * clamp(over / 0.2, 0, 1)) * (0.82 + 0.18 * clamp(top / 0.55, 0, 1));
  }
  let ring = 0;
  for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU; ring += smooth(Math.cos(a) * (H + 0.06), Math.sin(a) * (H + 0.06)); }
  return { pieces, hard, smooth, heroBase: ring / 24 };
}
const HEAP = simulateHeap();
// where the hero noodle comes out of the heap (height above the plate glaze, averaged around it)
export const HERO_BASE_Y = DISH.plateY + HEAP.heroBase;
const sauceAt = (x, z) => HEAP.smooth(x, z) - 0.09 + 0.04 * (fbm(x * 3.4 + 11, z * 3.4 - 7) - 0.5) + 0.022 * (fbm(x * 10 - 3, z * 10 + 5) - 0.5);
const SAUCE_R = DISH.pileR * 1.04;
const sauceEdge = (a) => SAUCE_R * (0.9 + 0.15 * fbm(Math.cos(a) * 1.8 + 4, Math.sin(a) * 1.8 + 4));
// the sauce's top at (x, z): settled into the heap, thick around the hero, a thin smear at its edge
function blanketY(x, z) {
  const r = Math.hypot(x, z), H = DISH.heroR;
  const edge = sauceEdge(Math.atan2(z, x));
  const f = clamp((r - H * 0.9) / (edge - H * 0.9), 0, 1);
  const base = plateSurfaceY(r) + 0.012;
  if (r > edge) return -1;
  const collar = 0.05 * Math.exp(-(((r - H) / 0.07) ** 2));
  return Math.max(base, base + (sauceAt(x, z) - base) * (1 - f ** 4) + collar);
}
const surfaceAt = (x, z) => Math.max(HEAP.hard(x, z), blanketY(x, z));

// ---- light and shade, baked once. Nothing on the plate moves relative to the key light, so its shadows are
// worked out here from the height map instead of being re-drawn by the GPU every frame (that was half the
// cost of a frame). Only the hero noodle moves; its shadow is the cheap live one below.
const KEY_DIR = new THREE.Vector3(-2.2, 3.2, 4.0).normalize()                 // toward the key light (the apps' light rig)
  .applyAxisAngle(new THREE.Vector3(1, 0, 0), -DISH.tilt);                   // as seen from the tilted plate
// how much key light reaches (x, y, z) (y above the glaze): a soft shadow marched over the height map
function litAt(x, y, z) {
  let res = 1, t = 0.04;
  for (let i = 0; i < 48 && t < 1.8; i++) {
    const h = HEAP.hard(x + KEY_DIR.x * t, z + KEY_DIR.z * t);
    res = Math.min(res, 7 * (y + 0.012 + KEY_DIR.y * t - h) / t);
    if (res <= 0) return 0;
    t += 0.02 + t * 0.07;
  }
  return clamp(res, 0, 1);
}
// how tucked in (x, y, z) is: the more pasta around and above it, the less light gets in
function openAt(x, y, z) {
  let occ = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    for (const d of [0.07, 0.15, 0.27]) occ += clamp((HEAP.hard(x + Math.cos(a) * d, z + Math.sin(a) * d) - y) / (d * 1.6), 0, 1);
  }
  return 1 - 0.42 * clamp(occ / 24 * 1.6, 0, 1);
}
const shadeAt = (x, y, z) => (0.6 + 0.4 * litAt(x, y, z)) * openAt(x, y, z);

// ---- the hero's shadow: a soft capsule worked out per pixel from where the noodle is right now (a few dot
// products, no shadow map). The rig fills these in every frame.
export const HERO_SHADOW = {
  uZitiA: { value: new THREE.Vector3(0, -1, 0) },   // where the noodle leaves the pasta (world)
  uZitiB: { value: new THREE.Vector3(0, 1, 0) },    // the top of its head (world)
  uZitiR: { value: 0.53 },                          // its radius
  uZitiL: { value: new THREE.Vector3(-2.2, 3.2, 4.0).normalize() },   // toward the key light (world)
  uZitiK: { value: 0.4 },                           // how dark
};
const HERO_SHADOW_GLSL = /* glsl */`
uniform vec3 uZitiA; uniform vec3 uZitiB; uniform float uZitiR; uniform vec3 uZitiL; uniform float uZitiK;
varying vec3 vZitiWorld;
float zitiHeroShadow( vec3 p ) {
  vec3 a = uZitiA - p, b = uZitiB - p;
  vec3 a2 = a - dot( a, uZitiL ) * uZitiL, b2 = b - dot( b, uZitiL ) * uZitiL;   // looking down the light ray from p
  vec3 ab = b2 - a2;
  float t = clamp( -dot( a2, ab ) / max( dot( ab, ab ), 1e-5 ), 0.0, 1.0 );
  float d = length( a2 + ab * t );
  float toward = step( 0.0, dot( mix( a, b, t ), uZitiL ) );                       // the noodle is between p and the light
  return 1.0 - uZitiK * toward * ( 1.0 - smoothstep( uZitiR * 0.55, uZitiR * 1.6, d ) );
}
`;
// add the hero's shadow to a material, on top of whatever the app's prepare() already did
export function addHeroShadow(m) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, HERO_SHADOW);
    sh.vertexShader = 'varying vec3 vZitiWorld;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      { vec4 zw = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        zw = instanceMatrix * zw;
      #endif
        vZitiWorld = ( modelMatrix * zw ).xyz; }`);
    sh.fragmentShader = HERO_SHADOW_GLSL + sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.rgb *= zitiHeroShadow( vZitiWorld );');
  };
  m.customProgramCacheKey = () => prevKey.call(m) + '+hero-shadow';
  m.needsUpdate = true;
  return m;
}


// ---- sauce over the heap: a lumpy blanket settled into the gaps, thick around the hero, thin at the edge
function buildSauceBlanket() {
  const RINGS = 34, SEGS = 112, R = SAUCE_R, H = DISH.heroR;
  const pos = [], uv = [], idx = [], col = [];
  for (let i = 0; i <= RINGS; i++) {
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * TAU;
      const edge = sauceEdge(a) * 0.9999;
      const r = H * 0.9 + (edge - H * 0.9) * (i / RINGS);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = blanketY(x, z);
      pos.push(x, DISH.plateY + y, z);
      uv.push(0.185 + (x / R) * 0.155, 0.82 + (z / R) * 0.155);   // the round sauce patch in the sauce texture
      const k = shadeAt(x, y, z);
      col.push(k, k, k);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j, b = a + SEGS + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- a basil leaf: pointed, cupped along its spine, glossy; the spine and veins a little lighter
function buildLeafGeometry() {
  const NS = 16, NT = 10, L = 1, W = 0.3;
  const pos = [], col = [], idx = [];
  const dark = new THREE.Color('#174a1c'), mid = new THREE.Color('#2a6e2c'), light = new THREE.Color('#5f9e45');
  const c = new THREE.Color();
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    const w = W * Math.pow(Math.sin(Math.PI * Math.pow(s, 0.7)), 0.8) + 0.01;
    for (let k = 0; k <= NT; k++) {
      const t = (k / NT) * 2 - 1;
      const x = t * w, zl = s * L;
      const y = 0.55 * w * t * t + 0.12 * Math.sin(Math.PI * s) - 0.08 * s * s + 0.02 * Math.sin(t * 9 + s * 5) * w;
      pos.push(x, y, zl);
      const spine = Math.pow(1 - Math.abs(t), 14);
      const vein = Math.pow(Math.max(0, Math.cos((s * 6 - Math.abs(t) * 1.8) * Math.PI)), 30) * (1 - Math.abs(t)) * 0.35;
      c.copy(dark).lerp(mid, 0.35 + 0.5 * (1 - Math.abs(t)) * Math.sin(Math.PI * s)).lerp(light, Math.min(1, spine * 0.7 + vein));
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NS; i++) for (let k = 0; k < NT; k++) {
    const a = i * (NT + 1) + k, b = a + NT + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// build the whole dish. pasta / sauce: the hero's own materials. prepare(material): the app's finishing touch
// (its tone curve). Returns the group (in the hero's rest space), the tilted space everything sits in, and an
// outline for bounds.
export function buildDish({ pasta, sauce, prepare = () => {} }) {
  const group = new THREE.Group();
  group.name = 'Dish';
  // lean the plate toward the camera about the heap's middle, so you see into it
  const pivot = new THREE.Group();
  pivot.position.y = HERO_BASE_Y;
  pivot.rotation.x = DISH.tilt;
  group.add(pivot);
  const tilted = new THREE.Group();
  tilted.position.y = -HERO_BASE_Y;
  pivot.add(tilted);

  const plate = buildPlate(prepare);
  plate.position.y = DISH.plateY;
  tilted.add(plate);

  // the heap
  const pileMat = pasta.clone();
  pileMat.name = 'PilePasta';
  pileMat.color = new THREE.Color(1, 1, 1);
  pileMat.side = THREE.DoubleSide;
  pileMat.envMapIntensity = 0.75;
  pileMat.vertexColors = true;
  prepare(pileMat);
  // skip the ones buried under the sauce: nobody sees them, so the phone doesn't draw them
  const shows = (p) => {
    const top = p.pos.y - DISH.plateY + p.rad + 0.02;
    for (const [dx, dz] of [[0, 0], [p.rad * 2, 0], [-p.rad * 2, 0], [0, p.rad * 2], [0, -p.rad * 2]]) if (top > blanketY(p.pos.x + dx, p.pos.z + dz)) return true;
    return false;
  };
  const all = HEAP.pieces.filter(shows);
  const pile = new THREE.InstancedMesh(buildZitiTube(), pileMat, all.length);
  pile.name = 'Pile';
  const c = new THREE.Color();
  all.forEach((p, i) => {
    pile.setMatrixAt(i, p.m);
    const lit = shadeAt(p.pos.x, p.pos.y - DISH.plateY + p.rad * 0.9, p.pos.z);
    c.setRGB(1, 0.96 - 0.05 * p.warm, 0.88 - 0.1 * p.warm).multiplyScalar(p.tone * (0.45 + 0.55 * lit));
    pile.setColorAt(i, c);
  });
  addHeroShadow(pileMat);
  tilted.add(pile);

  // sauce
  const sauceMat = sauce.clone();
  sauceMat.name = 'PileSauce';
  sauceMat.side = THREE.DoubleSide;
  sauceMat.color = new THREE.Color(0.8, 0.74, 0.72);   // deeper than the drips on the head: it's been simmered
  sauceMat.roughness = 0.3;
  sauceMat.vertexColors = true;
  if ('clearcoat' in sauceMat) sauceMat.clearcoat = 0;   // a second highlight over this much sauce isn't worth its cost
  prepare(sauceMat);
  addHeroShadow(sauceMat);
  const blanket = new THREE.Mesh(buildSauceBlanket(), sauceMat);
  blanket.name = 'SauceBlanket';
  tilted.add(blanket);
  const rand = rng(77);

  // tomato pieces and herbs in the sauce
  const chunkGeo = new THREE.IcosahedronGeometry(1, 2);
  {
    const p = chunkGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 0.75 + 0.5 * noise2(p.getX(i) * 2.3 + 5, p.getY(i) * 2.3 + p.getZ(i) * 1.7);
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k);
    }
    chunkGeo.computeVertexNormals();
  }
  const chunkMat = new THREE.MeshStandardMaterial({ name: 'Tomato', color: '#ffffff', roughness: 0.32 });
  prepare(chunkMat); addHeroShadow(chunkMat);
  const herbMat = new THREE.MeshStandardMaterial({ name: 'Herbs', color: '#ffffff', roughness: 0.6 });
  prepare(herbMat); addHeroShadow(herbMat);
  const CHUNKS = 24, HERBS = 190;
  const chunks = new THREE.InstancedMesh(chunkGeo, chunkMat, CHUNKS);
  const herbs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), herbMat, HERBS);
  chunks.name = 'Tomato'; herbs.name = 'Herbs';
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const red = new THREE.Color('#a8221a'), bright = new THREE.Color('#d8452c'), herb = new THREE.Color('#2b5a22'), herb2 = new THREE.Color('#47782f');
    let n = 0;
    for (let tries = 0; n < CHUNKS && tries < 2000; tries++) {
      const th = rand() * TAU, r = DISH.heroR + 0.05 + Math.sqrt(rand()) * (DISH.pileR * 0.78 - DISH.heroR);
      const x = Math.cos(th) * r, z = Math.sin(th) * r, y = blanketY(x, z);
      if (y < 0 || HEAP.hard(x, z) > y + 0.01) continue;   // only where the sauce is on top
      const s = 0.018 + rand() * 0.02;
      chunks.setMatrixAt(n, m.compose(p.set(x, DISH.plateY + y + s * 0.15, z), q.setFromEuler(e.set(rand() * 3, rand() * 6, rand() * 3)), sc.set(s, s, s)));
      chunks.setColorAt(n, c.copy(red).lerp(bright, rand() * 0.6).multiplyScalar(shadeAt(x, y, z)));
      n++;
    }
    chunks.count = n;
    for (let i = 0; i < HERBS; i++) {
      const th = rand() * TAU, r = DISH.heroR + 0.02 + Math.sqrt(rand()) * (DISH.pileR * 1.0 - DISH.heroR);
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      const s = 0.006 + rand() * 0.009;
      const hy = surfaceAt(x, z);
      herbs.setMatrixAt(i, m.compose(p.set(x, DISH.plateY + hy + 0.004, z), q.setFromEuler(e.set((rand() - 0.5) * 0.6, rand() * 6, (rand() - 0.5) * 0.6)), sc.set(s * 1.6, s * 0.25, s)));
      herbs.setColorAt(i, c.copy(herb).lerp(herb2, rand()).multiplyScalar(shadeAt(x, hy, z)));
    }
  }
  tilted.add(chunks, herbs);

  // basil, resting on the heap
  const leafMat = new THREE.MeshStandardMaterial({ name: 'Basil', vertexColors: true, roughness: 0.3, side: THREE.DoubleSide, envMapIntensity: 0.9 });
  const leafGeo = buildLeafGeometry();
  const LEAVES = [   // [angle around the heap, distance out, size, heading, droop]
    [0.55, 0.66, 0.42, 2.0, 0.25], [2.45, 0.68, 0.38, -0.9, 0.3], [-1.9, 0.72, 0.34, 0.4, 0.2], [1.35, 0.86, 0.3, 3.0, 0.1],
  ];
  for (const [th, r, s, head, droop] of LEAVES) {
    const x0 = Math.cos(th) * r, z0 = Math.sin(th) * r;
    const lm = leafMat.clone();
    lm.color.setScalar(shadeAt(x0, surfaceAt(x0, z0) + 0.02, z0));
    prepare(lm); addHeroShadow(lm);
    const leaf = new THREE.Mesh(leafGeo, lm);
    leaf.scale.setScalar(s);
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    // follow the slope of the heap where it lands
    const gx = (HEAP.smooth(x + 0.03, z) - HEAP.smooth(x - 0.03, z)) / 0.06, gz = (HEAP.smooth(x, z + 0.03) - HEAP.smooth(x, z - 0.03)) / 0.06;
    leaf.position.set(x, DISH.plateY + surfaceAt(x, z) + 0.012, z);
    leaf.rotation.set(clamp(Math.atan(gz) * 0.6, -0.3, 0.3) - droop * 0.3, head, clamp(-Math.atan(gx) * 0.6, -0.3, 0.3), 'YXZ');
    tilted.add(leaf);
  }

  // parmesan
  const flakeMat = new THREE.MeshStandardMaterial({ name: 'Parmesan', roughness: 0.7, color: '#ffffff' });
  prepare(flakeMat); addHeroShadow(flakeMat);
  const FLAKES = 170;
  const flakes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), flakeMat, FLAKES);
  flakes.name = 'Parmesan';
  const fm = new THREE.Matrix4(), fq = new THREE.Quaternion(), fe = new THREE.Euler(), fp = new THREE.Vector3(), fs = new THREE.Vector3();
  for (let i = 0; i < FLAKES; i++) {
    const th = rand() * TAU, r = DISH.heroR + 0.03 + Math.sqrt(rand()) * (DISH.pileR * 0.95 - DISH.heroR - 0.03);
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    const fy = surfaceAt(x, z);
    fp.set(x, DISH.plateY + fy + 0.006, z);
    const s = 0.01 + rand() * 0.018;
    fs.set(s * (1 + rand()), s * 0.35, s * (0.7 + rand() * 0.6));
    fq.setFromEuler(fe.set((rand() - 0.5) * 0.8, rand() * TAU, (rand() - 0.5) * 0.8));
    flakes.setMatrixAt(i, fm.compose(fp, fq, fs));
    flakes.setColorAt(i, c.set('#f3e7c6').multiplyScalar((0.88 + rand() * 0.14) * shadeAt(x, fy, z)));
  }
  tilted.add(flakes);

  // outline for bounds: the plate's rim and the top of the heap, in the tilted space
  const hull = [];
  const ringAt = (r, y) => { for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; hull.push(new THREE.Vector3(Math.cos(a) * r / Math.cos(Math.PI / 16), y, Math.sin(a) * r / Math.cos(Math.PI / 16))); } };
  ringAt(DISH.plateR * 1.02, DISH.plateY - 0.08);
  ringAt(DISH.plateR * 1.02, DISH.plateY + 0.13);
  ringAt(DISH.pileR, HERO_BASE_Y + 0.3);
  return { group, hull, space: tilted };
}
