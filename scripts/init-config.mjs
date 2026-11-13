// Setup's helper for data/config.json: setup.ps1 asks the questions, this file decides and writes (so the logic lives
// next to server/config.js and is unit-tested in scripts/init-config.test.js). It never moves or deletes a folder,
// never overwrites a value an existing config.json has and never replaces a config it cannot read.
//
//   node scripts/init-config.mjs --state                      what is decided already, the defaults, folders found (JSON)
//   node scripts/init-config.mjs --check <folder>             can this folder be the workspace? {ok, why}
//   node scripts/init-config.mjs --detect [--refresh]         encoders this PC can use (server/encoders.js, cached)
//   node scripts/init-config.mjs [--workspace <folder>] [--watch <folder>]... [--encoder auto|nvenc|amf|qsv|x264]
//                                [--dry-run]                  write config.json (+ create the workspace folders)
//   node scripts/init-config.mjs --example                    copy examples\hello-film into the films folder (once)
//   --data <folder>  another data folder than <VideoHub>\data (tests)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, DEFAULT_BASE, WORKSPACE_FOLDERS, discoverRoots } from '../server/config.js';
import { ENCODERS, detectEncoders } from '../server/encoders.js';

export const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const low = p => path.resolve(p).toLowerCase();
const inside = (c, p) => low(c) === low(p) || low(c).startsWith(low(p).replace(/[\\/]$/, '') + path.sep);
const WIN = process.platform === 'win32';   // Linux (a RunPod pod): /workspace/videohub and other absolute paths

export const README = `This is your VideoHub workspace: everything VideoHub makes lives here.

films        your film projects, one folder per film (Claude Code builds new films here)
outputs      every finished render, one folder per day (hard links: no extra disk space)
sounds       your own music beds and sound effects, for "Add sound" in the review timeline
thumbnails   thumbnails that do not belong to one film (Thumbnail Studio)
archive      old versions moved here by Disk cleanup instead of being deleted

VideoHub never deletes anything here by itself. Settings > Folders shows and changes each folder.
`;

// null when the folder can be the workspace, else why not (plain words for setup)
export function checkWorkspace(p, hubDir = HUB) {
  if (typeof p !== 'string' || !p.trim()) return 'Type a folder, for example D:\\Videos\\VideoHub.';
  p = p.trim().replace(/^"(.*)"$/, '$1');
  if (!WIN && !p.startsWith('/')) return 'Type a full path that starts with /, for example /workspace/videohub.';
  if (!WIN && path.resolve(p) === '/') return 'Pick a folder, not the whole disk (for example /workspace/videohub).';
  if (WIN && !/^([a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(p)) return 'Type a full path that starts with a drive letter, for example D:\\Videos\\VideoHub.';
  const r = path.resolve(p);
  if (WIN && path.parse(r).root.toLowerCase() === (r.endsWith('\\') ? r : r + '\\').toLowerCase()) return 'Pick a folder, not a whole drive (for example ' + r.replace(/\\?$/, '\\') + 'VideoHub).';
  if (inside(r, hubDir)) return 'Pick a folder outside the VideoHub program folder (updates replace that folder).';
  let a = r; while (!fs.existsSync(a)) { const up = path.dirname(a); if (up === a) return 'The drive ' + path.parse(r).root + ' does not exist on this PC.'; a = up; }
  try { if (!fs.statSync(a).isDirectory()) return a === r ? 'That is a file, not a folder.' : a + ' is a file, not a folder.'; } catch { return 'That folder cannot be read.'; }
  return null;
}

function readSaved(file) {
  if (!fs.existsSync(file)) return { saved: null };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object'); return { saved: j }; }
  catch (e) { return { saved: null, error: `${file} is not readable JSON (${e.message}); it was left as it is. Fix or rename it, then run setup again.` }; }
}

// what is decided already (a re-run shows it and keeps it) and what setup would suggest
export function state({ dataDir = path.join(HUB, 'data'), discover = discoverRoots } = {}) {
  const file = path.join(dataDir, 'config.json'), { saved, error } = readSaved(file);
  const ws = saved ? (saved.baseDir || DEFAULT_BASE()) : null;
  let found = []; try { found = discover(); } catch { }
  const known = (saved?.roots || []).map(r => r && r.path).filter(Boolean);
  return { file, installed: !!saved || !!error, error: error || null, workspace: ws, workspaceExplicit: !!saved?.baseDir, defaultWorkspace: DEFAULT_BASE(),
    encoder: saved?.render?.encoder || null, watched: known, discovered: saved ? [] : found.map(r => ({ path: r.path, type: r.type })) };
}

// write/complete config.json. Returns what it did (or would do, with dryRun) as plain sentences in `actions`.
export function initConfig({ dataDir = path.join(HUB, 'data'), hubDir = HUB, workspace = null, watch = [], encoder = null, dryRun = false, discover = discoverRoots } = {}) {
  const file = path.join(dataDir, 'config.json'), { saved, error } = readSaved(file), actions = [];
  if (error) throw new Error(error);
  if (encoder != null && !ENCODERS.includes(encoder)) throw new Error('encoder: ' + ENCODERS.join(' | '));
  const W = (m) => actions.push((dryRun ? 'would ' : '') + m);
  let cfg, ws, changed = false;
  if (saved) {
    // installed: the workspace and every value stay; only keys that are missing are added
    ws = saved.baseDir || DEFAULT_BASE(); cfg = { ...saved };
    actions.push(`kept the workspace ${ws}` + (workspace && low(workspace) !== low(ws) ? ` (${workspace} was not used: the workspace is already set; change single folders in Settings)` : ''));
    if (!cfg.render || typeof cfg.render !== 'object' || !cfg.render.encoder) { cfg.render = { ...(cfg.render || {}), encoder: encoder || 'auto' }; changed = true; W(`set the render encoder to ${cfg.render.encoder}`); }
    else actions.push(`kept the render encoder ${cfg.render.encoder}`);
    const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
    const add = watch.filter(w => w && !roots.some(r => r && typeof r.path === 'string' && low(r.path) === low(w)));
    if (add.length) { cfg.roots = [...roots, ...add.map(w => ({ path: path.resolve(w), type: 'container', enabled: true }))]; changed = true; for (const w of add) W(`watch ${w}`); }
  } else {
    ws = path.resolve(workspace || DEFAULT_BASE());
    const why = checkWorkspace(ws, hubDir); if (why) throw new Error(why);
    let found = []; try { found = discover(); } catch { }
    found = found.filter(r => !inside(r.path, ws));
    const on = new Set(watch.map(low)), films = path.join(ws, WORKSPACE_FOLDERS.films);
    const extra = watch.filter(w => !found.some(r => low(r.path) === low(w))).map(w => ({ path: path.resolve(w), type: 'container', enabled: true }));
    cfg = { ...DEFAULTS(ws), baseDir: ws, render: { encoder: encoder || 'auto' },
      roots: [{ path: films, type: 'container', enabled: true }, ...found.map(r => ({ path: r.path, type: r.type, enabled: on.has(low(r.path)) })), ...extra] };
    changed = true;
    W(`use the workspace ${ws}`);
    for (const r of cfg.roots.slice(1)) if (r.enabled) W(`also watch ${r.path}`);
    W(`set the render encoder to ${cfg.render.encoder}`);
  }
  // the workspace folders and its README (created when missing; nothing that exists is touched)
  const dirs = saved ? [] : [ws, ...Object.values(WORKSPACE_FOLDERS).map(f => path.join(ws, f))].filter(d => !fs.existsSync(d));
  const readme = path.join(ws, 'README.txt'), wantReadme = !saved && !fs.existsSync(readme);
  for (const d of dirs) W(`create ${d}`);
  if (wantReadme) W(`write ${readme}`);
  if (changed) W(`write ${file}`);
  if (!dryRun) {
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    if (wantReadme) fs.writeFileSync(readme, README.replace(/\n/g, '\r\n'), { flag: 'wx' });
    if (changed) { fs.mkdirSync(dataDir, { recursive: true }); const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 1)); fs.renameSync(tmp, file); }
  }
  return { file, existed: !!saved, workspace: ws, encoder: cfg.render.encoder, roots: cfg.roots, wrote: changed && !dryRun, dryRun, actions };
}

// ---------- command line (setup.ps1)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), val = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const all = k => a.flatMap((x, i) => x === k && a[i + 1] != null ? [a[i + 1]] : []);
  const dataDir = path.resolve(val('--data') || path.join(HUB, 'data'));
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  // --help, or an option this script does not know: say how it is used and write nothing (a typo must never create folders)
  const KNOWN = new Set(['--state', '--check', '--detect', '--refresh', '--ffmpeg', '--workspace', '--watch', '--encoder', '--dry-run', '--example', '--data']);
  const bad = a.filter(x => x.startsWith('-') && !KNOWN.has(x));
  if (bad.length) {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => /^\/\/ {3}(node |--| {20,})/.test(l)).map(l => l.slice(3));
    process.stderr.write((bad.some(x => x !== '--help' && x !== '-h') ? 'Unknown option: ' + bad.join(' ') + '\n' : '') + 'Usage:\n' + head.join('\n') + '\n');
    process.exit(bad.every(x => x === '--help' || x === '-h') ? 0 : 2);
  }
  try {
    if (a.includes('--state')) out(state({ dataDir }));
    else if (a.includes('--check')) { const why = checkWorkspace(val('--check') || ''); out({ ok: !why, why }); }
    else if (a.includes('--detect')) out(await detectEncoders({ cacheFile: a.includes('--dry-run') ? null : path.join(dataDir, 'encoders.json'), refresh: a.includes('--refresh'), ffmpeg: val('--ffmpeg') || 'ffmpeg' }));
    // the example film, the same copy as the Welcome panel's button (server/example.js); never twice
    else if (a.includes('--example')) { const ex = await import('../server/example.js'), i = ex.info(); out(i.installed ? { ...i, kept: true } : ex.install()); }
    else out(initConfig({ dataDir, workspace: val('--workspace'), watch: all('--watch'), encoder: val('--encoder'), dryRun: a.includes('--dry-run') }));
  } catch (e) { out({ error: e.message }); process.exit(1); }
}
