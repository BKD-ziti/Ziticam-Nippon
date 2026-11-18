// Turns files, folders, archives and links into a Book: an ordered list of pages that load on demand.

const IMG_RE = /\.(jpe?g|jfif|png|webp|gif|avif|bmp|heic|heif)$/i;
const ZIP_RE = /\.(cbz|zip)$/i;
const PDF_RE = /\.pdf$/i;
const RAR_RE = /\.(cbr|rar|cb7|7z)$/i;
const JUNK_RE = /(^|\/)(\.|__MACOSX\/)/;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif' };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ext = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const stem = (name) => name.split('/').pop().replace(/\.[a-z0-9]+$/i, '');

export const BLOCKED_MSG = 'That site doesn\'t let other apps load its pages. Save the pages (or the chapter as a .cbz / .zip) and use Files instead.';

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
let jszipP = null, pdfP = null;
const getJSZip = () => (jszipP ||= loadScript('./vendor/jszip.min.js').then(() => window.JSZip));
const getPdf = () => (pdfP ||= loadScript('./vendor/pdf.min.js').then(() => {
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', location.href).href;
  return lib;
}));

function imageFromUrl(url, cors) {
  return new Promise((res, rej) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image failed to load'));
    img.src = url;
  });
}

function blobPage(name, getBlob) {
  return {
    name,
    async load() {
      const blob = await getBlob();
      const url = URL.createObjectURL(blob);
      try {
        const img = await imageFromUrl(url, false);
        return { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
      } catch (e) { URL.revokeObjectURL(url); throw e; }
    },
  };
}
function urlPage(url) {
  return {
    name: decodeURIComponent(new URL(url).pathname.split('/').pop() || url),
    async load() {
      const img = await imageFromUrl(url, true);
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, release() {} };
    },
  };
}

function brokenPage(i, err) {
  const c = document.createElement('canvas');
  c.width = 1000; c.height = 1414;
  const g = c.getContext('2d');
  g.fillStyle = '#211a14'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#b49f84'; g.textAlign = 'center';
  g.font = '600 44px system-ui, sans-serif'; g.fillText(`Page ${i + 1} wouldn't open`, 500, 680);
  g.font = '32px system-ui, sans-serif'; g.fillText(String(err?.message || 'unknown problem').slice(0, 60), 500, 740);
  return { src: c, w: c.width, h: c.height, broken: true, release() {} };
}

export class Book {
  constructor(title, pages, source = '') {
    this.title = title || 'Untitled';
    this.pages = pages;
    this.source = source;
    this.cache = new Map();
  }
  get length() { return this.pages.length; }
  get(i) {
    let p = this.cache.get(i);
    if (!p) {
      p = this.pages[i].load().catch((e) => brokenPage(i, e));
      this.cache.set(i, p);
    }
    return p;
  }
  // keep a small window of decoded pages around the current one; phones run out of image memory fast
  prefetch(i) {
    for (const j of [i + 1, i + 2, i - 1]) if (j >= 0 && j < this.length) this.get(j);
    for (const [k, p] of this.cache) {
      if (k < i - 2 || k > i + 3) { this.cache.delete(k); p.then((r) => setTimeout(() => r.release?.(), 1500)); }
    }
  }
  close() {
    for (const p of this.cache.values()) p.then((r) => r.release?.());
    this.cache.clear();
    this.onClose?.();
  }
}

async function zipPages(blob) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(blob);
  return Object.values(zip.files)
    .filter((f) => !f.dir && IMG_RE.test(f.name) && !JUNK_RE.test(f.name))
    .sort((a, b) => collator.compare(a.name, b.name))
    .map((f) => blobPage(f.name, async () => new Blob([await f.async('arraybuffer')], { type: MIME[ext(f.name)] || '' })));
}

async function pdfPages(blob, book) {
  const lib = await getPdf();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    pages.push({
      name: `page ${n}`,
      async load() {
        const page = await doc.getPage(n);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(4, 2400 / Math.max(vp1.width, vp1.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const g = c.getContext('2d', { alpha: false });
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        page.cleanup();
        return { src: c, w: c.width, h: c.height, release() { c.width = c.height = 0; } };
      },
    });
  }
  book.closers.push(() => doc.destroy());
  return pages;
}

function titleFor(items) {
  if (items.length === 1) return stem(items[0].path);
  const first = items[0].path.split('/');
  if (first.length > 1 && items.every((it) => it.path.split('/')[0] === first[0])) {
    // deepest shared folder reads best, e.g. "One Piece/Chapter 12"
    const parts = items[0].path.split('/').slice(0, -1);
    let k = parts.length;
    while (k > 0 && !items.every((it) => it.path.startsWith(parts.slice(0, k).join('/') + '/'))) k--;
    return parts.slice(Math.max(0, k - 2), k).join(' · ') || first[0];
  }
  return stem(items[0].path);
}

// items: [{ file: File|Blob, path: 'folder/name.jpg' }]
export async function bookFromFiles(items, source = 'files') {
  items = items.filter((it) => it.file && !JUNK_RE.test(it.path));
  items.sort((a, b) => collator.compare(a.path, b.path));
  const ctx = { closers: [] };
  const pages = [];
  let rar = 0;
  for (const it of items) {
    const n = it.path, type = it.file.type || '';
    if (ZIP_RE.test(n) || /zip|comicbook/.test(type)) pages.push(...await zipPages(it.file));
    else if (PDF_RE.test(n) || type === 'application/pdf') pages.push(...await pdfPages(it.file, ctx));
    else if (RAR_RE.test(n)) rar++;
    else if (IMG_RE.test(n) || (type.startsWith('image/') && !type.includes('svg'))) pages.push(blobPage(n, async () => it.file));
  }
  if (!pages.length) {
    throw new Error(rar
      ? 'CBR / RAR files can\'t be opened in a browser. Re-save the chapter as .cbz or .zip, or pick the images themselves.'
      : 'No pages found there. Pick images, a .cbz / .zip, or a PDF.');
  }
  const book = new Book(titleFor(items), pages, source);
  book.onClose = () => ctx.closers.forEach((f) => { try { f(); } catch {} });
  return book;
}

export function filesFromInput(fileList) {
  return [...fileList].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
}

// drag and drop, including whole folders on a PC
export async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return filesFromInput(dt.files || []);
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

// "https://site/ch1/{01-24}.jpg" -> 24 links
function expandRange(s) {
  const m = s.match(/\{(\d+)-(\d+)\}/);
  if (!m) return [s];
  const [a, b] = [m[1], m[2]];
  const pad = a.length > 1 && a.startsWith('0') ? a.length : 0;
  const lo = +a, hi = +b, step = lo <= hi ? 1 : -1;
  const out = [];
  for (let n = lo; out.length < 2000; n += step) {
    out.push(s.replace(m[0], String(n).padStart(pad, '0')));
    if (n === hi) break;
  }
  return out;
}

async function fetchOrExplain(url) {
  let res;
  try { res = await fetch(url, { mode: 'cors' }); }
  catch { throw new Error(BLOCKED_MSG); }
  if (!res.ok) throw new Error(`That link answered ${res.status}. Check it opens in your browser.`);
  return res;
}

async function scrapeImages(url) {
  const res = await fetchOrExplain(url);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) return [url];
  if (!type.includes('html')) throw new Error('That link isn\'t an image, a .cbz / .zip / .pdf, or a page with images on it.');
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const seen = new Set(), out = [];
  for (const img of doc.querySelectorAll('img')) {
    for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'src']) {
      const v = img.getAttribute(attr);
      if (!v || v.startsWith('data:')) continue;
      let abs;
      try { abs = new URL(v, url).href; } catch { continue; }
      if (!/\.(jpe?g|png|webp|avif)(\?|$)/i.test(abs)) continue;
      if (seen.has(abs)) break;
      seen.add(abs); out.push(abs);
      break;
    }
  }
  if (!out.length) throw new Error('Couldn\'t find manga pages on that page. Try a direct image link instead.');
  return out;
}

export async function bookFromUrl(text) {
  const lines = text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Paste a link first.');
  let urls = [];
  for (const l of lines.flatMap(expandRange)) {
    let u;
    try { u = new URL(l); } catch { throw new Error(`"${l.slice(0, 40)}" isn't a full link. It should start with https://`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links work here.');
    urls.push(u.href);
  }
  const path0 = decodeURIComponent(new URL(urls[0]).pathname);
  if (urls.length === 1 && (ZIP_RE.test(path0) || PDF_RE.test(path0))) {
    const blob = await (await fetchOrExplain(urls[0])).blob();
    const name = path0.split('/').pop();
    return bookFromFiles([{ file: new File([blob], name, { type: blob.type }), path: name }], urls[0]);
  }
  if (urls.length === 1 && !IMG_RE.test(path0)) urls = await scrapeImages(urls[0]);
  try { await imageFromUrl(urls[0], true); }
  catch { throw new Error(BLOCKED_MSG); }
  const segs = path0.split('/').filter(Boolean);
  const title = urls.length > 1 ? (segs.slice(-3, -1).join(' · ') || new URL(urls[0]).host) : stem(path0);
  return new Book(title, urls.map(urlPage), lines.join('\n'));
}
