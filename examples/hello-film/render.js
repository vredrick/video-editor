// Renders the film to MP4 in 2-second chunks with headless Edge/Chrome (puppeteer-core) + ffmpeg.
//
//   node render.js [workers]          → render/chunks/c_000.mp4 … (+ render/video.mp4 and render/<name>.mp4 when run by hand)
//   ONLY=2,3 node render.js           → re-renders only chunks 2 and 3 (VideoHub's partial re-render)
//   PREVIEW=1 node render.js          → half size, 30 fps, render/preview/video.mp4 (quick look)
//   node render.js snap 1.5 4 8.2     → snaps/<t>.jpg stills
//
// What VideoHub reads from this file (docs/PROJECT-CONTRACT.md): FPS, CH (frames per chunk) and the word "chunks" make
// it a chunked ("family A") script; process.env.ONLY means it can re-render single chunks; VW/VH give the size;
// PAGE is the page it opens. VideoHub runs it as `node render.js <workers>` in this folder with DUR, WK, ONLY, PREVIEW,
// FPS and VIDEOHUB_ENCODER in the environment, then joins the chunks and adds the sound itself (audio/mix.wav, or
// .videohub/project.json render.mux). Keep those names if you adapt this script.
//
// Speed (docs/RENDER-SPEED.md in the VideoHub folder):
// - Frames: when the page has one canvas of exactly VW x VH that holds the whole picture (this template does), its
//   pixels are read straight from the canvas, handed to a Web Worker and sent to this script over a local WebSocket;
//   ffmpeg gets raw RGBA (lossless, no JPEG). Any other page is captured as PNG screenshots (also lossless).
//   VIDEOHUB_TRANSPORT=png forces screenshots (the WebSocket server is built in: no package needed). Every frame is a pure function of t, so workers can render in parallel.
// - Encoder: VIDEOHUB_ENCODER = auto | nvenc | amf | qsv | x264 (auto: the first graphics-card encoder whose test
//   encode works, else x264). A named encoder that does not work here falls back to x264.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// a package from this folder's node_modules, else the one VideoHub ships with (VIDEOHUB_DIR is set by the queue)
function load(name, near) {
  const tries = [() => require(name)];
  for (const d of [process.env.VIDEOHUB_DIR, process.env.VIDEOHUB_HOME, near].filter(Boolean)) tries.push(() => require(require.resolve(name, { paths: [d] })));
  for (const t of tries) { try { return t(); } catch (e) { } }
  return null;
}
function loadPuppeteer() {
  const p = load('puppeteer-core'); if (p) return p;
  console.error('puppeteer-core not found: run "npm install" in this folder (or render through VideoHub, which ships it).');
  process.exit(2);
}
// the browser: CHROME env, else Edge, else Chrome; on Linux (RunPod) a system Chromium or a Playwright one
function browserPath() {
  const pw = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/workspace/webrender/browsers', '/opt/pw-browsers'].filter(Boolean).flatMap(d => {
    try { return fs.readdirSync(d).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]).flatMap(n => [path.join(d, n, 'chrome-linux64/chrome'), path.join(d, n, 'chrome-linux/chrome')]); } catch (e) { return []; }
  });
  const c = [process.env.CHROME,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', ...pw].filter(Boolean);
  const f = c.find(x => fs.existsSync(x));
  if (!f) { console.error('No Edge or Chrome found (set CHROME to a Chromium browser).'); process.exit(2); }
  return f;
}
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const PREVIEW = process.env.PREVIEW === '1';
const FPS = +(process.env.FPS || 30), DUR = +(process.env.DUR || 10), CH = 60, VW = 1920, VH = 1080;
const PAGE = process.env.PAGE || 'index.html';
const fps = PREVIEW ? Math.min(FPS, 30) : FPS, scale = PREVIEW ? 0.5 : 1, TOTAL = Math.round(DUR * fps);
const OUT = PREVIEW ? path.resolve('render/preview') : path.resolve('render/chunks');

// ---------- encoders (the same table as VideoHub's server/encoders.js; quality checked against a lossless reference)
const ENCODER_ARGS = {
  nvenc: [['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-maxrate', '250M', '-bufsize', '500M', '-level', '5.2', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-bf', '3', '-b_ref_mode', 'middle']],
  amf: [['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '14', '-qp_p', '16', '-qp_b', '18', '-bf', '3'],
    ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '14', '-qp_p', '16', '-qp_b', '18']],
  qsv: [['-c:v', 'h264_qsv', '-preset', 'veryslow', '-global_quality', '18', '-look_ahead', '1']],
  x264: [['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16']],
  lossless: [['-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0']],   // for checks only (huge files)
};
const probe = args => spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=30', '-frames:v', '5', '-pix_fmt', 'yuv420p', ...args, '-f', 'null', '-'], { stdio: 'ignore', timeout: 20000, windowsHide: true }).status === 0;
function pickEncoder() {
  const want = String(process.env.VIDEOHUB_ENCODER || 'auto').toLowerCase();
  const works = n => (ENCODER_ARGS[n] || []).find(probe) || null;
  if (want === 'x264' || want === 'lossless') return { name: want, args: ENCODER_ARGS[want][0] };
  for (const n of want === 'auto' ? ['nvenc', 'amf', 'qsv'] : [want]) { const a = works(n); if (a) return { name: n, args: a }; }
  if (want !== 'auto') console.log(`encoder ${want} does not work on this PC: using x264`);
  return { name: 'x264', args: ENCODER_ARGS.x264[0] };
}
let ENC = null;
// ffmpeg for one chunk: raw RGBA frames or PNG screenshots in, the chosen encoder out
function encoder(input, out) {
  const inArgs = input === 'raw' ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${VW}x${VH}`, '-framerate', String(fps), '-i', '-']
    : ['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'];
  // RGB → YUV with the BT.601 matrix (what x264 got before; old and new chunks of a film match) and the file says so:
  // left to itself AMF marks its output BT.709, so players showed BT.601 colours as BT.709 (a visible shift)
  const size = input === 'raw' && scale !== 1 ? `${Math.round(VW * scale)}:${Math.round(VH * scale)}:flags=bicubic:` : '';
  const pix = ENC.name === 'lossless' ? ['-pix_fmt', 'rgb24'] : ['-vf', `scale=${size}out_color_matrix=bt601:out_range=tv`, '-pix_fmt', 'yuv420p', '-colorspace', 'smpte170m', '-color_range', 'tv'];
  if (ENC.name === 'lossless' && size) pix.unshift('-vf', `scale=${size.slice(0, -1)}`);
  return spawn(FFMPEG, ['-y', '-loglevel', 'error', ...inArgs, ...ENC.args, ...pix, '-r', String(fps), out], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
}

// ---------- page side of the raw path (runs in the page): is the canvas the whole picture? then read it every frame
// and pass it to a worker that sends it over the WebSocket; at most 2 frames in flight (the script acks each one)
function pageRaw(VW, VH, url) {
  try { window.renderOut(0); } catch (e) { return 'renderOut(0) failed'; }
  const cs = [...document.querySelectorAll('canvas')];
  if (cs.length !== 1) return cs.length + ' canvases on the page';
  const c = cs[0];
  if (c.width !== VW || c.height !== VH) return `the canvas is ${c.width}x${c.height}, not ${VW}x${VH}`;
  const r = c.getBoundingClientRect();
  if (Math.round(r.left) || Math.round(r.top) || Math.round(r.width) !== VW || Math.round(r.height) !== VH) return 'the canvas is not shown at 0,0 at full size';
  for (let e = c; e && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.opacity !== '1' || s.filter !== 'none' || s.mixBlendMode !== 'normal' || s.clipPath !== 'none' || (s.maskImage && s.maskImage !== 'none')) return 'the canvas or a parent has opacity, a filter, a blend mode or a mask';
  }
  for (const e of document.body.querySelectorAll('*')) {
    if (e === c || e.contains(c) || /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|TITLE)$/.test(e.tagName)) continue;
    const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
    const b = e.getBoundingClientRect(); if (b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.left < VW && b.top < VH) return `another visible element (<${e.tagName.toLowerCase()}>) over the page`;
  }
  for (const e of [document.documentElement, document.body, c.parentElement]) for (const ps of ['::before', '::after']) { const s = e && getComputedStyle(e, ps); if (s && s.content && s.content !== 'none' && s.content !== 'normal') return 'a ::before/::after element on the page'; }
  let read, flip = false;
  const g = c.getContext('2d');   // the page's own context (null when it is WebGL)
  if (g) {
    const cs2 = g.getContextAttributes ? g.getContextAttributes().colorSpace : 'srgb';
    if (cs2 && cs2 !== 'srgb') return 'the canvas colour space is ' + cs2;
    read = () => g.getImageData(0, 0, VW, VH).data.buffer;
  } else {
    const gl = c.getContext('webgl2') || c.getContext('webgl'); if (!gl) return 'the canvas has no 2D or WebGL context';
    flip = true;   // WebGL rows come bottom-up; read in the same task as the drawing (no preserveDrawingBuffer needed)
    read = () => { const px = new Uint8Array(VW * VH * 4); gl.readPixels(0, 0, VW, VH, gl.RGBA, gl.UNSIGNED_BYTE, px); return px.buffer; };
  }
  const src = `let ws;onmessage=e=>{const m=e.data;if(m.url){ws=new WebSocket(m.url);ws.binaryType='arraybuffer';ws.onopen=()=>postMessage({open:1});ws.onmessage=()=>postMessage({ack:1});ws.onerror=()=>postMessage({err:'the frame socket failed'});ws.onclose=()=>postMessage({err:'the frame socket closed'});return}
const px=new Uint8Array(m.buf),W=m.w*4;if(m.flip){const t=new Uint8Array(W);for(let a=0,b=m.h-1;a<b;a++,b--){const A=a*W,B=b*W;t.set(px.subarray(A,A+W));px.copyWithin(A,B,B+W);px.set(t,B)}}
const u=new Uint32Array(m.buf);for(let i=0;i<u.length;i++)if((u[i]>>>24)!==255){postMessage({err:'transparent pixels in frame '+m.f});return}ws.send(new Blob([px]))}`;   // a Blob, not the ArrayBuffer: ~2.5x faster through Chromium's socket (measured)
  const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const st = { inflight: 0, err: null, wake: null, open: false };
  wk.onmessage = e => { const d = e.data; if (d.ack) st.inflight--; if (d.err) st.err = d.err; if (d.open) st.open = true; const w = st.wake; st.wake = null; if (w) w(); };
  wk.onerror = e => { st.err = 'worker: ' + (e.message || e); const w = st.wake; st.wake = null; if (w) w(); };
  const wait = () => new Promise(r => { st.wake = r; });
  window.__vhRaw = {
    open: async () => { wk.postMessage({ url }); while (!st.open && !st.err) await wait(); if (st.err) throw new Error(st.err); },
    chunk: async (a, b, fps) => {
      const errors = [];
      for (let f = a; f < b; f++) {
        while (st.inflight >= 2 && !st.err) await wait();
        if (st.err) throw new Error(st.err);
        try { window.renderOut(f / fps); } catch (e) { if (errors.length < 20) errors.push('t=' + f / fps + ' ' + (e.stack || e)); }
        const buf = read(); st.inflight++; wk.postMessage({ buf, flip, w: VW, h: VH, f }, [buf]);
      }
      while (st.inflight > 0 && !st.err) await wait();
      if (st.err) throw new Error(st.err);
      return errors;
    },
  };
  return null;
}

// ---------- one browser per worker: the page, and how it hands over frames
async function openPage(br, sockets, id) {
  const p = await br.newPage();
  p.on('pageerror', e => console.error('PAGE ERROR', e.message));
  await p.setViewport({ width: VW, height: VH, deviceScaleFactor: 1 });
  await p.goto(pathToFileURL(path.resolve(PAGE)).href);
  await p.waitForFunction('window.READY === true', { timeout: 120000 });
  const cdp = await p.target().createCDPSession();
  const shot = async (t, format = 'png') => {
    const err = await p.evaluate(t => { try { window.renderOut(t); return null; } catch (e) { return String(e.stack || e); } }, t);
    if (err) console.error('t=' + t, err);
    const { data } = await cdp.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 92 } : {}), optimizeForSpeed: true, clip: { x: 0, y: 0, width: VW, height: VH, scale } });
    return Buffer.from(data, 'base64');
  };
  let raw = null;
  if (sockets && process.env.VIDEOHUB_TRANSPORT !== 'png') {
    const why = await p.evaluate(pageRaw, VW, VH, `ws://127.0.0.1:${sockets.port}/?w=${id}`).catch(e => 'page check failed: ' + e.message);
    if (why) console.log(`[w${id}] frames: PNG screenshots (${why})`);
    else {
      const conn = sockets.wait(id);
      await p.evaluate(() => window.__vhRaw.open());
      raw = await conn;
      console.log(`[w${id}] frames: raw canvas pixels`);
    }
  }
  return { page: p, shot, raw };
}

// the frame server: one WebSocket per worker page (a minimal built-in server: no package needed, and it streams each
// frame to ffmpeg as it arrives, unmasked in place, instead of collecting 8 MB messages first; the "ws" package spent
// ~15 ms of this script's single thread per 1080p frame doing that and capped renders at ~30 fps)
function frameServer() {
  const http = require('http'), crypto = require('crypto');
  return new Promise((resolve, reject) => {
    const waiting = new Map();   // worker id → the page that is about to connect (a restarted page connects again)
    const srv = http.createServer((q, r) => { r.writeHead(404); r.end(); });
    srv.on('upgrade', (req, sock) => {
      const id = new URL(req.url, 'http://x').searchParams.get('w'), w = waiting.get(id), key = req.headers['sec-websocket-key'];
      if (!w || !key) return sock.destroy();
      waiting.delete(id); sock.setNoDelay(true);
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
      w(wsConn(sock));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close(), wait: id => new Promise(r => waiting.set(String(id), r)) }));
  });
}
// XOR the client mask into b in place (phase = payload bytes already unmasked), 4 bytes at a time where aligned
function unmask(b, m, ph) {
  let i = 0; const n = b.length;
  while (i < n && ((b.byteOffset + i) & 3)) { b[i] ^= m[(ph + i) & 3]; i++; }
  const words = (n - i) >> 2;
  if (words) { const k = (ph + i) & 3, m32 = new Uint32Array(new Uint8Array([m[k], m[(k + 1) & 3], m[(k + 2) & 3], m[(k + 3) & 3]]).buffer)[0], u = new Uint32Array(b.buffer, b.byteOffset + i, words); for (let j = 0; j < words; j++) u[j] ^= m32; i += words * 4; }
  while (i < n) { b[i] ^= m[(ph + i) & 3]; i++; }
}
// a WebSocket connection read as a stream: c.onData(piece) for each piece of a binary message, c.onEnd() when it ends
function wsConn(sock) {
  const c = { sock, onData: null, onEnd: null, closed: false, send: t => { const b = Buffer.from(t); sock.write(Buffer.concat([Buffer.from([0x81, b.length]), b])); } };
  let head = null, left = 0, mask = null, ph = 0, op = 0, fin = false, ctl = null, cop = 0;
  const done = () => {
    if (ctl) { const o = cop; const body = Buffer.concat(ctl); ctl = null; if (o === 8) { c.closed = true; sock.end(); } else if (o === 9) sock.write(Buffer.concat([Buffer.from([0x8a, body.length]), body])); return; }
    if (fin && c.onEnd) c.onEnd();
  };
  sock.on('data', d => {
    let buf = head ? Buffer.concat([head, d]) : d, i = 0; head = null;
    while (i < buf.length) {
      if (left > 0) {
        const n = Math.min(left, buf.length - i), piece = buf.subarray(i, i + n);
        unmask(piece, mask, ph); ph = (ph + n) & 3; left -= n; i += n;
        if (ctl) ctl.push(Buffer.from(piece)); else if (c.onData) c.onData(piece);
        if (!left) done();
        continue;
      }
      if (buf.length - i < 2) { head = Buffer.from(buf.subarray(i)); break; }
      const b0 = buf[i], b1 = buf[i + 1], l7 = b1 & 0x7f, hl = 2 + (l7 === 126 ? 2 : l7 === 127 ? 8 : 0) + (b1 & 0x80 ? 4 : 0);
      if (buf.length - i < hl) { head = Buffer.from(buf.subarray(i)); break; }
      const len = l7 === 126 ? buf.readUInt16BE(i + 2) : l7 === 127 ? Number(buf.readBigUInt64BE(i + 2)) : l7;
      mask = b1 & 0x80 ? Buffer.from(buf.subarray(i + hl - 4, i + hl)) : Buffer.alloc(4); ph = 0; i += hl; left = len;
      const o = b0 & 0x0f;
      if (o >= 8) { ctl = []; cop = o; } else { if (o) op = o; fin = !!(b0 & 0x80); }
      if (!left) done();
    }
  });
  sock.on('close', () => { c.closed = true; }); sock.on('error', () => { c.closed = true; });
  return c;
}

// one chunk through the raw path: frames arrive in order on the socket and go to ffmpeg piece by piece. A frame is acked
// (the page keeps at most 2 in flight) once ffmpeg's pipe holds at most one frame; above two frames the socket pauses
// and resumes on 'drain'
async function rawChunk(w, a, b, tmp, hold) {
  const FRAME = VW * VH * 4, ff = hold.ff = encoder('raw', tmp), s = w.raw, sock = s.sock;
  let n = 0, got = 0, acks = 0, paused = false, bad = null;
  const flush = () => { if (ff.stdin.writableLength <= FRAME) for (; acks > 0; acks--) s.send('k'); };
  const onDrain = () => { if (paused) { paused = false; sock.resume(); } flush(); };
  ff.stdin.on('drain', onDrain); ff.stdin.on('error', () => { });
  s.onData = piece => { got += piece.length; ff.stdin.write(piece); if (!paused && ff.stdin.writableLength > 2 * FRAME) { paused = true; sock.pause(); } };
  s.onEnd = () => { n++; if (got !== FRAME && !bad) bad = `frame ${n} has ${got} bytes, not ${FRAME}`; got = 0; acks++; flush(); };
  const closed = new Promise(r => ff.on('close', r));
  try {
    const errors = await Promise.race([w.page.evaluate((a, b, fps) => window.__vhRaw.chunk(a, b, fps), a, b, fps), closed.then(code => { throw new Error('ffmpeg stopped (code ' + code + ')'); })]);
    for (const e of errors) console.error(e);
    if (bad) throw new Error(bad);
    if (n !== b - a) throw new Error(`chunk got ${n} of ${b - a} frames`);
  } catch (e) { try { ff.kill(); } catch (x) { } throw e; }
  finally { s.onData = s.onEnd = null; ff.stdin.off('drain', onDrain); paused = false; sock.resume(); }   // resume before end(): a paused socket would keep the last frame back
  ff.stdin.end(); return { ff, code: await closed };
}
async function shotChunk(w, a, b, tmp, hold) {
  const ff = hold.ff = encoder('png', tmp), closed = new Promise(r => ff.on('close', r));
  for (let f = a; f < b; f++) { const buf = await w.shot(f / fps); if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r)); }
  ff.stdin.end(); return { ff, code: await closed };
}

(async () => {
  const puppeteer = loadPuppeteer(), exe = browserPath();
  // 2D canvases are drawn in software: Chromium moves a canvas that is read back often (the raw path) to software
  // drawing anyway, and with both paths on the same rasteriser raw frames and screenshots are pixel-identical (WebGL is
  // not affected)
  const launch = () => puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 0, args: ['--allow-file-access-from-files', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-accelerated-2d-canvas', ...(process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [])] });

  if (process.argv[2] === 'snap') {
    const br = await launch(), w = await openPage(br, null, 0); fs.mkdirSync('snaps', { recursive: true });
    for (const a of process.argv.slice(3)) fs.writeFileSync(`snaps/${a}.jpg`, await w.shot(+a, 'jpeg'));
    await br.close(); return;
  }

  const W = Math.max(1, +process.argv[2] || +process.env.WK || 2);
  fs.mkdirSync(OUT, { recursive: true });
  const chunkFrames = PREVIEW ? TOTAL : CH, nCh = Math.ceil(TOTAL / chunkFrames);
  const cf = c => path.join(OUT, `c_${String(c).padStart(3, '0')}.mp4`);
  const only = !PREVIEW && process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
  // a chunk already on disk is kept (a stopped render resumes); VideoHub moves the chunks it wants again out of the way
  const queue = []; for (let c = 0; c < nCh; c++) if ((PREVIEW || !fs.existsSync(cf(c))) && (!only || only.includes(c))) queue.push(c);
  console.log(`${queue.length}/${nCh} chunks to render`);   // VideoHub reads this line and the "chunk N ok — D done" ones for its progress bar
  if (!queue.length) { console.log('done 0s'); return; }
  ENC = pickEncoder(); console.log(`encoder: ${ENC.name} (${ENC.args[1]})`);
  const sockets = process.env.VIDEOHUB_TRANSPORT === 'png' ? null : await frameServer().catch(e => { console.log('frames: PNG screenshots (' + e.message + ')'); return null; });
  const T0 = Date.now(); let done = 0, frames = 0;
  // a chunk that takes far longer than it should (a hung page or ffmpeg) is killed and rendered again, up to 3 times
  const budget = n => 60000 + n * 2000;
  await Promise.all(Array.from({ length: Math.min(W, queue.length) }, async (_, id) => {
    let br = await launch(), w = await openPage(br, sockets, id);
    const restart = async () => { try { await Promise.race([br.close(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { } try { br.process() && br.process().kill(); } catch (e) { } br = await launch(); w = await openPage(br, sockets, id); };
    while (queue.length) {
      const c = queue.shift(), a = c * chunkFrames, b = Math.min(TOTAL, a + chunkFrames), tmp = cf(c) + '.tmp.mp4';
      for (let attempt = 1; ; attempt++) {
        const hold = {}; let timer = null;
        const run = (w.raw ? rawChunk(w, a, b, tmp, hold) : shotChunk(w, a, b, tmp, hold)).then(r => r.code);
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`chunk ${c} took longer than ${budget(b - a) / 1000}s`), { timeout: true })), budget(b - a)); });
        try {
          const code = await Promise.race([run, timeout]);
          if (code !== 0) throw new Error(`ffmpeg failed on chunk ${c} (code ${code})`);
          break;
        } catch (e) {
          run.catch(() => { }); try { hold.ff && hold.ff.kill(); } catch (x) { }
          if (/transparent pixels/.test(e.message) && w.raw) { console.log(`[w${id}] frames: PNG screenshots (${e.message})`); w.raw = null; continue; }   // the screenshot shows the page behind: not the same picture
          if (attempt >= 4) throw e;
          console.log(`[w${id}] chunk ${c}: ${e.message}; trying again (${attempt}/3)`);
          await restart();
        } finally { clearTimeout(timer); }
      }
      fs.renameSync(tmp, cf(c));
      done++; frames += b - a; console.log(`[w${id}] chunk ${c} ok — ${done} done, ${queue.length} queued, ${((Date.now() - T0) / 1000).toFixed(0)}s`);
    }
    await br.close();
  }));
  if (sockets) sockets.close();
  const sec = (Date.now() - T0) / 1000;
  console.log(`rendered ${frames} frames in ${sec.toFixed(1)}s (${(frames / sec).toFixed(1)} fps, encoder ${ENC.name})`);

  if (PREVIEW) { fs.renameSync(cf(0), path.join(OUT, 'video.mp4')); console.log('preview done: render/preview/video.mp4'); return; }
  if (only) { console.log('partial done'); return; }
  // joined picture (VideoHub joins the chunks again itself; this is for running the script by hand)
  fs.writeFileSync('render/list.txt', Array.from({ length: nCh }, (_, c) => `file '${cf(c).split(path.sep).join('/')}'`).join('\n'));
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'render/list.txt', '-c', 'copy', 'render/video.mp4']);
  if (!process.env.VIDEOHUB_JOB && fs.existsSync('audio/mix.wav')) {
    const name = path.basename(process.cwd());
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', 'render/video.mp4', '-i', 'audio/mix.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', `render/${name}.mp4`]);
    console.log(`done: render/${name}.mp4`);
  }
  console.log('done', sec.toFixed(0) + 's');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
