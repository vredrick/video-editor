// Shared helpers: paths, JSON files, child processes, ffprobe with a cache.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// VIDEOHUB_DATA_DIR: npm test keeps its config, caches and queue out of the install's own data folder
export const DATA_DIR = process.env.VIDEOHUB_DATA_DIR ? path.resolve(process.env.VIDEOHUB_DATA_DIR) : path.join(HUB_DIR, 'data');
export const HOME = os.homedir();
// Windows is the home platform; on Linux (the RunPod workstation) the same hub runs headless: no Explorer, no Recycle Bin,
// CPU limits through nice + taskset, Chromium instead of Edge (see docs/LINUX.md)
export const IS_WIN = process.platform === 'win32';
// a pod has no screen: never try to open Explorer, Edge or a folder dialog there
if (!IS_WIN && !process.env.VIDEOHUB_NO_WINDOW) process.env.VIDEOHUB_NO_WINDOW = '1';
export const DESKTOP = (() => {
  // OneDrive can move the Desktop; prefer the one that exists
  for (const d of [path.join(HOME, 'Desktop'), path.join(HOME, 'OneDrive', 'Desktop'), path.join(HOME, 'OneDrive', 'Masa\u00fcst\u00fc')]) if (fs.existsSync(d)) return d;
  return path.join(HOME, 'Desktop');
})();
export const DOCUMENTS = (() => {
  for (const d of [path.join(HOME, 'Documents'), path.join(HOME, 'OneDrive', 'Documents')]) if (fs.existsSync(d)) return d;
  return path.join(HOME, 'Documents');
})();
export const APPDATA = process.env.APPDATA || (IS_WIN ? path.join(HOME, 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'));
export const TEMP = os.tmpdir();
fs.mkdirSync(DATA_DIR, { recursive: true });

export const idOf = p => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 12);
export const norm = p => path.resolve(p).toLowerCase();
// Folders that were moved can leave junctions at their old paths, so compare real paths (cached)
const realCache = new Map();
const realNorm = p => { const k = norm(p); let r = realCache.get(k); if (r === undefined) { try { r = fs.realpathSync.native(k).toLowerCase(); realCache.set(k, r); } catch { r = k; } } return r; };
export const isInside = (child, parent) => { const c = realNorm(child), p = realNorm(parent); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep); };
// does a command line or path refer to a path inside this install? Never by folder name: films live in Documents\VideoHub\films
// and the install folder can have any name (a GitHub ZIP unpacks as VideoHub-main). Case-insensitive, both slash styles.
const slashes = s => String(s || '').toLowerCase().replace(/[\\/]+/g, '/');
export const refersToHub = (s, hub = HUB_DIR) => new RegExp(slashes(hub).replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/|["\'\\s]|$)').test(slashes(s));
export const shortPath = p => (isInside(p, DESKTOP) ? path.relative(DESKTOP, p) : isInside(p, HOME) ? '~' + path.sep + path.relative(HOME, p) : p) || p;

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
// write via a temp file so readers never see half a file
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// PowerShell with a script passed via -EncodedCommand (no quoting trouble)
export function powershell(script, opts = {}) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], opts);
}

export async function pLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- tools on this PC
function which(name, extra = []) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extra);
  for (const d of dirs) { const f = path.join(d, name); if (d && fs.existsSync(f)) return f; }
  return null;
}
// Linux: CHROME (or VIDEOHUB_BROWSER), a system Chromium/Chrome, else the newest Playwright Chromium in PLAYWRIGHT_BROWSERS_PATH,
// the RunPod volume's /workspace/webrender/browsers or /opt/pw-browsers (headless renders only; there is no window to open)
export function linuxBrowser(env = process.env, exists = fs.existsSync, readdir = d => fs.readdirSync(d)) {
  const direct = [env.VIDEOHUB_BROWSER, env.CHROME, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
  for (const f of direct) if (exists(f)) return f;
  for (const dir of [env.PLAYWRIGHT_BROWSERS_PATH, '/workspace/webrender/browsers', '/opt/pw-browsers'].filter(Boolean)) {
    let subs = []; try { subs = readdir(dir).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]); } catch { continue; }
    for (const s of subs) for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const f = path.join(dir, s, rel); if (exists(f)) return f; }
  }
  return null;
}
export const TOOLS = IS_WIN ? {
  ffmpeg: which('ffmpeg.exe', ['C:\\ffmpeg\\bin']) || 'ffmpeg',
  ffprobe: which('ffprobe.exe', ['C:\\ffmpeg\\bin']) || 'ffprobe',
  node: process.execPath,
  edge: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(f => fs.existsSync(f)) || null,
  chrome: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(HOME, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')].find(f => fs.existsSync(f)) || null,
} : {
  ffmpeg: which('ffmpeg') || 'ffmpeg',
  ffprobe: which('ffprobe') || 'ffprobe',
  node: process.execPath,
  edge: null,
  chrome: linuxBrowser(),
};

// ---------- ffprobe with a persistent cache (path + size + mtime)
const PROBE_CACHE = path.join(DATA_DIR, 'probe-cache.json');
let probeCache = readJson(PROBE_CACHE, {});
let probeDirty = false;
export function flushProbeCache() { if (probeDirty) { writeJson(PROBE_CACHE, probeCache); probeDirty = false; } }
export async function probe(file, st) {
  st = st || fs.statSync(file);
  const key = norm(file), sig = st.size + ':' + Math.round(st.mtimeMs);
  const hit = probeCache[key];
  if (hit && hit.sig === sig) return hit.info;
  const r = await run(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  let info = { ok: false };
  try {
    const j = JSON.parse(r.stdout), v = (j.streams || []).find(s => s.codec_type === 'video');
    const [a, b] = String(v?.r_frame_rate || '0/1').split('/').map(Number);
    info = {
      ok: !!v, dur: +(+j.format?.duration || 0).toFixed(2), bitrate: +j.format?.bit_rate || 0,
      w: v?.width || 0, h: v?.height || 0, fps: b ? Math.round(a / b * 100) / 100 : 0,
      audio: (j.streams || []).some(s => s.codec_type === 'audio'),
    };
  } catch { }
  probeCache[key] = { sig, info }; probeDirty = true;
  return info;
}

// quick content fingerprint for duplicate detection: size + first and last 1 MB
export async function fingerprint(file, size) {
  const fd = await fsp.open(file, 'r');
  try {
    const n = Math.min(size, 1 << 20), a = Buffer.alloc(n), b = Buffer.alloc(n);
    await fd.read(a, 0, n, 0); await fd.read(b, 0, n, Math.max(0, size - n));
    return crypto.createHash('sha1').update(a).update(b).update(String(size)).digest('hex');
  } finally { await fd.close(); }
}

export function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

export const fmtGB = b => (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 0 : 1) + ' GB';
export const now = () => new Date().toISOString();
