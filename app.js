// ZitiCam Nippon: a manga reader with the live-face ziti on top, recorded as one video.
// Everything happens in the browser: pages, camera and takes never leave the device.
//
// URL options: ?debug=1  ?autostart=1  ?manga=<link>  ?mp=<MediaPipe base url>  ?notrack=1  ?bench=1 / ?bench=60 (performance check)

import { createZiti, ZITI_ASPECT } from './ziti.js';
import { createStage } from './stage.js';
import { bookFromFiles, bookFromUrl, filesFromInput, filesFromDrop, renderTarget } from './reader.js';
import { wcSupport, WcRecorder } from './recorder-wc.js';
import { runPerfCheck } from './perf-check.js';

const VERSION = '0.7.2';
const q = new URLSearchParams(location.search);
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const deskFirst = matchMedia('(pointer: fine)').matches && innerWidth > innerHeight;

// ---------------------------------------------------------------- settings
const PIP_DEFAULTS = { tall: { x: 0.77, y: 0.84, h: 0.28 }, wide: { x: 0.87, y: 0.72, h: 0.52 }, square: { x: 0.82, y: 0.79, h: 0.38 } };
const DEFAULTS = {
  // ziti look: the stream PC's tuning
  sauce: true, brows: false, mirror: false, flip: true,
  eyes: 1.1, mouth: 1.24, mouthLift: 0.16, eyeLift: 0, eyeSpread: 0.94,
  turn: 1.15, sway: 0.45, bounce: 2, smooth: 0.5, zoom: 1, lift: 0,
  // the plate: the ziti pops up out of a plate of ziti (off = the classic floating noodle);
  // how much its body copies the head's turn, how springy it is
  body: true, follow: 0.5, wobble: 0.5,
  // video
  shape: deskFirst ? 'wide' : 'tall', quality: 1080, fps: 30, paper: 'ink',
  // pages
  dir: 'rtl', fit: 'auto', align: 'start', turnFx: reducedMotion ? 'cut' : 'slide',
  // ziti placement
  zitiOn: true, backdrop: 'none', backdropColor: 'gold', pip: PIP_DEFAULTS,
  countdown: true, micMode: 'clean',
};
const LOOK_KEYS = ['sauce', 'brows', 'mirror', 'flip', 'eyes', 'mouth', 'mouthLift', 'eyeLift', 'eyeSpread', 'turn', 'sway', 'bounce', 'smooth', 'zoom', 'lift', 'body', 'follow', 'wobble'];
const STORE = 'nippon.v1';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep going */ } },
};
const saved = store.get(STORE, {});
const CFG = { ...DEFAULTS, ...saved, debug: q.get('debug') === '1' };
if (![720, 1080, 2160].includes(CFG.quality)) CFG.quality = 1080;
if (![30, 60].includes(CFG.fps)) CFG.fps = 30;
CFG.pip = {};
for (const k of Object.keys(PIP_DEFAULTS)) CFG.pip[k] = { ...PIP_DEFAULTS[k], ...(saved.pip?.[k] || {}) };
const saveCfg = () => { const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = CFG[k]; store.set(STORE, o); };
let saveT = 0;
const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(saveCfg, 400); };

const PAPER = { ink: { bg: '#0f0c0a', fg: '#b49f84' }, paper: { bg: '#f4ede1', fg: '#6b5a46' } };
const BACKDROP = { gold: '#e8b45a', paper: '#f3e6cf', ink: '#17120e', tomato: '#c8432b' };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- dom
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const comp = createStage(stage);
const videoEl = $('cam');
const touch = $('touch');
const pipBox = $('pipBox');

let toastT = 0;
function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function setStatus(msg) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('show', !!msg); }

// ---------------------------------------------------------------- the ziti
const ziti = createZiti({ renderer: comp.renderer, CFG, store, videoEl, mpBase: q.get('mp'), onChange: () => updateLoadline() });

// ---------------------------------------------------------------- canvas size
let W = 1080, H = 1920;
function applyShape() {
  const s = CFG.quality, long = Math.round(s * 16 / 9);
  [W, H] = CFG.shape === 'wide' ? [long, s] : CFG.shape === 'square' ? [s, s] : [s, long];
  comp.setSize(W, H);
  comp.setZitiMax(s >= 2160 ? 1440 : 1080);
  mapCache = null;
  renderTarget.maxSide = s >= 2160 ? 3200 : 2400;
  mimeCache = null;
  resetSmooth();
  updateVidHint();
  if (cur) { initView(false); trans = null; }
  const labels = CFG.shape === 'tall' ? ['Top', 'Middle', 'Bottom'] : ['Left', 'Middle', 'Right'];
  [...$('alignSeg').children].forEach((b, i) => { b.textContent = labels[i]; });
}
const pip = () => CFG.pip[CFG.shape];
function pipRect() {
  const p = pip();
  const h = p.h * H, w = h * ZITI_ASPECT;
  return { x: p.x * W - w / 2, y: p.y * H - h / 2, w, h };
}

// ---------------------------------------------------------------- book + view
let book = null, pageIdx = 0, cur = null, trans = null, goToken = 0, nextImg = null;
const view = { zoom: 1, cx: 0, cy: 0 };   // what's drawn
const goal = { zoom: 1, cx: 0, cy: 0 };   // where it's easing to
let gesturing = false;

function fitMode(img) { return CFG.fit !== 'auto' ? CFG.fit : (img.h / img.w > 2.2 ? 'width' : 'page'); }
function baseScale(img) { return fitMode(img) === 'width' ? W / img.w : Math.min(W / img.w, H / img.h); }
function metrics(v, img = cur?.img) { const s = baseScale(img) * v.zoom; return { s, dw: img.w * s, dh: img.h * s }; }
function alignPos(len, d) { return CFG.align === 'start' ? d / 2 : CFG.align === 'end' ? len - d / 2 : len / 2; }
function clampView(v, img = cur?.img) {
  if (!img) return;
  v.zoom = clamp(v.zoom, 1, 6);
  const { dw, dh } = metrics(v, img);
  v.cx = dw <= W + 0.5 ? alignPos(W, dw) : clamp(v.cx, W - dw / 2, dw / 2);
  v.cy = dh <= H + 0.5 ? alignPos(H, dh) : clamp(v.cy, H - dh / 2, dh / 2);
}
function initView(atEnd) {
  goal.zoom = 1;
  const { dw, dh } = metrics(goal);
  goal.cx = W / 2;
  goal.cy = dh > H ? (atEnd ? H - dh / 2 : dh / 2) : 0;
  if (dw > W) goal.cx = CFG.dir === 'rtl' ? W - dw / 2 : dw / 2;
  clampView(goal);
  Object.assign(view, goal);
}

async function openBook(b, how = '') {
  book?.close();
  book = b; cur = null; trans = null;
  const start = clamp(store.get('nippon.progress', {})[progressKey()] || 0, 0, book.length - 1);
  await goTo(start, null);
  $('pageChip').hidden = false;
  syncBookInfo();
  closeSheets();
  toast(start > 0 ? `${book.title} · picked up on page ${start + 1}` : `${book.title} · ${book.length} pages${how}`, 3200);
  if (!store.get('nippon.seenTip', false)) {
    store.set('nippon.seenTip', true);
    setTimeout(() => toast('Tap the sides to turn pages. Tap the middle to hide the controls. Drag the ziti anywhere.', 5200), 3400);
  }
}
const progressKey = () => book ? `${book.title}|${book.length}` : '';
function saveProgress() {
  const p = store.get('nippon.progress', {});
  p[progressKey()] = pageIdx;
  const keys = Object.keys(p);
  if (keys.length > 60) delete p[keys[0]];
  store.set('nippon.progress', p);
}

async function goTo(i, side, atEnd = false) {
  if (!book) return;
  i = clamp(i, 0, book.length - 1);
  const tok = ++goToken;
  const img = await book.get(i);
  if (tok !== goToken) return;
  comp.prewarm(img);   // upload before the slide starts, so the turn itself never hitches
  const prev = cur && side && CFG.turnFx === 'slide' ? { img: cur.img, view: { ...view } } : null;
  pageIdx = i; cur = { img };
  initView(atEnd);
  trans = prev ? { ...prev, side, t0: performance.now() } : null;
  nextImg = null;
  comp.prune(new Set([img, prev?.img]));
  book.prefetch(i);
  const ahead = i + 1;
  if (ahead < book.length) {
    book.get(ahead).then((n) => setTimeout(() => {
      if (pageIdx === i && cur?.img === img) { nextImg = n; comp.prewarm(n); }
    }, 450));
  }
  $('pageChip').textContent = `${i + 1} / ${book.length}`;
  $('pageSlider').value = i + 1; $('pageOut').textContent = i + 1;
  saveProgress();
}

// next page comes in from the left when reading right-to-left
const sideFor = (delta) => ((delta > 0) === (CFG.dir === 'rtl') ? 'left' : 'right');
function step(delta) {
  if (!book) { openSheet('load'); return; }
  if (cur) {
    // tall pages and zoomed pages scroll first, then turn
    const { dh } = metrics(goal);
    if (dh > H + 2) {
      if (delta > 0 && goal.cy + dh / 2 > H + 4) { goal.cy = Math.max(H - dh / 2, goal.cy - H * 0.85); return; }
      if (delta < 0 && goal.cy - dh / 2 < -4) { goal.cy = Math.min(dh / 2, goal.cy + H * 0.85); return; }
    }
  }
  const ni = pageIdx + delta;
  if (ni < 0 || ni >= book.length) { toast(ni < 0 ? 'That\'s the first page.' : 'That\'s the last page.'); return; }
  goTo(ni, sideFor(delta), delta < 0);
}
const actLeft = () => step(CFG.dir === 'rtl' ? 1 : -1);
const actRight = () => step(CFG.dir === 'rtl' ? -1 : 1);

// ---------------------------------------------------------------- drawing
function placePage(img, v, offX) {
  const { dw, dh } = metrics(v, img);
  return { img, x: v.cx - dw / 2 + offX, y: v.cy - dh / 2, w: dw, h: dh };
}
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function draw(now, dt) {
  const pages = [];
  if (cur) {
    if (!gesturing) {
      const k = 1 - Math.exp(-dt * 14);
      for (const key of ['zoom', 'cx', 'cy']) view[key] += (goal[key] - view[key]) * k;
    }
    if (trans) {
      const e = easeOut(clamp((now - trans.t0) / 280, 0, 1));
      if (e < 1) {
        const sgn = trans.side === 'right' ? 1 : -1;
        pages.push(placePage(trans.img, trans.view, -sgn * W * e), placePage(cur.img, view, sgn * W * (1 - e)));
      } else trans = null;
    }
    if (!trans) pages.push(placePage(cur.img, view, 0));
  }
  const r = CFG.zitiOn ? pipRect() : null;
  comp.render({
    paper: PAPER[CFG.paper],
    pages,
    backdrop: r && CFG.backdrop !== 'none' ? { mode: CFG.backdrop, color: BACKDROP[CFG.backdropColor] || BACKDROP.gold, rect: r } : null,
    // at 60 fps the face is only measured 30 times a second, so the noodle can be redrawn every other frame;
    // the box itself still moves every frame
    ziti: r ? { rect: r, draw: ziti.renderTo, redraw: (zitiTick++ % rung().every) === 0 } : null,
  });
}
let zitiTick = 0;

// the dashed frame you grab (DOM, so it never shows up in the video)
let boxKey = '', mapCache = null;
// measured once per resize, not on every touch move: reading layout mid-drag is what makes drags stutter
function stageMap() {
  if (mapCache) return mapCache;
  const r = stage.getBoundingClientRect();
  const k = Math.min(r.width / W, r.height / H);
  return (mapCache = { k, ox: r.left + (r.width - W * k) / 2, oy: r.top + (r.height - H * k) / 2 });
}
const dropMap = () => { mapCache = null; boxKey = ''; };
window.addEventListener('resize', dropMap);
window.addEventListener('orientationchange', dropMap);
if (window.ResizeObserver) new ResizeObserver(dropMap).observe(stage);
stage.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (recording) stopRecording();
  toast('The device reset its graphics. If the stage stays blank, reload the page.', 6000);
});
function updatePipBox() {
  if (!CFG.zitiOn) { if (boxKey !== 'off') { pipBox.style.display = 'none'; boxKey = 'off'; } return; }
  const { k, ox, oy } = stageMap();
  const r = pipRect();
  const key = [ox + r.x * k, oy + r.y * k, r.w * k, r.h * k].map((v) => v.toFixed(1)).join();
  if (key === boxKey) return;
  boxKey = key;
  const [l, t, w, h] = key.split(',');
  Object.assign(pipBox.style, { display: 'block', transform: `translate(${l}px, ${t}px)`, width: w + 'px', height: h + 'px' });
}

// ---------------------------------------------------------------- gestures
const ptrs = new Map();
let g = null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function toCanvas(e) { const { k, ox, oy } = stageMap(); return { x: (e.clientX - ox) / k, y: (e.clientY - oy) / k, k }; }
function pipHit(p) {
  if (!CFG.zitiOn) return null;
  const r = pipRect(), pad = 12 / p.k, hs = 40 / p.k;
  if (p.x > r.x + r.w - hs * 0.6 && p.x < r.x + r.w + hs * 0.6 && p.y > r.y + r.h - hs * 0.6 && p.y < r.y + r.h + hs * 0.6) return 'pipResize';
  if (p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad) return 'pip';
  return null;
}
function movePip(P, x, y) { P.x = clamp(x, 0, 1); P.y = clamp(y, 0, 1); }
function zoomAt(v0, factor, at, to = at) {
  if (!cur) return;
  const z = clamp(v0.zoom * factor, 1, 6);
  const s0 = baseScale(cur.img) * v0.zoom, s1 = baseScale(cur.img) * z;
  const ux = (at.x - v0.cx) / s0, uy = (at.y - v0.cy) / s0;
  goal.zoom = z; goal.cx = to.x - ux * s1; goal.cy = to.y - uy * s1;
  clampView(goal);
}
function beginGesture(p, e) {
  g = { target: pipHit(p) || 'manga', start: p, t0: performance.now(), moved: false, mode: null,
    pip0: { ...pip() }, view0: { ...goal }, sx: e.clientX, sy: e.clientY };
}

touch.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  touch.setPointerCapture?.(e.pointerId);
  const p = toCanvas(e);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 1) beginGesture(p, e);
  else if (ptrs.size === 2 && g) {
    const [a, b] = [...ptrs.values()];
    g.pinch = { d0: Math.max(1, dist(a, b)), m0: mid(a, b), pip0: { ...pip() }, view0: { ...goal } };
    g.moved = true; g.mode = 'pinch';
    gesturing = g.target === 'manga';
  }
});
touch.addEventListener('pointermove', (e) => {
  if (!g) {
    if (e.pointerType === 'mouse') { const h = pipHit(toCanvas(e)); touch.style.cursor = h === 'pipResize' ? 'nwse-resize' : h ? 'grab' : 'default'; }
    return;
  }
  if (!ptrs.has(e.pointerId)) return;
  const p = toCanvas(e);
  ptrs.set(e.pointerId, p);
  if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 8) g.moved = true;
  if (!g.moved) return;
  const P = pip();
  if (g.pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const f = dist(a, b) / g.pinch.d0, m = mid(a, b);
    if (g.target === 'manga') { zoomAt(g.pinch.view0, f, g.pinch.m0, m); Object.assign(view, goal); }
    else { P.h = clamp(g.pinch.pip0.h * f, 0.12, 1); movePip(P, g.pinch.pip0.x + (m.x - g.pinch.m0.x) / W, g.pinch.pip0.y + (m.y - g.pinch.m0.y) / H); }
    return;
  }
  if (g.target === 'pip') { movePip(P, g.pip0.x + (p.x - g.start.x) / W, g.pip0.y + (p.y - g.start.y) / H); touch.style.cursor = 'grabbing'; }
  else if (g.target === 'pipResize') {
    const c = { x: g.pip0.x * W, y: g.pip0.y * H };
    P.h = clamp(g.pip0.h * dist(p, c) / Math.max(10, dist(g.start, c)), 0.12, 1);
  } else if (cur) {
    if (!g.mode) {
      const dx = p.x - g.start.x, dy = p.y - g.start.y, { dw, dh } = metrics(goal);
      const canX = dw > W + 1, canY = dh > H + 1;
      g.mode = Math.abs(dx) > Math.abs(dy) && !canX ? 'swipe' : (canX || canY) ? 'pan' : 'swipe';
      gesturing = g.mode === 'pan';
    }
    if (g.mode === 'pan') {
      goal.cx = g.view0.cx + (p.x - g.start.x); goal.cy = g.view0.cy + (p.y - g.start.y);
      clampView(goal); Object.assign(view, goal);
    }
  }
});
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (!g) return;
  if (ptrs.size === 1 && g.pinch) {
    // one finger left after a pinch: keep going as a drag from here
    const [p] = ptrs.values();
    g.pinch = null; g.start = p; g.pip0 = { ...pip() }; g.view0 = { ...goal }; g.mode = g.target === 'manga' ? 'pan' : null;
    return;
  }
  if (ptrs.size) return;
  if (e.type !== 'pointercancel') {
    if (!g.moved && performance.now() - g.t0 < 500) tapAt(toCanvas(e));
    else if (g.target === 'manga' && g.mode === 'swipe') {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) { if (dx < 0) actRight(); else actLeft(); }
    }
  }
  if (g.target !== 'manga') { saveCfg(); syncLayoutUI(); }
  g = null; gesturing = false;
  touch.style.cursor = 'default';
}
touch.addEventListener('pointerup', endPointer);
touch.addEventListener('pointercancel', endPointer);

function tapAt(p) {
  if (!book) { openSheet('load'); return; }
  const fx = p.x / W;
  if (fx < 0.3) actLeft();
  else if (fx > 0.7) actRight();
  else setClean(!document.body.classList.contains('clean'));
}
function setClean(on) {
  document.body.classList.toggle('clean', on);
  if (on && !store.get('nippon.seenClean', false)) { store.set('nippon.seenClean', true); toast('Controls hidden. Tap the middle again to bring them back.'); }
}

let wheelAcc = 0, wheelCool = 0;
touch.addEventListener('wheel', (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const p = toCanvas(e);
  if (pipHit(p)) { const P = pip(); P.h = clamp(P.h * Math.exp(-dy * 0.0015), 0.12, 1); saveSoon(); return; }
  if (!cur) return;
  if (e.ctrlKey) { zoomAt({ ...goal }, Math.exp(-dy * 0.01), p); return; }
  const { dw, dh } = metrics(goal);
  const before = { cx: goal.cx, cy: goal.cy };
  if (dh > H + 1 || dw > W + 1) { goal.cx -= dx; goal.cy -= dy; clampView(goal); }
  const moved = Math.abs(goal.cy - before.cy) + Math.abs(goal.cx - before.cx) > 0.5;
  if (moved) { wheelAcc = 0; return; }
  // at the edge (or a page that fits): a firm scroll turns the page
  const now = performance.now();
  if (now < wheelCool) return;
  wheelAcc += dy;
  if (Math.abs(wheelAcc) > 140) { step(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; wheelCool = now + 450; }
}, { passive: false });

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  let hit = true;
  if (k === 'ArrowLeft') actLeft();
  else if (k === 'ArrowRight') actRight();
  else if (k === ' ' || k === 'PageDown' || k === 'ArrowDown') step(1);
  else if (k === 'PageUp' || k === 'ArrowUp') step(-1);
  else if (k === 'Home' && book) goTo(0, sideFor(-1));
  else if (k === 'End' && book) goTo(book.length - 1, sideFor(1));
  else if (k === 'r' || k === 'R') $('rec').click();
  else if (k === 'p' || k === 'P') togglePause();
  else if (k === 'h' || k === 'H') setClean(!document.body.classList.contains('clean'));
  else if (k === 'z' || k === 'Z') setOpt('zitiOn', !CFG.zitiOn);
  else if (k === 'o' || k === 'O') openSheet('load');
  else if (k === 'Escape') closeSheets();
  else hit = false;
  if (hit) e.preventDefault();
});

// ---------------------------------------------------------------- loading manga
function setBusy(on, msg = 'Opening…') { $('loadBusy').textContent = msg; $('loadBusy').classList.toggle('show', on); }
function showErr(id, msg) { const el = $(id); el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
async function loadItems(items, how) {
  if (!items.length) return;
  showErr('fileErr', ''); showErr('urlErr', '');
  setBusy(true, `Opening ${items.length === 1 ? items[0].path.split('/').pop() : items.length + ' files'}…`);
  try { await openBook(await bookFromFiles(items), how); }
  catch (e) { showErr('fileErr', e.message || String(e)); openSheet('load'); toast(e.message || 'Could not open that.', 4500); }
  finally { setBusy(false); }
}
async function loadUrl(text) {
  showErr('fileErr', ''); showErr('urlErr', '');
  setBusy(true, 'Fetching…');
  try { await openBook(await bookFromUrl(text)); store.set('nippon.lastUrl', text); }
  catch (e) { showErr('urlErr', e.message || String(e)); openSheet('load'); }
  finally { setBusy(false); }
}
function syncBookInfo() {
  const has = !!book;
  $('bookInfo').classList.toggle('show', has);
  $('loadHead').style.display = has ? 'none' : '';
  if (!has) return;
  $('bookTitle').textContent = book.title;
  $('bookMeta').textContent = `${book.length} page${book.length === 1 ? '' : 's'} · reading ${CFG.dir === 'rtl' ? 'right to left' : 'left to right'}`;
  $('pageSlider').max = book.length;
  $('pageSlider').value = pageIdx + 1;
  $('pageOut').textContent = pageIdx + 1;
}

// drop anywhere (PC), paste a link anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const items = await filesFromDrop(e.dataTransfer);
  if (items.length) loadItems(items, '');
  else {
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) loadUrl(text);
  }
});
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const text = e.clipboardData?.getData('text') || '';
  if (/^\s*https?:\/\//i.test(text)) { e.preventDefault(); $('urlIn').value = text.trim(); loadUrl(text); }
});

// ---------------------------------------------------------------- camera + mic (from ZitiCam Pocket)
const VIDEO_C = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const MIC = {
  clean: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } },
  voice: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
};
const status = { cam: 'off', mic: 'off', micInfo: '', fps: 0, camFps: 0, rec: '' };
const micConstraints = () => MIC[CFG.micMode] || MIC.clean;
let camStream = null, micStream = null, micGranted = false, keepMicOpen = false;
function describeMic(track) {
  if (!track) return '';
  const s = track.getSettings ? track.getSettings() : {};
  const yn = (v) => (v === undefined ? '?' : v ? 'on' : 'off');
  return `${s.sampleRate ? Math.round(s.sampleRate / 100) / 10 + ' kHz' : '? kHz'} · echo ${yn(s.echoCancellation)} · noise ${yn(s.noiseSuppression)} · gain ${yn(s.autoGainControl)}`;
}
function micLive() { return !!micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live'); }
function releaseMic(force = false) {
  if (!micStream || (keepMicOpen && !force)) return;
  unplugMic();
  for (const t of micStream.getTracks()) t.stop();
  micStream = null;
  status.mic = micGranted ? 'closed (opens when you record)' : status.mic;
}
async function micPermission() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch { return 'unknown'; }
}
async function getMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  micStream = s; micGranted = true; status.mic = 'on';
  status.micInfo = describeMic(s.getAudioTracks()[0]);
  watchMic();
}
async function openMic() {
  if (micLive()) return true;
  const t0 = performance.now();
  try {
    await getMic();
    // An open mic keeps an iPhone in call mode, which makes playback sound thin and garbled, so close it
    // between takes. Only keep it open if this site asks for mic permission every time.
    const perm = await micPermission();
    keepMicOpen = perm === 'unknown' ? performance.now() - t0 > 3000 : perm !== 'granted';
    if (keepMicOpen && !store.get('nippon.seenMicTip', false)) {
      store.set('nippon.seenMicTip', true);
      setTimeout(() => toast('Tip: set Microphone to "Allow" for this site in your browser settings. Takes then play back at full quality.', 6500), 3000);
    }
    const vt = camStream?.getVideoTracks()[0];
    if (camStream && (!vt || vt.readyState === 'ended')) {
      await restartCamera();
      if (!micLive()) await getMic();   // some iPhones drop the mic when the camera comes back
    }
    return true;
  } catch (e) { status.mic = 'blocked (' + e.name + ')'; return false; }
}

// ---- the audio line: the recorder always records one steady track, and the mic plugs into it.
// If the mic hiccups or gets reconnected mid-take, the video gets a moment of silence instead of a broken audio track.
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, bus = null, meter = null, meterBuf = null, micNode = null;
let tapNode = null, tapReady = null, audioSink = null;   // audio-thread tap for the WebCodecs recorder (audio-tap.js)
function audioLine() {
  if (!AC || q.get('rawmic') === '1') return null;
  try {
    if (!actx) {
      actx = new AC();
      bus = actx.createMediaStreamDestination();
      // mic -> meter -> recorder: the meter sits in the path, so it shows exactly what's being recorded
      meter = actx.createAnalyser(); meter.fftSize = 1024;
      meter.connect(bus);
      meterBuf = new Float32Array(meter.fftSize);
      // mic -> meter -> tap: hands raw audio blocks to the recorder from the audio thread, so drawing can't cause gaps
      if (actx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        tapReady = actx.audioWorklet.addModule('./audio-tap.js').then(() => {
          tapNode = new AudioWorkletNode(actx, 'ziti-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          meter.connect(tapNode);
          tapNode.connect(bus);   // its output is silent; this just keeps it running
          tapNode.port.onmessage = (e) => audioSink?.(e.data);
          return true;
        }).catch(() => false);
      }
    }
    if (actx.state !== 'running') actx.resume().catch(() => {});
    return actx;
  } catch { return null; }
}
function plugMic() {
  if (!actx || !micLive()) return false;
  unplugMic();
  try {
    micNode = actx.createMediaStreamSource(micStream);
    micNode.connect(meter);
    return true;
  } catch { micNode = null; return false; }
}
function unplugMic() { try { micNode?.disconnect(); } catch {} micNode = null; }
function micLevel() {
  if (!meter || !micNode) return 0;
  meter.getFloatTimeDomainData(meterBuf);
  let s = 0;
  for (let i = 0; i < meterBuf.length; i++) s += meterBuf[i] * meterBuf[i];
  return Math.sqrt(s / meterBuf.length);
}
function sleepAudio() { if (actx && actx.state === 'running') actx.suspend().catch(() => {}); }
function watchMic() {
  const t = micStream?.getAudioTracks()[0];
  if (!t) return;
  t.onmute = () => { status.mic = 'muted by the device'; };
  t.onunmute = () => { status.mic = 'on'; };
  t.onended = async () => {
    if (!recording || micStream?.getAudioTracks()[0] !== t) return;
    micStream = null;
    if (status.audioPath !== 'line') { toast('The mic was cut off by the device. The rest of this take may be silent.', 5000); return; }
    toast('The mic was interrupted. Reconnecting…', 2500);
    try { await getMic(); plugMic(); toast('Mic back.', 1800); }
    catch { toast('Couldn\'t get the mic back. Stop and start a new take.', 5000); }
  };
}
async function startCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: micConstraints() });
    micGranted = true;
  } catch (e) {
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false });
    status.mic = (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'blocked' : 'unavailable';
  }
  attachCamera(stream.getVideoTracks());
  const at = stream.getAudioTracks()[0];
  if (at) { status.micInfo = describeMic(at); micStream = new MediaStream([at]); releaseMic(true); }
}
function attachCamera(tracks) {
  camStream = new MediaStream(tracks);
  videoEl.srcObject = camStream;
  videoEl.play().catch(() => {});
  const tr = camStream.getVideoTracks()[0];
  status.cam = `${tr?.getSettings?.().width || '?'}x${tr?.getSettings?.().height || '?'}`;
  tr?.addEventListener('ended', () => { status.cam = 'ended'; if (document.visibilityState === 'visible' && !restarting) restartCamera(); });
  tr?.addEventListener('mute', () => setTimeout(() => { if (tr.muted && tr.readyState === 'live' && document.visibilityState === 'visible' && !restarting && camStream?.getVideoTracks()[0] === tr) restartCamera(); }, 1500));
}
let restarting = false, camRestartPending = false;
async function restartCamera() {
  // reopening the camera mid-take can cut the mic on iPhone, so wait for the take to finish
  if (recording) { camRestartPending = true; return; }
  if (restarting) return;
  restarting = true;
  try { for (const t of camStream?.getTracks() || []) t.stop(); } catch {}
  try { attachCamera((await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false })).getVideoTracks()); }
  catch (e) { status.cam = 'error ' + e.name; toast('Camera stopped. Reload if it does not come back.'); }
  restarting = false;
}

// ---------------------------------------------------------------- loop
let lastFrame = 0, fpsN = 0, fpsT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 1000 / CFG.fps - 3) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  const w0 = performance.now();
  ziti.update(now, dt, CFG.zitiOn);
  draw(now, dt);
  recordFrame();
  updatePipBox();
  // main-thread cost of this frame: what has to fit inside 33 ms (or 16 ms at 60 fps)
  const work = performance.now() - w0;
  status.work = status.work ? status.work * 0.9 + work * 0.1 : work;
  status.workMax = Math.max(status.workMax || 0, work);
  fpsN++;
  if (now - fpsT > 1000) {
    status.fps = fpsN * 1000 / (now - fpsT); status.camFps = ziti.status.camFrames * 1000 / (now - fpsT);
    ziti.status.camFrames = 0; fpsN = 0; fpsT = now;
    checkPace();
    drawDebug();
    status.workMax = 0;
  }
}
// ---- staying smooth: if the device can't keep up, give up a little ziti quality before the video stutters.
// Each step is checked: if it didn't actually help, it's undone (the limit is elsewhere) and the ziti stays at full quality.
const LADDER = {
  60: [{ every: 1, scale: 1 }, { every: 2, scale: 1 }, { every: 2, scale: 0.75 }, { every: 2, scale: 0.55 }, { every: 2, scale: 0.42 }],
  // at 30 the ziti is always redrawn every frame: only its sharpness gives way, never the frame rate
  30: [{ every: 1, scale: 1 }, { every: 1, scale: 0.75 }, { every: 1, scale: 0.55 }, { every: 1, scale: 0.42 }],
};
const smooth = { lvl: 0, bad: 0, good: 0, check: null, holdUntil: 0 };
const rung = () => (LADDER[CFG.fps] || LADDER[30])[smooth.lvl] || LADDER[30][0];
function setRung(l) { smooth.lvl = l; comp.setZitiScale(rung().scale); }
function resetSmooth() { Object.assign(smooth, { bad: 0, good: 0, check: null, holdUntil: 0 }); setRung(0); slowStrikes = 0; slowWarned = false; }
let slowStrikes = 0, slowWarned = false;
function checkPace() {
  if (!started || document.visibilityState !== 'visible' || !CFG.zitiOn || openId) { smooth.bad = smooth.good = 0; return; }
  const now = performance.now(), ratio = status.fps / CFG.fps, top = (LADDER[CFG.fps] || LADDER[30]).length - 1;
  if (ratio < 0.9) { smooth.bad++; smooth.good = 0; } else if (ratio > 0.97) { smooth.good++; smooth.bad = 0; } else { smooth.bad = smooth.good = 0; }

  if (smooth.check && now - smooth.check.at > 3000) {
    const c = smooth.check; smooth.check = null;
    if (c.dir === 'down' && status.fps < c.fps * 1.08) { setRung(c.from); smooth.holdUntil = now + 60000; }   // didn't help: undo
    if (c.dir === 'up' && ratio < 0.9) { setRung(c.from); smooth.holdUntil = now + 60000; }                    // too much: go back
  }
  if (!smooth.check && now > smooth.holdUntil) {
    if (smooth.bad >= 2 && smooth.lvl < top) {
      smooth.check = { dir: 'down', from: smooth.lvl, fps: status.fps, at: now };
      setRung(smooth.lvl + 1); smooth.bad = 0;
    } else if (smooth.good >= 8 && smooth.lvl > 0) {
      smooth.check = { dir: 'up', from: smooth.lvl, fps: status.fps, at: now };
      setRung(smooth.lvl - 1); smooth.good = 0;
    }
  }

  // still short with nothing left to give (or nothing that helps): say so once
  if (slowWarned) return;
  if (ratio < 0.8 && (smooth.lvl === top || now < smooth.holdUntil)) slowStrikes++; else slowStrikes = Math.max(0, slowStrikes - 1);
  if (slowStrikes >= 4) {
    slowWarned = true;
    const lower = CFG.fps === 60 ? '30 fps' : CFG.quality === 2160 ? '1080p' : '720p';
    toast(`Holding ${Math.round(status.fps)} of ${CFG.fps} frames a second. If Low Power Mode is on, turn it off (it caps the screen at 30). Otherwise try ${lower} in Layout.`, 7500);
  }
}
function drawDebug() {
  if (!CFG.debug) return;
  const zs = ziti.status;
  $('debug').textContent =
    `ZitiCam Nippon ${VERSION}\n` +
    `render ${status.fps.toFixed(1)} / ${CFG.fps} fps · tracked ${status.camFps.toFixed(1)} fps\n` +
    `frame work ${(status.work || 0).toFixed(1)} ms avg, ${(status.workMax || 0).toFixed(1)} max · budget ${(1000 / CFG.fps).toFixed(0)} ms\n` +
    `detect ${zs.det.toFixed(1)} ms · tracker ${zs.tracker}${zs.trackerSrc ? ' (' + zs.trackerSrc + ')' : ''}${zs.workerErr ? ' · worker: ' + zs.workerErr.slice(0, 50) : ''}\n` +
    `camera ${status.cam} · mic ${status.mic}\n` +
    (status.micInfo ? `mic ${CFG.micMode}: ${status.micInfo}\n` : '') +
    `output ${W}x${H} · ziti ${Math.round(pipRect().w)}x${Math.round(pipRect().h)}\n` +
    `smoothness step ${smooth.lvl} · ziti redrawn every ${rung().every === 1 ? 'frame' : rung().every + ' frames'} at ${Math.round(rung().scale * 100)}%${smooth.holdUntil > performance.now() ? ' · holding' : ''}\n` +
    (status.level !== undefined ? `mic level ${(status.level * 100).toFixed(1)} · audio ${status.audioPath || '–'}\n` : '') +
    `recorder ${status.engine || (pickMime()?.mime || 'none')}${status.engineWhy ? ' (' + status.engineWhy + ')' : ''}\n` +
    (wcRec || status.lastStats ? `frames ${(wcRec || { stats: status.lastStats }).stats.frames} · repeated ${(wcRec || { stats: status.lastStats }).stats.repeats} · encoder waits ${(wcRec || { stats: status.lastStats }).stats.waits}\n` : '') +
    `face ${zs.face ? 'yes' : 'no'}` + (status.rec ? `\n${status.rec}` : '') + (zs.err ? `\nerror ${zs.err}` : '');
}

// ---------------------------------------------------------------- recording
// H.264 levels cap size x frame rate: 4.0 = 1080p30, 4.2 = 1080p60, 5.1 = 4K30, 5.2 = 4K60
function h264Levels() {
  const mbs = Math.ceil(W / 16) * Math.ceil(H / 16), rate = mbs * CFG.fps;
  const all = [['28', 8192, 245760], ['2a', 8704, 522240], ['33', 36864, 983040], ['34', 36864, 2073600]];
  return all.filter(([, f, r]) => mbs <= f && rate <= r).map(([l]) => l);
}
function mimeList() {
  const lv = h264Levels();
  return [
    ...lv.flatMap((l) => [`video/mp4;codecs=avc1.6400${l},mp4a.40.2`, `video/mp4;codecs=avc1.4d00${l},mp4a.40.2`]),
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
}
let mimeCache = null;
function pickMime() {
  if (mimeCache !== null) return mimeCache;
  if (typeof MediaRecorder === 'undefined') return (mimeCache = undefined);
  const forced = q.get('mime');
  if (forced && MediaRecorder.isTypeSupported(forced)) return (mimeCache = { mime: forced, ext: forced.startsWith('video/mp4') ? 'mp4' : 'webm' });
  const m = mimeList().find((x) => { try { return MediaRecorder.isTypeSupported(x); } catch { return false; } });
  return (mimeCache = m ? { mime: m, ext: m.startsWith('video/mp4') ? 'mp4' : 'webm' } : undefined);
}
// manga is mostly still, so these stay crisp while keeping long takes small enough to hold in memory
function videoBitrate() {
  const px = W * H, hi = CFG.fps === 60;
  if (px >= 3840 * 2160 * 0.9) return hi ? 30_000_000 : 20_000_000;
  if (px >= 1920 * 1080 * 0.9) return hi ? 12_000_000 : 8_000_000;
  return hi ? 7_500_000 : 5_000_000;
}
function updateVidHint() {
  const el = $('vidHint');
  if (!el) return;
  const mbMin = Math.round((videoBitrate() + 160_000) / 8 / 1e6 * 60);
  let note = `${W} × ${H} at ${CFG.fps} fps · about ${mbMin} MB per minute of recording.`;
  if (disk.ok) note += ' Takes save straight to this device\'s storage as you record, so long takes are fine.';
  else if (CFG.quality === 2160) note += ' This browser holds takes in memory: save every few minutes at 4K.';
  if (CFG.fps === 60) note += ' If your phone dips, Nippon eases off the ziti\'s detail first so the video stays smooth.';
  el.textContent = note;
}

// ---- takes go straight to this device's storage where the browser allows it: no memory limit on long 4K takes,
// and the last take survives the app being closed or crashing. Otherwise they're held in memory as before.
const disk = { w: null, ok: false, seq: 0, wait: new Map() };
function diskCall(msg) {
  return new Promise((res, rej) => { const id = ++disk.seq; disk.wait.set(id, { res, rej }); disk.w.postMessage({ ...msg, id }); });
}
const takesDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
const diskFile = async (name) => (await (await takesDir()).getFileHandle(name)).getFile();
async function initDisk() {
  if (q.get('memrec') === '1' || !navigator.storage?.getDirectory || typeof Worker === 'undefined') return;
  try {
    disk.w = new Worker('./take-writer.js');
    disk.w.onmessage = (e) => { const m = e.data, p = disk.wait.get(m.id); if (!p) return; disk.wait.delete(m.id); if (m.ok) p.res(m); else p.rej(new Error(m.err)); };
    await Promise.race([diskCall({ type: 'probe' }), new Promise((_, rej) => setTimeout(() => rej(new Error('storage check timed out')), 5000))]);
    disk.ok = true;
    navigator.storage.persist?.().catch(() => {});
  } catch (e) { disk.ok = false; status.diskErr = String(e.message || e); }
  updateVidHint();
  if (disk.ok) recoverTake().catch(() => {});
}
async function recoverTake() {
  const d = await takesDir(), names = [];
  for await (const name of d.keys()) if (!name.startsWith('.')) names.push(name);
  names.sort();
  const latest = names.pop();
  if (names.length) diskCall({ type: 'remove', names }).catch(() => {});
  if (!latest || take || recording) return;
  const f = await diskFile(latest);
  if (f.size < 2000) { diskCall({ type: 'remove', names: [latest] }).catch(() => {}); return; }
  const ext = latest.endsWith('.webm') ? 'webm' : 'mp4';
  const blob = new Blob([f], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
  take = { blob, url: URL.createObjectURL(blob), name: latest, ext, disk: latest, meta: `${(f.size / 1e6).toFixed(1)} MB · ${ext.toUpperCase()} · kept from your last session` };
  $('takeBtn').hidden = false;
}

let recorder = null, recording = false, counting = false, chunks = [], bytes = 0;
let recStart = 0, paused = false, pausedAt = 0, pausedTotal = 0, timerT = 0, take = null, autoPaused = false;
const fmt = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`; };
const elapsed = () => (performance.now() - recStart - pausedTotal - (paused ? performance.now() - pausedAt : 0)) / 1000;

// Two recording engines:
//  'webcodecs': every frame the stage draws goes to the hardware H.264 encoder with an exact timestamp (frame n at
//    n / fps), so the file is a true constant frame rate. Used whenever the device supports it at this size.
//  'mediarecorder': the browser's built-in recorder, as a fallback (older Safari has no WebCodecs audio encoder).
//    It's handed one frame per drawn frame, rather than sampling the canvas on its own timer and missing some.
let wcRec = null, mrTrack = null, finishFn = null, takeMeta = null, startingRec = false;
const engineCache = new Map();
function checkEngine(audioRate) {
  if (q.get('rec') === 'mr') return Promise.resolve({ ok: false, why: 'forced built-in recorder' });
  const key = `${W}x${H}@${CFG.fps}:${audioRate}:${videoBitrate()}`;
  if (!engineCache.has(key)) engineCache.set(key, wcSupport({ W, H, fps: CFG.fps, bitrate: videoBitrate(), audioRate }));
  return engineCache.get(key);
}

async function startRecording() {
  status.audioPath = '';
  let audioTrack = null;
  if (actx?.state === 'running' && plugMic()) { audioTrack = bus.stream.getAudioTracks()[0]; status.audioPath = 'line'; }
  else if (micLive()) { audioTrack = micStream.getAudioTracks()[0]; status.audioPath = 'direct'; }
  const micNote = audioTrack ? (CFG.micMode === 'voice' ? 'voice mic' : 'clean mic') : 'no sound';
  const shape = `${W}×${H} · ${CFG.fps} fps`;
  const toDisk = disk.ok;
  const nameFor = (ext) => ['ziticam-nippon', slug(book?.title), stamp()].filter(Boolean).join('-') + '.' + ext;
  chunks = []; bytes = 0; wcRec = null; mrTrack = null; finishFn = null;
  let diskFailed = false;
  const diskFail = () => {
    if (diskFailed) return;
    diskFailed = true;
    toast('Couldn\'t write to this device\'s storage (it may be full). Stopping here so the take so far is kept.', 6500);
    stopRecording();
  };
  const readDisk = async (name, type) => {
    try { await diskCall({ type: 'close' }); return new Blob([await diskFile(name)], { type }); } catch { return null; }
  };

  // WebCodecs needs the audio-thread tap for sound; without it (no Web Audio), use the built-in recorder
  const tapOk = status.audioPath === 'line' && tapReady
    ? await Promise.race([tapReady, new Promise((r) => setTimeout(() => r(false), 1500))]) : false;
  const audioRate = audioTrack ? (tapOk ? actx.sampleRate : -1) : 0;
  const engine = audioRate < 0 ? { ok: false, why: 'no audio tap' } : await checkEngine(audioRate);
  status.engineWhy = engine.ok ? '' : engine.why;
  if (engine.ok) {
    const takeName = nameFor('mp4');
    if (toDisk) diskCall({ type: 'open', name: takeName }).catch(diskFail);
    const rec = new WcRecorder({
      canvas: stage, fps: CFG.fps, bitrate: videoBitrate(), audioRate,
      write: toDisk ? (data, position) => (diskFailed ? Promise.resolve() : diskCall({ type: 'write', data, position }).catch(diskFail)) : null,
      onBytes: (n) => { bytes += n; },
      onError: (e) => {
        ziti.status.err = 'encoder: ' + (e.message || e);
        toast('The video encoder stopped. Keeping what was recorded so far.', 5000);
        stopRecording();
      },
    });
    try { await rec.start(); }
    catch (e) {
      status.engineWhy = 'WebCodecs start failed: ' + String(e.message || e).slice(0, 60);
      rec.cancel();
      if (toDisk) await diskCall({ type: 'remove', names: [takeName] }).catch(() => {});
      return startBuiltIn();
    }
    wcRec = rec;
    status.engine = 'WebCodecs · ' + rec.mime;
    if (audioRate) {
      audioSink = (block) => { if (!paused) rec.pushAudio(block); };   // paused audio is left out, like paused video
      tapNode.port.postMessage({ on: true });
    }
    finishFn = async () => {
      let r = {};
      if (audioRate) {
        tapNode.port.postMessage({ on: false });
        await new Promise((res) => setTimeout(res, 200));   // let the last block arrive
        audioSink = null;
      }
      try { r = await rec.stop(); } catch { /* the encoder failed; whatever reached storage is still kept */ }
      return { blob: toDisk ? await readDisk(takeName, 'video/mp4') : (r.blob || null), ext: 'mp4', diskName: toDisk ? takeName : '', steady: true };
    };
    return beginTake();
  }
  return startBuiltIn();

  function startBuiltIn() {
    const pm = pickMime();
    if (!pm) { toast('This browser can\'t record video.'); unplugMic(); sleepAudio(); releaseMic(); return; }
    let vStream = stage.captureStream(0);
    mrTrack = vStream.getVideoTracks()[0];
    if (typeof mrTrack?.requestFrame !== 'function') { mrTrack?.stop(); vStream = stage.captureStream(CFG.fps); mrTrack = null; }
    const stream = new MediaStream([...vStream.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])]);
    try { recorder = new MediaRecorder(stream, { mimeType: pm.mime, videoBitsPerSecond: videoBitrate(), audioBitsPerSecond: 160_000 }); }
    catch { recorder = new MediaRecorder(stream); }
    const type = (recorder.mimeType || pm.mime).split(';')[0] || 'video/mp4';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const takeName = nameFor(ext);
    const startedAt = performance.now();
    status.engine = 'built-in recorder · ' + type + (mrTrack ? ' · frame-locked' : '');
    if (toDisk) diskCall({ type: 'open', name: takeName }).catch(diskFail);
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      bytes += e.data.size;
      if (toDisk) { if (!diskFailed) diskCall({ type: 'chunk', blob: e.data }).catch(diskFail); }
      else chunks.push(e.data);
    };
    let stopped;
    const stoppedP = new Promise((r) => { stopped = r; });
    recorder.onstop = () => { for (const t of vStream.getVideoTracks()) t.stop(); stopped(); };
    recorder.onerror = (e) => {
      ziti.status.err = 'recorder: ' + (e.error?.message || e.name || 'error');
      // an encoder that can't handle the size usually fails right away
      if (performance.now() - startedAt < 5000 && (CFG.quality === 2160 || CFG.fps === 60)) {
        toast('This device couldn\'t record at that size. Try 1080p or 30 fps in Layout.', 6000);
      }
    };
    finishFn = async () => {
      try { if (recorder.state === 'paused') recorder.resume(); } catch {}
      try { recorder.requestData?.(); } catch {}
      try { recorder.stop(); } catch { stopped(); }
      await stoppedP;
      let blob;
      if (toDisk) blob = await readDisk(takeName, type);
      else { blob = new Blob(chunks, { type }); chunks = []; }
      return { blob, ext, diskName: toDisk ? takeName : '' };
    };
    recorder.start(1000);
    beginTake();
  }

  function beginTake() {
    recording = true; paused = false; pausedTotal = 0; recStart = performance.now();
    document.body.classList.add('recording');
    $('rec').setAttribute('aria-label', 'Stop recording');
    let quietFor = 0, quietWarned = !audioTrack;
    const tick = () => {
      const mb = bytes / 1e6;
      $('timerText').textContent = `${fmt(elapsed())} · ${mb < 1000 ? mb.toFixed(0) + ' MB' : (mb / 1000).toFixed(2) + ' GB'}`;
      status.rec = (paused ? 'paused ' : 'recording ') + $('timerText').textContent;
      // the meter shows that sound is really reaching the take
      const lv = micLevel();
      status.level = lv;
      $('meterFill').style.transform = `scaleX(${Math.min(1, Math.sqrt(lv) * 2.2).toFixed(3)})`;
      if (status.audioPath === 'line' && !paused) {
        quietFor = lv < 0.0015 ? quietFor + 0.25 : 0;
        if (quietFor >= 8 && !quietWarned) {
          quietWarned = true;
          toast('No sound is reaching the mic. Check nothing is covering it and no other app is using it.', 6000);
        }
      }
    };
    tick(); timerT = setInterval(tick, 250);
    $('meter').hidden = status.audioPath !== 'line';
    keepAwake();
    takeMeta = { micNote, shape };
  }
}

// called from the frame loop right after the stage is drawn
function recordFrame() {
  if (!recording || paused) return;
  if (wcRec) wcRec.frame(elapsed());
  else if (mrTrack) mrTrack.requestFrame();
}

function stopRecording() {
  if (!recording) return;
  if (paused) { pausedTotal += performance.now() - pausedAt; paused = false; }
  const secs = elapsed();
  recording = false;
  clearInterval(timerT);
  document.body.classList.remove('recording', 'paused');
  $('rec').setAttribute('aria-label', 'Record');
  status.rec = '';
  const fin = finishFn, meta = takeMeta || {};
  finishFn = null;
  if (fin) finalizeTake(fin, secs, meta);
}
async function finalizeTake(fin, secs, { micNote = '', shape = '' }) {
  setStatus('Finishing the video…');
  let res = {};
  try { res = await fin(); } catch { res = {}; }
  setStatus('');
  if (wcRec) status.lastStats = wcRec.stats;
  wcRec = null; mrTrack = null;
  // hand the audio back before playback: a live mic keeps iPhones in call mode, which mangles what you hear
  unplugMic(); sleepAudio(); releaseMic();
  status.level = undefined;
  if (camRestartPending) { camRestartPending = false; restartCamera(); }
  if (!res.blob || res.blob.size < 2000) {
    if (res.diskName) diskCall({ type: 'remove', names: [res.diskName] }).catch(() => {});
    toast('That take came out empty. Try again, and give it a second before stopping.', 4500);
    return;
  }
  finishTake(res.blob, secs, res.ext, micNote, res.steady ? shape + ' constant' : shape, res.diskName);
}
function togglePause() {
  if (!recording) return;
  try {
    if (!paused) { if (!wcRec) recorder.pause(); paused = true; pausedAt = performance.now(); }
    else { if (!wcRec) recorder.resume(); paused = false; pausedTotal += performance.now() - pausedAt; autoPaused = false; }
  } catch { toast('This browser can\'t pause recordings. Stop and start a new take instead.'); return; }
  document.body.classList.toggle('paused', paused);
  $('pauseBtn').setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
  $('pauseIcon').innerHTML = paused
    ? '<circle cx="12" cy="12" r="7"/>'
    : '<rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/>';
  toast(paused ? 'Paused. Line up the next page, then resume. The video picks up seamlessly.' : 'Rolling again.', 2200);
}
async function countdownThenRecord() {
  counting = true;
  audioLine();   // must start inside the tap, or iPhones keep it switched off
  const micReady = status.mic === 'unavailable' ? Promise.resolve(false) : openMic();
  if (actx) checkEngine(status.mic !== 'unavailable' ? actx.sampleRate : 0);   // warm up the encoder check during the countdown
  const el = $('count');
  if (CFG.countdown) {
    el.classList.add('show');
    for (const n of [3, 2, 1]) { el.textContent = n; await new Promise((r) => setTimeout(r, 800)); if (!counting) { el.classList.remove('show'); releaseMic(); sleepAudio(); return; } }
    el.classList.remove('show');
  }
  const ok = await micReady;
  if (actx && actx.state !== 'running') {
    await Promise.race([actx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1200))]);
  }
  if (!counting) { releaseMic(); sleepAudio(); return; }
  counting = false;
  if (!ok) toast('No mic, so this take is silent. Allow the microphone for this site to add sound.', 4500);
  startingRec = true;
  try { await startRecording(); } finally { startingRec = false; }
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const slug = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function finishTake(blob, secs, ext, micNote, shape, diskName = '') {
  if (take?.url) URL.revokeObjectURL(take.url);
  if (take?.disk && take.disk !== diskName) diskCall({ type: 'remove', names: [take.disk] }).catch(() => {});
  const name = diskName || ['ziticam-nippon', slug(book?.title), stamp()].filter(Boolean).join('-') + '.' + ext;
  take = { blob, url: URL.createObjectURL(blob), name, ext, disk: diskName, meta: `${fmt(secs)} · ${(blob.size / 1e6).toFixed(1)} MB · ${shape} · ${ext.toUpperCase()} · ${micNote}` };
  $('takeBtn').hidden = false;
  openReview();
}
function openReview() {
  if (!take) return;
  const v = $('reviewVideo');
  v.src = take.url;
  v.play().catch(() => {});
  $('reviewMeta').textContent = take.meta;
  openSheet('review');
}
function unloadReview() {
  // a paused player still holding the last take can starve the next recording
  const v = $('reviewVideo'); v.pause(); v.removeAttribute('src'); v.load();
}
async function shareTake() {
  if (!take) return;
  const file = new File([take.blob], take.name, { type: take.blob.type || 'video/mp4' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: book?.title || 'ZitiCam Nippon' }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  downloadTake();
}
function downloadTake() {
  if (!take) return;
  const a = document.createElement('a');
  a.href = take.url; a.download = take.name; document.body.appendChild(a); a.click(); a.remove();
}
function deleteTake() {
  closeSheets();
  if (take) {
    URL.revokeObjectURL(take.url);
    if (take.disk) diskCall({ type: 'remove', names: [take.disk] }).catch(() => {});
    take = null;
  }
  $('takeBtn').hidden = true;
  toast('Deleted.');
}

// ---------------------------------------------------------------- wake lock + leaving the page
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // iPhone cuts the mic when you leave, so finish the take there; on a PC, just pause it
    if (recording && (IOS || (!wcRec && !recorder?.pause))) stopRecording();
    else if (recording && !paused) { togglePause(); autoPaused = true; }
    else if (!recording) { releaseMic(true); sleepAudio(); }
    counting = false;
  } else if (started) {
    keepAwake();
    if (autoPaused) toast('Paused while you were away. Tap resume when you\'re ready.', 4000);
    const tr = camStream?.getVideoTracks()[0];
    if (camStream && (!tr || tr.readyState === 'ended')) restartCamera();
  }
});
// a take saved to storage survives a reload; one held in memory doesn't
window.addEventListener('beforeunload', (e) => { if (recording || (take && !take.disk)) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- sheets + settings UI
let openId = null;
function openSheet(id) {
  closeSheets(true);
  if (id === 'load') syncBookInfo();
  if (id === 'layout') syncLayoutUI();
  if (id !== 'layout') $('scrim').classList.add('show');   // layout stays see-through so you can drag the ziti while it's open
  $(id).classList.add('show');
  openId = id;
}
function closeSheets(quiet = false) {
  if (openId === 'review') unloadReview();
  $('scrim').classList.remove('show');
  for (const s of document.querySelectorAll('.sheet')) s.classList.remove('show');
  openId = null;
  if (!quiet) touch.focus?.();
}

function setOpt(k, v) {
  if ((k === 'shape' || k === 'quality' || k === 'fps') && recording) { toast('Stop recording to change the video shape, size or frame rate.'); return; }
  if ((k === 'micMode') && (recording || counting)) return;
  CFG[k] = v;
  if (k === 'shape' || k === 'quality' || k === 'fps') { applyShape(); boxKey = ''; }
  if (k === 'quality' && v === 2160 && !store.get('nippon.seen4k', false)) {
    store.set('nippon.seen4k', true);
    toast('4K: sharpest on PC and recent iPhones. Pages look their best when the scans themselves are high resolution.', 6000);
  }
  if (k === 'fit' || k === 'align') { if (cur) { clampView(goal); if (k === 'fit') initView(false); } }
  if (k === 'dir') syncBookInfo();
  if (k === 'zitiOn') { $('zitiOnBtn').setAttribute('aria-pressed', String(v)); boxKey = ''; }
  if (k === 'micMode') {
    if (micLive()) { releaseMic(true); if (keepMicOpen) openMic(); }
    toast(v === 'voice' ? 'Voice mic: cleanup on. Good for loud places, can sound processed.' : 'Clean mic: your real voice, no processing.');
  }
  saveCfg(); syncLayoutUI();
}
function syncLayoutUI() {
  for (const b of document.querySelectorAll('[data-k]')) b.setAttribute('aria-pressed', String(String(CFG[b.dataset.k]) === b.dataset.v));
  for (const b of document.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', String(!!CFG[b.dataset.toggle]));
  $('zitiOnBtn').setAttribute('aria-pressed', String(CFG.zitiOn));
  for (const b of document.querySelectorAll('#styleSeg button')) b.setAttribute('aria-pressed', String((b.dataset.style === 'plate') === (CFG.body !== false)));
  $('zitiOnBtn').textContent = CFG.zitiOn ? 'Ziti on' : 'Ziti off';
  $('pipSize').value = pip().h;
  $('pipSizeOut').textContent = Math.round(pip().h * 100) + '%';
  document.body.classList.toggle('debug', CFG.debug);
}
function preset(where) {
  const P = pip();
  const m = 0.025;
  const hw = (P.h * H * ZITI_ASPECT) / W / 2, hh = P.h / 2;
  const L = m + hw, R = 1 - m - hw, T = m + hh, B = 1 - m - hh;
  const spot = { tl: [L, T], tr: [R, T], bl: [L, B], br: [R, B], c: [0.5, 0.5] }[where];
  movePip(P, spot[0], spot[1]);
  saveCfg();
}

const SLIDERS = [
  ['Face', [
    ['eyes', 'Eye size', 0.6, 1.8, 0.01],
    ['eyeSpread', 'Eye spacing', 0.7, 1.3, 0.01],
    ['eyeLift', 'Eye height', -0.2, 0.2, 0.01],
    ['mouth', 'Mouth size', 0.6, 1.9, 0.01],
    ['mouthLift', 'Mouth height', -0.1, 0.35, 0.01],
  ]],
  ['Motion', [
    ['turn', 'Head follow', 0, 1.6, 0.01],
    ['sway', 'Drift', 0, 1.2, 0.01],
    ['bounce', 'Talk bounce', 0, 3, 0.05],
    ['smooth', 'Calm', 0, 1, 0.01],
  ]],
  ['Body', [
    ['follow', 'Body follow', 0, 1, 0.01],
    ['wobble', 'Body lag', 0, 1, 0.01],
  ]],
  ['Inside the frame', [
    ['zoom', 'Ziti size', 0.6, 1.6, 0.01],
    ['lift', 'Up / down', -0.6, 0.6, 0.01],
  ]],
];
function buildSliders() {
  const host = $('sliders');
  host.textContent = '';
  for (const [group, rows] of SLIDERS) {
    const gEl = document.createElement('div'); gEl.className = 'group'; gEl.textContent = group; host.appendChild(gEl);
    for (const [k, label, min, max, stepv] of rows) {
      const row = document.createElement('div'); row.className = 'row';
      const id = 'sl-' + k;
      const lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = label;
      const inp = document.createElement('input'); Object.assign(inp, { type: 'range', id, min, max, step: stepv, value: CFG[k] });
      const out = document.createElement('output'); out.textContent = (+CFG[k]).toFixed(2);
      const set = (v) => { CFG[k] = v; inp.value = v; out.textContent = (+v).toFixed(2); ziti.applyLook(); saveSoon(); };
      inp.addEventListener('input', () => set(+inp.value));
      inp.addEventListener('dblclick', () => set(DEFAULTS[k]));
      row.append(lab, inp, out); host.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------- start
const loadline = $('loadline');
function updateLoadline() {
  const zs = ziti.status;
  if (zs.err && !zs.ready) { loadline.textContent = 'Problem: ' + zs.err; return; }
  loadline.textContent = [
    zs.ready ? 'Ziti ready' : `Loading the ziti… ${zs.loadPct || 0}%`,
    ziti.landmarker ? 'face tracker ready' : (zs.tracker === 'failed' ? 'face tracker failed' : 'loading face tracker…'),
  ].join(' · ');
}

let started = false;
function enterApp() {
  started = true;
  $('start').classList.add('gone');
  document.body.classList.remove('prestart');
  $('rec').disabled = false;
  keepAwake();
  if (!ziti.landmarker && ziti.status.tracker !== 'failed') setStatus('Loading face tracker…');
  const link = q.get('manga');
  if (link) { $('urlIn').value = link; loadUrl(link); }
  else if (!book && !q.get('bench')) openSheet('load');
  if (q.get('bench')) perfCheck();
}

// ?bench=1: run the stage at every recording size and report whether each holds the frame rate (see perf-check.js)
async function perfCheck() {
  while (!ziti.status.ready) await new Promise((r) => setTimeout(r, 200));
  closeSheets();
  const keep = { quality: CFG.quality, fps: CFG.fps };
  const fps = q.get('bench') === '60' ? 60 : 30;
  if (CFG.fps !== fps) setOpt('fps', fps);
  await runPerfCheck({
    fps, label: `ZitiCam Nippon ${VERSION} · ${CFG.body === false ? 'classic noodle' : 'on the plate'} · ${CFG.shape}`,
    lighter: CFG.body === false ? 'Try 30 fps, or close other apps and tabs.' : 'Try the classic noodle (Layout → Style → Classic): it\'s lighter.',
    setSize: (v) => { if (CFG.quality !== v) setOpt('quality', v); else resetSmooth(); },
    getFps: () => status.fps, getWork: () => status.work || 0,
    getStep: () => `step ${smooth.lvl} · ziti ${Math.round(rung().scale * 100)}%`,
    onPose: (fn) => ziti.setPoseHook(fn),
    done: () => { setOpt('quality', keep.quality); setOpt('fps', keep.fps); },
  });
}
async function start() {
  const btn = $('startBtn');
  btn.disabled = true; btn.textContent = 'Starting…';
  $('startErr').style.display = 'none';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('This page needs HTTPS and a browser with camera access.'), { name: 'NoCamera' });
    await startCamera();
    enterApp();
    if (!micGranted) toast('No mic access, so takes will be silent. Allow the microphone for this site to fix it.', 5000);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Try again';
    const err = $('startErr');
    err.style.display = 'block';
    err.textContent = e.name === 'NotAllowedError'
      ? 'Camera access is blocked. Allow Camera and Microphone for this site in your browser settings, then reload.'
      : e.name === 'NotFoundError' ? 'No camera found on this device.' : (e.message || String(e));
    $('noCamBtn').style.display = 'flex';
  }
}

function wire() {
  buildSliders();
  $('startBtn').addEventListener('click', start);
  $('noCamBtn').addEventListener('click', () => { CFG.zitiOn = false; syncLayoutUI(); enterApp(); toast('Reading without the ziti. Recording still captures the pages and your mic.', 4200); });
  $('rec').addEventListener('click', () => {
    if ($('rec').disabled) return;
    if (counting) { counting = false; return; }
    if (startingRec) return;
    if (recording) stopRecording();
    else { if (take) unloadReview(); countdownThenRecord(); }
  });
  $('pauseBtn').addEventListener('click', togglePause);
  $('leftBtn').addEventListener('click', actLeft);
  $('rightBtn').addEventListener('click', actRight);
  $('loadBtn').addEventListener('click', () => openSheet('load'));
  $('pageChip').addEventListener('click', () => openSheet('load'));
  $('layoutBtn').addEventListener('click', () => (openId === 'layout' ? closeSheets() : openSheet('layout')));
  $('lookBtn').addEventListener('click', () => openSheet('look'));
  $('takeBtn').addEventListener('click', openReview);
  $('scrim').addEventListener('click', () => closeSheets());
  for (const id of ['closeLoad', 'closeLayout', 'closeLook', 'keepBtn']) $(id).addEventListener('click', () => closeSheets());

  $('fileIn').addEventListener('change', (e) => { loadItems(filesFromInput(e.target.files), ''); e.target.value = ''; });
  $('folderIn').addEventListener('change', (e) => { loadItems(filesFromInput(e.target.files), ''); e.target.value = ''; });
  $('urlIn').value = store.get('nippon.lastUrl', '');
  $('urlGo').addEventListener('click', () => loadUrl($('urlIn').value));
  $('urlIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) loadUrl($('urlIn').value); });
  $('pageSlider').addEventListener('input', () => { $('pageOut').textContent = $('pageSlider').value; });
  $('pageSlider').addEventListener('change', () => { const i = +$('pageSlider').value - 1; if (i !== pageIdx) goTo(i, sideFor(i - pageIdx)); });

  for (const b of document.querySelectorAll('[data-k]')) {
    b.addEventListener('click', () => { const v = b.dataset.v; setOpt(b.dataset.k, /^\d+$/.test(v) ? +v : v); });
  }
  for (const b of document.querySelectorAll('[data-toggle]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.toggle; CFG[k] = !CFG[k];
      if (k === 'mirror') ziti.resetFilters();
      if (k === 'debug') drawDebug();
      ziti.applyLook(); syncLayoutUI(); saveCfg();
    });
  }
  $('zitiOnBtn').addEventListener('click', () => setOpt('zitiOn', !CFG.zitiOn));
  // the plate is the full look; classic is the lighter floating noodle (handy on an older phone). Each device remembers its own.
  for (const b of document.querySelectorAll('#styleSeg button')) {
    b.addEventListener('click', () => { CFG.body = b.dataset.style === 'plate'; ziti.applyLook(); resetSmooth(); saveCfg(); syncLayoutUI(); });
  }
  for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => preset(b.dataset.preset));
  $('pipSize').addEventListener('input', () => { pip().h = +$('pipSize').value; $('pipSizeOut').textContent = Math.round(pip().h * 100) + '%'; saveSoon(); });

  $('straightBtn').addEventListener('click', () => {
    toast(ziti.straighten() ? 'Straightened. This pose is now "looking ahead".' : 'I can\'t see your face yet. Look at the camera, then tap again.');
  });
  $('resetLook').addEventListener('click', () => {
    for (const k of LOOK_KEYS) CFG[k] = DEFAULTS[k];
    ziti.resetFilters(); saveCfg(); buildSliders(); ziti.applyLook(); syncLayoutUI(); toast('Back to the stream look.');
  });
  $('shareBtn').addEventListener('click', shareTake);
  $('downloadBtn').addEventListener('click', downloadTake);
  $('discardBtn').addEventListener('click', deleteTake);
}

wire();
applyShape();
syncLayoutUI();
updateLoadline();
requestAnimationFrame(frame);
(q.get('notrack') === '1' ? new Promise(() => {}) : ziti.startTracker())
  .then(() => { setStatus(''); updateLoadline(); })
  .catch((e) => { ziti.status.err = 'tracker: ' + (e.message || e); setStatus('Face tracker didn\'t load. Check your connection and reload.'); updateLoadline(); });
if (q.get('autostart') === '1') start();
initDisk();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// tiny hook for automated checks
window.__zn = {
  CFG, ziti, status, step, goTo, setOpt, openBook, bookFromFiles, startRecording, stopRecording, togglePause, pipRect,
  get W() { return W; }, get H() { return H; }, get book() { return book; }, get pageIdx() { return pageIdx; },
  get view() { return view; }, get take() { return take; }, get micStream() { return micStream; }, get actx() { return actx; }, disk, get smoothLevel() { return smooth.lvl; }, get engine() { return status.engine; }, get wcStats() { return wcRec?.stats || status.lastStats; }, get recording() { return recording; }, get trans() { return trans; },
};
