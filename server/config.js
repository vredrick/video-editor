// Machine-local settings in data/config.json. Created on first run (or by setup: scripts/init-config.mjs), so the same
// code works on any PC. Every folder VideoHub writes to has a default inside one workspace folder (baseDir: films,
// outputs, sounds, thumbnails, archive; Documents\VideoHub unless setup chose another) and can be changed in Settings
// or in data/config.json. See docs/MIGRATING.md for older installs.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DESKTOP, DOCUMENTS, HOME, IS_WIN, readJson, writeJson } from './util.js';
import { ENCODERS } from './encoders.js';

const FILE = path.join(DATA_DIR, 'config.json');

// root types:
//   container : every sub-folder is a project (a "films" folder)
//   project   : the folder itself is one project
//   media     : finished videos lying around (an export folder)
const SKIP = new Set(['node_modules', '.git', '.claude', 'VideoHub', '$RECYCLE.BIN']);

// the workspace: the base folder for everything VideoHub creates by default. VIDEOHUB_BASE_DIR (tests and test hubs
// point it at a scratch folder) → config.baseDir (chosen in setup) → Documents\VideoHub. Installs from before baseDir
// existed have no key and keep Documents\VideoHub; their explicit folders are kept anyway (see config()).
const okBase = b => typeof b === 'string' && path.isAbsolute(b) ? b : null;
// Linux: /workspace/videohub on a RunPod pod (the network volume outlives the pod), else ~/VideoHub
export const DEFAULT_BASE = () => IS_WIN ? path.join(DOCUMENTS, 'VideoHub') : fs.existsSync('/workspace') ? '/workspace/videohub' : path.join(HOME, 'VideoHub');
export const baseDir = () => process.env.VIDEOHUB_BASE_DIR || okBase(cfg ? cfg.baseDir : savedBase) || DEFAULT_BASE();
export const defaultFilmsDir = () => path.join(baseDir(), 'films');
// container sub-folders never listed as projects (helpers next to films) unless they have their own render script.
// Overridable with config.skipFolders.
export const DEFAULT_SKIP_FOLDERS = ['tools', 'fonts', 'test', 'render', 'videos', 'thumbnails', 'assets'];

function hasRenderCode(dir) {
  try { return fs.readdirSync(dir).some(f => /^(render\.(m?js|py)|anim_render\.\w+|manifest\.json|index\.html|.*\.snipp)$/i.test(f)); } catch { return false; }
}
function countMp4(dir) { try { return fs.readdirSync(dir).filter(f => /\.mp4$/i.test(f)).length; } catch { return 0; } }

// Desktop / Documents folders that look like video work: suggested in Settings, switched off until the user turns
// them on. The default films folder (Documents\VideoHub\films) is a root from the start and is on.
export function discoverRoots() {
  const roots = [];
  const add = (p, type, enabled) => { if (fs.existsSync(p) && !roots.some(r => r.path.toLowerCase() === p.toLowerCase())) roots.push({ path: p, type, enabled }); };
  const lower = p => p.toLowerCase();
  for (const top of [DESKTOP, DOCUMENTS]) {
    let entries = []; try { entries = fs.readdirSync(top, { withFileTypes: true }); } catch { }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(top, e.name), lp = lower(p);
      if (lp === lower(baseDir())) continue;
      // skip folders that are a root, sit inside one, or contain one
      if (roots.some(r => lower(r.path) === lp || lp.startsWith(lower(r.path) + path.sep) || lower(r.path).startsWith(lp + path.sep))) continue;
      if (fs.existsSync(path.join(p, 'server', 'hub.js'))) continue;   // a VideoHub install
      if (hasRenderCode(p)) { add(p, 'project', false); continue; }
      let subs = []; try { subs = fs.readdirSync(p, { withFileTypes: true }).filter(s => s.isDirectory() && !SKIP.has(s.name)); } catch { }
      if (subs.filter(s => hasRenderCode(path.join(p, s.name))).length >= 2) add(p, 'container', false);
      else if (countMp4(p) >= 3) add(p, 'media', false);
    }
  }
  return roots;
}

export function defaultThumbstudioDirs(base = baseDir()) {
  return {
    globalDir: path.join(base, 'thumbnails'),
    templatesDir: path.join(base, 'thumbnail-templates'),
    styleRefsDir: path.join(base, 'thumbnail-styles'),
  };
}

// the workspace's sub-folders (setup creates them and a README.txt that says what each is for)
export const WORKSPACE_FOLDERS = { films: 'films', outputs: 'outputs', sounds: 'sounds', thumbnails: 'thumbnails', archive: 'archive' };
// every key but the roots (roots are found once, on the very first run)
export const DEFAULTS = (base = baseDir()) => ({
  port: 7788,
  outputsDir: path.join(base, 'outputs'),
  soundLibDir: path.join(base, 'sounds'),
  archiveDir: path.join(base, 'archive'),
  studioDir: null,
  skipFolders: DEFAULT_SKIP_FOLDERS,
  maxParallelRenders: 1,
  secondRenderMinFreeMB: 8000,
  snapsMaxAgeDays: 14,
  tempMaxAgeDays: 14,
  bloatWarnRatio: 3,
  thumbstudio: defaultThumbstudioDirs(base),
  // render.encoder: auto | nvenc | amf | qsv | x264, passed to render scripts as VIDEOHUB_ENCODER (server/encoders.js)
  render: { encoder: 'auto' },
});
function firstRoots() {
  const films = defaultFilmsDir();
  try { fs.mkdirSync(films, { recursive: true }); } catch { }
  return [{ path: films, type: 'container', enabled: true }, ...discoverRoots()];
}

let cfg = null, savedBase = null;
export function config() {
  if (cfg) return cfg;
  const saved = readJson(FILE, null);
  savedBase = saved && typeof saved === 'object' ? saved.baseDir : null;
  // an existing config keeps every value it has; keys it lacks get the defaults. Roots are never discovered again
  // for an existing config, so an older install keeps exactly its folders.
  cfg = { ...DEFAULTS(), roots: [], ...(saved || {}) };
  if (!saved) { cfg.roots = firstRoots(); if (!process.env.VIDEOHUB_BASE_DIR) cfg.baseDir = baseDir(); }
  // older installs without an outputs setting used a Desktop folder "VideoHub <Turkish for outputs>": keep using it
  if (saved && !saved.outputsDir) { const legacy = path.join(DESKTOP, 'VideoHub çıktılar'); if (fs.existsSync(legacy)) cfg.outputsDir = legacy; }
  normalise(cfg, DEFAULTS().port);
  if (!saved) writeJson(FILE, cfg);
  return cfg;
}
// the shapes every route relies on (a "roots" that is not a list used to break every request until config.json was fixed by hand)
function normalise(c, port) {
  c.roots = (Array.isArray(c.roots) ? c.roots : []).filter(r => r && typeof r.path === 'string' && r.path)
    .map(r => ({ ...r, type: ['container', 'project', 'media'].includes(r.type) ? r.type : 'container', enabled: r.enabled !== false }));
  c.thumbstudio = { ...defaultThumbstudioDirs(), ...(c.thumbstudio && typeof c.thumbstudio === 'object' && !Array.isArray(c.thumbstudio) ? c.thumbstudio : {}) };
  c.port = /^\d{1,5}$/.test(String(c.port)) && +c.port > 0 && +c.port < 65536 ? +c.port : port;
  const r = c.render && typeof c.render === 'object' && !Array.isArray(c.render) ? c.render : {};
  c.render = { ...r, encoder: ENCODERS.includes(r.encoder) ? r.encoder : 'auto' };
  return c;
}
export function saveConfig(patch) {
  const prev = config(); if (!patch || typeof patch !== 'object' || Array.isArray(patch)) patch = {};
  if ('roots' in patch && !Array.isArray(patch.roots)) { const { roots, ...rest } = patch; patch = rest; }   // not a list: keep the folders there are
  if ('baseDir' in patch) { const { baseDir: b, ...rest } = patch; patch = rest; }   // the workspace is chosen in setup only (it never moves folders)
  if (patch.render && typeof patch.render === 'object') patch = { ...patch, render: { ...prev.render, ...patch.render } };
  cfg = normalise({ ...prev, ...patch }, prev.port); writeJson(FILE, cfg); return cfg;
}
