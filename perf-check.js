// Performance check: open the app with ?bench=1 (or ?bench=60 for 60 fps) and it runs the ziti at every
// recording size for a few seconds each, with a moving, talking head, and reports whether each one holds the
// frame rate. Nothing is recorded; it measures drawing, the part that has to fit inside every frame.
//
// The app hands in how to change size, read its frame rate and smoothness step, and drive the head.
// Shared, unchanged, by ZitiCam Pocket and ZitiCam Nippon.

const SIZES = [[720, '720p'], [1080, '1080p'], [2160, '4K']];
const STAGE_MS = 14000, MEASURE_MS = 6000;   // time for the smoothness steps to settle, then the part that counts
const WARMUP_MS = 6000;                       // let the face tracker and shaders finish loading before anything counts

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER)) || 'unknown';
  } catch { return 'unknown'; }
}

// a head that keeps moving the way people do on camera: drifting, turning, nodding, talking, leaning in
export function benchPose(t) {
  const s = (f, p = 0) => Math.sin(t * f + p);
  return {
    yaw: 0.45 * s(0.9) + 0.1 * s(2.3, 1),
    pitch: 0.12 * s(1.3, 0.5),
    roll: 0.15 * s(0.7, 2),
    x: 0.55 * s(0.6) + 0.1 * s(1.9, 3),
    y: 0.25 * s(0.45, 1) + 0.05 * s(2.7),
    jaw: Math.max(0, s(9) * s(1.1, 0.4)),   // talking in bursts
    lean: 0.15 * s(0.35, 2),
  };
}

// opts: { fps, label, lighter (text: what to try if it can't keep up), setSize(q), getFps(), getWork(),
//         getStep() -> text, onPose(fn | null), done() }
export async function runPerfCheck(opts) {
  const fps = opts.fps === 60 ? 60 : 30;
  const card = document.createElement('div');
  card.setAttribute('role', 'status');
  card.style.cssText = 'position:fixed;left:50%;top:max(16px,env(safe-area-inset-top));transform:translateX(-50%);z-index:90;' +
    'width:min(92vw,420px);padding:16px 18px;border-radius:16px;background:rgba(20,15,11,.94);color:#f3e6cf;' +
    'font:14px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.45);border:1px solid rgba(232,180,90,.35)';
  document.body.appendChild(card);
  const gpu = gpuName();
  const rows = [];
  const draw = (note) => {
    card.innerHTML = `<div style="font-weight:700;color:#e8b45a;margin-bottom:4px">Performance check · ${fps} fps</div>` +
      `<div style="color:#b49f84;font-size:12px;margin-bottom:10px">${opts.label} · ${gpu.replace(/[<>&]/g, '')}</div>` +
      rows.map((r) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0">` +
        `<span>${r.name}</span><span style="font-variant-numeric:tabular-nums">${r.text}</span></div>`).join('') +
      (note ? `<div style="color:#b49f84;margin-top:8px">${note}</div>` : '');
  };
  const t0 = performance.now();
  opts.onPose((now) => benchPose((now - t0) / 1000));
  const results = [];
  try {
    draw('Warming up…');
    await new Promise((r) => setTimeout(r, WARMUP_MS));
    for (const [q, name] of SIZES) {
      const row = { name, text: 'running…' };
      rows.push(row); draw('Keep this tab in front. About 50 seconds in all.');
      opts.setSize(q);
      const start = performance.now(), samples = [], work = [];
      while (performance.now() - start < STAGE_MS) {
        await new Promise((r) => setTimeout(r, 1000));
        if (performance.now() - start > STAGE_MS - MEASURE_MS) { samples.push(opts.getFps()); work.push(opts.getWork()); }
      }
      const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
      const min = Math.min(...samples);
      const ok = avg >= fps * 0.97 && min >= fps * 0.9;
      const r = { size: name, fps: +avg.toFixed(1), min: +min.toFixed(1), work: +(work.reduce((a, b) => a + b, 0) / Math.max(1, work.length)).toFixed(1), step: opts.getStep(), ok };
      results.push(r);
      row.text = `${ok ? '✓' : '✗'} ${r.fps} fps (low ${r.min}) · ${r.step}`;
      draw();
    }
  } finally {
    opts.onPose(null);
    opts.done();
  }
  const all = results.every((r) => r.ok), none = results.every((r) => !r.ok);
  const software = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
  draw((all ? `Holds ${fps} fps at every size on this device.`
    : none ? `Doesn't hold ${fps} fps at any size here.${opts.lighter ? ' ' + opts.lighter : ''}`
    : `Holds ${fps} fps at the sizes marked ✓. Record at one of those for the smoothest video.`) +
    (software ? ' This browser is drawing without a graphics chip (software rendering), so these numbers say nothing about the device itself: a phone or PC with its graphics turned on is many times faster.' : ''));
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = 'margin-top:12px;width:100%;padding:10px;border-radius:12px;border:0;background:#e8b45a;color:#24180c;font-weight:700;font-size:15px';
  close.onclick = () => card.remove();
  card.appendChild(close);
  window.__perf = { fps, gpu, software, results, pass: all };
  console.log('perf-check ' + JSON.stringify(window.__perf));
  return window.__perf;
}
