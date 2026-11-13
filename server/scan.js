// Finds every video project under the configured roots and works out what each file is.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, DEFAULT_SKIP_FOLDERS } from './config.js';
import { outputsDir } from './ciktilar-dir.js';
import { invalidateSource } from './source-revision.js';
import { readNotes, readMeta, isOpenNote } from './legacy.js';
import { DATA_DIR, idOf, readJson, writeJson, probe, flushProbeCache, fingerprint, pLimit, shortPath, run, TOOLS, now } from './util.js';

const VIDEO = /\.(mp4|mov|webm|mkv)$/i, IMAGE = /\.(jpe?g|png|webp)$/i, AUDIO = /\.(wav|mp3|m4a|flac|aac|ogg)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.videohub-trash']);
const INDEX = path.join(DATA_DIR, 'index.json');

// ---------- what a single file is
function category(rel, name) {
  const r = '\\' + rel.toLowerCase().replace(/\//g, '\\');   // one slash style (Linux paths use /)
  if (/\\render\\profiles\\|\\profiles\\w\d|\\chrome-profile/.test(r)) return 'profile';
  if (/\\chunks_(prev|v\d)[^\\]*\\/.test(r)) return 'oldChunk';
  if (/\\chunks\\/.test(r) || /^c_\d{3,}\.mp4$/i.test(name)) return 'chunk';
  if (/\.tmp\.mp4$/i.test(name) || /\\render\\tmp\\|\\\.render\\/.test(r)) return 'part';
  // make.mjs writes part.mp4; preview_silent / video_silent are the picture before the sound is laid on
  if (VIDEO.test(name) && /^(part\d*|seg_.+|(preview|video)_silent)\.(mp4|webm)$/i.test(name)) return 'part';
  if (IMAGE.test(name) && /\\(snaps|qa|sheets?|shots|frames[^\\]*|contact)\\/.test(r)) return 'snap';
  if (VIDEO.test(name)) return 'output';
  if (AUDIO.test(name)) return 'audio';
  return 'other';
}

// lets the hub answer requests in between: a project with 50k+ files once froze VideoHub for ~20 s
export const breather = () => new Promise(r => setImmediate(r));
async function walk(dir) {
  const files = []; const stack = [dir]; let n = 0;
  const outs = path.resolve(outputsDir()).toLowerCase();   // the global outputs folder (hard links of renders): never a project or a duplicate
  const globalThumb = path.resolve(config().thumbstudio?.globalDir || '').toLowerCase();
  while (stack.length) {
    const d = stack.pop(); let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++n >= 300) { n = 0; await breather(); }
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && path.resolve(p).toLowerCase() !== outs && (!globalThumb || path.resolve(p).toLowerCase() !== globalThumb)) stack.push(p); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      const rel = path.relative(dir, p);
      files.push({ path: p, rel, name: e.name, size: st.size, mtime: st.mtimeMs, cat: category(rel, e.name) });
    }
  }
  return files;
}

// ---------- how the project renders (read from its render script)
function renderInfo(dir) {
  const info = { family: null, fps: null, chunkFrames: null, chunkSec: null, supportsOnly: false, script: null, w: null, h: null };
  const script = ['render.js', 'render.mjs', 'render.py'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  const man = readJson(path.join(dir, 'render', 'manifest.json'));
  if (script) {
    info.script = path.basename(script);
    let src = ''; try { src = fs.readFileSync(script, 'utf8'); } catch { }
    const num = re => { const m = src.match(re); return m ? +m[1] : null; };
    info.fps = num(/\bFPS\s*=\s*(?:\+?\(?\s*process\.env\.FPS\s*\|\|\s*)?(\d+)/);
    info.chunkFrames = num(/\bCH\s*=\s*(\d+)/);
    info.supportsOnly = /process\.env\.ONLY\b/.test(src);
    info.w = num(/\bVW\s*=\s*(\d+)/); info.h = num(/\bVH\s*=\s*(\d+)/);
    if (info.chunkFrames && /chunks/.test(src)) info.family = 'A';
    else if (/seg_/.test(src)) info.family = 'C';
    else if (/part\$\{w\}|part\{w\}|\/part\$\{/.test(src)) info.family = 'B';
    else info.family = 'code';
    if (info.fps && info.chunkFrames) info.chunkSec = info.chunkFrames / info.fps;
  }
  if (man) Object.assign(info, { fps: man.fps ?? info.fps, chunkFrames: man.chunkFrames ?? info.chunkFrames, chunkSec: man.chunkSec ?? info.chunkSec, w: man.width ?? info.w, h: man.height ?? info.h, family: man.family || info.family, manifest: true });
  return info;
}

// ---------- do two videos show the same picture? (16x9 grey thumbnails at 3 points, cached)
const SIM_FILE = path.join(DATA_DIR, 'similar-cache.json');
const simCache = readJson(SIM_FILE, {});
async function tinyFrame(file, t) {
  const r = await new Promise(res => {
    const p = spawn(TOOLS.ffmpeg, ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'], { windowsHide: true });
    const bufs = []; p.stdout.on('data', b => bufs.push(b)); p.on('close', () => res(Buffer.concat(bufs))); p.on('error', () => res(Buffer.alloc(0)));
  });
  return r.length === 144 ? r : null;
}
async function samePicture(a, b) {
  const key = [a.path, a.size, Math.round(a.mtime), b.path, b.size, Math.round(b.mtime)].join('|').toLowerCase();
  if (key in simCache) return simCache[key];
  let same = true;
  for (const f of [0.25, 0.5, 0.75]) {
    const t = Math.min(a.info.dur, b.info.dur) * f;
    const [x, y] = await Promise.all([tinyFrame(a.path, t), tinyFrame(b.path, t)]);
    if (!x || !y) { same = false; break; }
    let d = 0; for (let i = 0; i < 144; i++) d += Math.abs(x[i] - y[i]);
    if (d / 144 > 10) { same = false; break; }
  }
  simCache[key] = same; writeJson(SIM_FILE, simCache);
  return same;
}

// ---------- roles of finished videos
function roleOf(o) {
  const n = o.name.toLowerCase();
  if (!o.info?.ok) return 'broken';
  if (!o.info.audio) return 'silent';
  if (/[_\- ]web\b|_web\./.test(n)) return 'web';
  if (/preview|_prev\b|\u00f6nizleme|onizleme|draft|taslak/.test(n)) return 'preview';   // (Turkish file names too)
  return 'final';
}

// Short test renders and QA clips (e.g. 3-second checks in qa\ with sound) are not films: they must never
// become the project's last video, the name of the next version or the sound source of a partial render.
// A voiced file is a "clip" when it is under half the film's length, sits in a test folder or is named like one —
// unless VideoHub registered it as a version (versions.json), which is always a film.
const CLIP_DIRS = /\\(qa|lookdev|tests?|tmp|temp|debug|bench|clips?|scratch|previews?|probe)\\/i;
const CLIP_NAME = /(^|[_\-. ])(test|clip|qa|probe|bench|debug)([_\-. \d]|$)/i;
function markClips(outs, filmDur, registered) {
  for (const o of outs) {
    if (!['final', 'web', 'preview'].includes(o.role) || registered.has(o.rel.toLowerCase())) continue;
    const short = filmDur >= 20 && (o.info.dur || 0) < filmDur * 0.5;
    if (short || CLIP_DIRS.test('\\' + o.rel) || CLIP_NAME.test(o.name.replace(/\.[^.]+$/, ''))) o.role = 'clip';
  }
}
// the newest film; files written within 2 min of each other (a copy, a touched file) go by version number
function newestFilm(films, vOf) {
  if (!films.length) return null;
  const top = Math.max(...films.map(o => o.mtime));
  return films.filter(o => o.mtime >= top - 120e3).sort((a, b) => (vOf(b) - vOf(a)) || (b.mtime - a.mtime))[0];
}

function baseName(file) {
  let b = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
  for (let i = 0; i < 6; i++) b = b.replace(/[_\- ](v\d+|web|final|master|1080p|2160p|4k|16x9|9x16|\d+fps|hq|hd|preview|prev)$/, '');
  return b;
}

const autoStatusOf = finals => !finals.length ? 'in-progress' : (Date.now() - finals[0].mtime > 7 * 864e5 ? 'done' : 'review');   // finals newest first
async function describe(project) {
  const files = await walk(project.path);
  if (project.outDir) for (const f of await walk(project.outDir)) files.push({ ...f, rel: path.join('out', f.rel) });   // a studio scene renders into out/<name>
  const sizes = { total: 0, output: 0, chunk: 0, oldChunk: 0, part: 0, profile: 0, snap: 0, audio: 0, other: 0 };
  for (const f of files) { sizes.total += f.size; sizes[f.cat] = (sizes[f.cat] || 0) + f.size; }
  const outs = files.filter(f => f.cat === 'output');
  await pLimit(outs, 4, async o => { o.info = await probe(o.path, { size: o.size, mtimeMs: o.mtime }); });
  for (const o of outs) o.role = roleOf(o);
  // a silent file is only an intermediate when a voiced output shows the same picture:
  // same size, same length, and matching tiny frames at 25/50/75 %
  const voiced = outs.filter(o => o.info?.audio);
  for (const o of outs) {
    if (o.role !== 'silent') continue;
    const cands = voiced.filter(v => v.info.w === o.info.w && v.info.h === o.info.h && Math.abs(v.info.dur - o.info.dur) <= 1.5)
      .sort((a, b) => Math.abs(a.info.dur - o.info.dur) - Math.abs(b.info.dur - o.info.dur));
    for (const v of cands) if (await samePicture(o, v)) { o.coveredBy = v.rel; break; }
  }
  const meta = readMeta(path.join(project.path, '.videohub', 'project.json'), {});
  const notes = readNotes(path.join(project.path, '.videohub', 'notes.json'));
  const versions = readJson(path.join(project.path, '.videohub', 'versions.json'), []);
  // the film's length: render manifest, the saved DUR, or the longest voiced video
  const vByRel = new Map(versions.filter(v => v.file).map(v => [String(v.file).toLowerCase(), v.v || 0]));
  const filmDur = Math.max(0, +readJson(path.join(project.outDir || project.path, 'render', 'manifest.json'))?.dur || 0, +meta.render?.env?.DUR || 0,
    ...outs.filter(o => o.info?.ok && o.info.audio).map(o => o.info.dur || 0));
  markClips(outs, filmDur, new Set(vByRel.keys()));
  outs.sort((a, b) => b.mtime - a.mtime);
  const vOf = o => vByRel.get(o.rel.toLowerCase()) || 0;
  const finals = outs.filter(o => o.role === 'final');
  const latest = newestFilm(finals, vOf) || newestFilm(outs.filter(o => o.role === 'web'), vOf)
    || newestFilm(outs.filter(o => o.role === 'preview'), vOf) || null;   // never a clip, part or silent file (a 3 s test clip once became a film's "last video")
  // a studio scene renders into out/<scene>: its chunk layout (fps, 2 s chunks) is in the manifest make.mjs writes there
  const ri = project.rootType === 'media' ? { family: project.family } : renderInfo(project.studio ? project.outDir : project.path);
  const manifest = readJson(path.join(project.path, 'manifest.json'));
  let family = project.family || ri.family;
  if (manifest && (manifest.anim || manifest.voice || manifest.video)) family = 'otomasyon';   // a text-to-video pipeline's project (family id kept for compatibility)
  if (files.some(f => /\.snipp$/i.test(f.name)) && !ri.script) family = family || 'snipp';

  const updated = files.reduce((m, f) => Math.max(m, f.mtime), 0);
  // without a status set by the user: a final older than a week counts as finished
  const autoStatus = autoStatusOf(finals);
  const latestFinal = latest && latest.role === 'final' ? latest : finals[0];
  const status = meta.status || autoStatus;
  return {
    ...project,
    title: meta.title || manifest?.title || project.name,
    family: family || 'other',
    render: ri,
    status, statusAuto: !meta.status, meta,
    sizes,
    outputs: outs.map(o => ({ path: o.path, rel: o.rel, name: o.name, size: o.size, mtime: o.mtime, role: o.role, coveredBy: o.coveredBy || null, ...(o.info || {}) })),
    latest: latest ? latest.rel : null,
    filmDur: filmDur || null,
    finalSize: latestFinal?.size || latest?.size || 0,
    notesOpen: notes.filter(isOpenNote).length,
    notesTotal: notes.length,
    versions: versions.length,
    counts: { chunks: files.filter(f => f.cat === 'chunk').length, snaps: files.filter(f => f.cat === 'snap').length, files: files.length },
    updated,
  };
}

// ---------- projects under the roots
// a studio: one engine for many scenes: scenes/<name>/scene.js, engine/index.html?scene=<name>, renders in out/<name>
const isStudio = d => fs.existsSync(path.join(d, 'make.mjs')) && fs.existsSync(path.join(d, 'scenes')) && fs.existsSync(path.join(d, 'engine', 'index.html'));
function studioScenes(d, mk) {
  let names = []; try { names = fs.readdirSync(path.join(d, 'scenes'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(d, 'scenes', e.name, 'scene.js'))).map(e => e.name); } catch { }
  return names.map(n => mk(path.join(d, 'scenes', n), n, { studio: d, outDir: path.join(d, 'out', n), family: 'studio' }));
}
// Is a folder without any video still a video project? (Without this check about half of the listed "projects" had no
// video: editor sources, voice/transcript steps of pipelines, text-only and picture-only folders, engines, backups.)
// Yes when VideoHub can play or render it (render script, make.mjs, a page, a .snipp, at the top or one folder down),
// when it is a film being started (STATE.md) or when the user left notes on it.
const FILM_MARK = /^(render\.(m?js|py)|make\.mjs|index\.html|.*\.snipp|STATE\.md)$/i;
const NOT_INSIDE = /^(node_modules|render|out|output|audio|snaps.*|qa|frames?|\.git|\.videohub|chunks.*)$/i;
function filmKind(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const has = (list) => list.some(e => e.isFile() && FILM_MARK.test(e.name));
  if (has(ents)) return ents.some(e => /^(render\.(m?js|py)|make\.mjs|index\.html)$/i.test(e.name)) ? 'code' : ents.some(e => /\.snipp$/i.test(e.name)) ? 'snipp' : 'started';
  for (const e of ents) {
    if (!e.isDirectory() || NOT_INSIDE.test(e.name)) continue;
    let sub = []; try { sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }); } catch { continue; }
    if (has(sub)) return 'code';
  }
  if (fs.existsSync(path.join(dir, '.videohub', 'notes.json'))) return 'notes';
  return null;
}
// projects the user removed from the list (Settings → Hidden projects brings them back)
export const hideKey = p => (p.path + (p.group ? '#' + p.group : '')).toLowerCase();
const hiddenKeys = () => new Set((config().hiddenProjects || []).map(h => h.key));
// what an empty card says
const EMPTY = { studio: 'no render yet · live preview available', code: 'no video · has code (not rendered yet, or its video was deleted)', snipp: 'Snipp project · no video yet', started: 'new film · no code or video yet', notes: 'no video yet' };

function projectsIn(root) {
  const out = []; const rp = root.path;
  const globalThumb = path.resolve(config().thumbstudio?.globalDir || '').toLowerCase();
  // helper folders next to films (config.skipFolders): never projects unless they have their own render script
  const skip = new Set((Array.isArray(config().skipFolders) ? config().skipFolders : DEFAULT_SKIP_FOLDERS).map(s => String(s).toLowerCase()));
  const mk =(p, name, extra = {}) => ({ id: idOf(p + (extra.group ? '#' + extra.group : '')), name, path: p, root: rp, rootType: root.type, ...extra });
  let ents = []; try { ents = fs.readdirSync(rp, { withFileTypes: true }); } catch { return out; }
  if (root.type !== 'media' && isStudio(rp)) return studioScenes(rp, mk);
  if (root.type === 'project') return [mk(rp, path.basename(rp))];
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.') || (root.type === 'container' && e.name.startsWith('_'))) continue;   // _engine, _backup: helpers
    const p = path.join(rp, e.name);
    if (globalThumb && path.resolve(p).toLowerCase() === globalThumb) continue;
    let inner = []; try { inner = fs.readdirSync(p); } catch { continue; }
    if (inner.length === 0) continue;
    if (root.type === 'container' && skip.has(e.name.toLowerCase()) && !inner.some(f => /^render\.(m?js|py)$/.test(f))) continue;
    if (root.type !== 'media' && isStudio(p)) { out.push(...studioScenes(p, mk)); continue; }
    out.push(mk(p, e.name, root.type === 'media' ? { family: inner.some(f => /\.snipp$/i.test(f)) ? 'snipp' : 'media' } : {}));
  }
  if (root.type === 'media') {
    // loose videos in the root, grouped by their base name (film_v2.mp4 + film_web.mp4 = one film)
    const loose = ents.filter(e => e.isFile() && VIDEO.test(e.name));
    const groups = new Map();
    for (const e of loose) { const b = baseName(e.name); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(e.name); }
    for (const [b, names] of groups) out.push(mk(rp, b, { group: b, groupFiles: names, family: ents.some(e => e.name.toLowerCase().startsWith(b) && /\.snipp$/i.test(e.name)) ? 'snipp' : 'media' }));
  }
  return out;
}

async function describeGroup(p) {
  // loose files of a media root: describe only the files in the group
  const files = p.groupFiles.map(n => { const f = path.join(p.path, n); const st = fs.statSync(f); return { path: f, rel: n, name: n, size: st.size, mtime: st.mtimeMs, cat: 'output' }; });
  await pLimit(files, 4, async o => { o.info = await probe(o.path, { size: o.size, mtimeMs: o.mtime }); o.role = roleOf(o); });
  files.sort((a, b) => b.mtime - a.mtime);
  const total = files.reduce((s, f) => s + f.size, 0), latest = files.find(f => f.role === 'final') || files[0];
  return { ...p, title: p.name, render: { family: p.family }, status: 'published', meta: {}, sizes: { total, output: total }, outputs: files.map(o => ({ path: o.path, rel: o.rel, name: o.name, size: o.size, mtime: o.mtime, role: o.role, coveredBy: null, ...(o.info || {}) })), latest: latest?.rel, finalSize: latest?.size || 0, notesOpen: 0, notesTotal: 0, versions: 0, counts: { files: files.length }, updated: files[0]?.mtime || 0 };
}

let state = { scanning: false, at: null, projects: readJson(INDEX, { projects: [] }).projects || [], dups: [] };
const listeners = new Set();
export const onScan = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = ev => { for (const fn of listeners) try { fn(ev); } catch { } };

export function index() { return state; }
export function project(id) { return state.projects.find(p => p.id === id) || null; }

// ---------- incremental (soft) scans
// A full scan walks every root (~30k files, ~7 s). Soft scans (a window opening, every 10 min) re-describe only the
// projects a root watcher saw change; new and removed project folders still come from projectsIn (cheap). A root is
// walked in full at hub start, on the manual refresh, after a config change or a cleanup, and whenever its watcher is
// new, overflowed (no file name) or failed.
const watchers = new Map();    // lower-case root path -> { w, root, whole, full, all, dirty: Set of keys, at: key -> when it was last described }
const described = new Map();   // project id -> { d, base }: every described project (also the ones the list leaves out)
const VH_KEEP = /^(notes|versions|project)\.json$/i;   // .videohub files a card shows (counts, title, status)
const lc = p => path.resolve(p).toLowerCase();
const wholeRoot = r => r.type === 'project' || (r.type !== 'media' && isStudio(r.path));
// which part of a root a project lives in: its first folder below the root ('' = the root itself: loose media, whole roots)
const keyIn = (rec, p) => rec.whole ? '' : (path.relative(rec.root.path, p.path).split(/[\\/]/)[0] || '').toLowerCase();
const baseOf = p => JSON.stringify([p.path, p.group, p.groupFiles, p.studio, p.outDir, p.rootType, p.family]);
function watchRoot(root) {
  const rec = { w: null, root, whole: wholeRoot(root), full: true, all: false, dirty: new Set(), at: new Map() };
  const skipUnder = [outputsDir(), config().thumbstudio?.globalDir].filter(Boolean).map(d => lc(d) + path.sep);
  const onEvent = (ev, name) => {
    if (!name) { rec.all = true; return; }   // the change buffer overflowed: walk the whole root next time
    if (rec.all) return;
    const segs = String(name).toLowerCase().split(/[\\/]/).filter(Boolean);
    if (segs.some(s => SKIP_DIRS.has(s))) return;
    const vh = segs.indexOf('.videohub'); if (vh >= 0 && (vh !== segs.length - 2 || !VH_KEEP.test(segs[vh + 1]))) return;
    const keys = rec.whole ? [''] : segs.length > 1 ? [segs[0]] : ['', segs[0]];
    if (keys.every(k => rec.dirty.has(k))) return;
    const full = path.join(root.path, String(name));
    if (skipUnder.some(d => (lc(full) + path.sep).startsWith(d))) return;
    // Windows reports files being READ as changes too (last-access time; ffprobe and thumbnails read every video):
    // a "change" counts only when the file was modified after its project was last described (that walk saw older ones)
    let m = Infinity; if (ev === 'change') try { m = fs.statSync(full).mtimeMs; } catch { }
    for (const k of keys) if (!(m < (rec.at.get(k) ?? -Infinity))) rec.dirty.add(k);
  };
  try {
    rec.w = fs.watch(root.path, { recursive: true }, onEvent);
    rec.w.on('error', () => { try { rec.w.close(); } catch { } watchers.delete(lc(root.path)); });   // the next scan walks it in full
  } catch { return null; }
  watchers.set(lc(root.path), rec); return rec;
}
function syncWatchers(roots) {
  const want = new Map(roots.map(r => [lc(r.path), r]));
  for (const [k, rec] of watchers) if (!want.has(k) || want.get(k).type !== rec.root.type) { try { rec.w.close(); } catch { } watchers.delete(k); }
  for (const [k, r] of want) if (!watchers.has(k)) watchRoot(r);
}

let again = false;   // false | 'soft' | 'full'
export async function scan({ soft = false } = {}) {
  // a scan asked for while one runs (e.g. after a settings change) runs once more afterwards (full if any ask was full)
  if (state.scanning) { again = again === 'full' || !soft ? 'full' : 'soft'; return state; }
  try { return await scanOnce(soft); } finally { if (again) { const s = again === 'soft'; again = false; setTimeout(() => scan({ soft: s }).catch(() => { }), 50); } }
}
async function scanOnce(soft) {
  state.scanning = true; emit({ type: 'scan', phase: 'start', soft });
  const t0 = Date.now();
  let plan = [], walked = 0;
  try {
    const roots = config().roots.filter(r => r.enabled !== false && fs.existsSync(r.path));
    syncWatchers(roots);
    // take each root's change marks now: changes seen while this scan runs count for the next one
    plan = roots.map(r => {
      const rec = watchers.get(lc(r.path)) || null, inc = !!(soft && rec && !rec.full && !rec.all), dirty = rec ? rec.dirty : null;
      if (rec) { rec.dirty = new Set(); rec.all = false; }
      if (rec && !inc) rec.at.clear();
      return { r, rec, inc, dirty, started: new Set() };
    });
    const list = plan.flatMap(x => projectsIn(x.r).map(p => ({ p, x })));
    let done = 0; walked = 0;
    const projects = await pLimit(list, 3, async ({ p, x }) => {
      const base = baseOf(p), prev = described.get(p.id);
      let d;
      if (x.inc && prev && prev.base === base && !x.dirty.has(keyIn(x.rec, p))) {
        d = { ...prev.d, outputs: prev.d.outputs.map(o => ({ ...o })) };   // a copy: the list being served stays as it is until this scan ends
        if (d.statusAuto && !d.group) d.status = autoStatusOf(d.outputs.filter(o => o.role === 'final'));   // "a week old" moves on by itself
      } else {
        if (x.rec) { const k = keyIn(x.rec, p); if (!x.started.has(k)) { x.started.add(k); x.rec.at.set(k, Date.now()); } }   // the earliest walk of this key
        d = p.groupFiles ? await describeGroup(p) : await describe(p); walked++; if (soft) invalidateSource(d);
      }
      described.set(p.id, { d, base });
      done++; if (done % 5 === 0) emit({ type: 'scan', phase: 'progress', done, total: list.length });
      return d;
    });
    for (const x of plan) if (x.rec && !x.inc) x.rec.full = false;   // walked in full once since its watcher started
    const ids = new Set(projects.map(p => p.id)); for (const id of described.keys()) if (!ids.has(id)) described.delete(id);
    flushProbeCache();
    for (const p of projects) { delete p.emptyNote; for (const o of p.outputs) delete o.dupOf; }   // reused copies: set again below
    const hidden = hiddenKeys();
    for (let i = projects.length - 1; i >= 0; i--) {
      const p = projects[i];
      if (hidden.has(hideKey(p))) { projects.splice(i, 1); continue; }
      if (p.outputs.length || p.group) continue;
      const kind = p.studio ? 'studio' : filmKind(p.path);
      if (!kind) { projects.splice(i, 1); continue; }
      p.emptyNote = EMPTY[kind];
    }
    // byte-identical copies anywhere (same size first, then a content fingerprint)
    const all = projects.flatMap(p => p.outputs.map(o => ({ o, p })));
    const bySize = new Map();
    for (const x of all) if (x.o.size > 1 << 20) { const k = x.o.size; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(x); }
    const dups = [];
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const byFp = new Map();
      for (const x of group) { let fp; try { fp = await fingerprint(x.o.path, x.o.size); } catch { continue; } if (!byFp.has(fp)) byFp.set(fp, []); byFp.get(fp).push(x); }
      for (const same of byFp.values()) if (same.length > 1) {
        same.sort((a, b) => a.o.mtime - b.o.mtime);
        dups.push({ size: same[0].o.size, files: same.map(x => ({ path: x.o.path, project: x.p.id, projectName: x.p.name })) });
        for (const x of same.slice(1)) x.o.dupOf = same[0].o.path;
      }
    }
    projects.sort((a, b) => b.updated - a.updated);
    state = { scanning: false, at: now(), ms: Date.now() - t0, soft, walked, projects, dups };
    writeJson(INDEX, { at: state.at, projects });
    emit({ type: 'scan', phase: 'done', count: projects.length, ms: state.ms, full: !soft, walked });
  } catch (e) {
    for (const x of plan) if (x.rec) x.rec.full = true;   // its change marks were taken: walk those roots in full next time
    state.scanning = false; emit({ type: 'scan', phase: 'error', error: String(e.message || e) });
    throw e;
  }
  return state;
}

// after a note change only the counts move (a full rescan walks every file of the project)
export function setNoteCounts(id, notes) {
  const p = state.projects.find(x => x.id === id); if (!p || p.groupFiles) return;
  p.notesOpen = notes.filter(isOpenNote).length; p.notesTotal = notes.length;
  emit({ type: 'notes', id });
}

// a project leaves the list at once (hidden, or its folder went to the Recycle Bin)
export function dropProject(id) {
  state.projects = state.projects.filter(x => x.id !== id);
  writeJson(INDEX, { at: state.at, projects: state.projects });
  emit({ type: 'scan', phase: 'done', count: state.projects.length, ms: 0 });
}

export async function rescanProject(id) {
  const p = project(id); if (!p) return null;
  const base = { id: p.id, name: p.name, path: p.path, root: p.root, rootType: p.rootType, family: p.rootType === 'media' || p.studio ? p.family : undefined, group: p.group, groupFiles: p.groupFiles, studio: p.studio, outDir: p.outDir };   // a studio scene keeps its out<name> folder (dropping it hid all its videos after every render job)
  const d = p.groupFiles ? await describeGroup(base) : await describe(base);
  flushProbeCache(); invalidateSource(p);
  if (described.has(id)) described.set(id, { d, base: described.get(id).base });   // a soft scan reuses this one
  state.projects = state.projects.map(x => x.id === id ? d : x);
  writeJson(INDEX, { at: state.at, projects: state.projects });
  emit({ type: 'project', id });
  return d;
}

// ---------- thumbnails (cached by file + mtime)
const THUMBS = path.join(DATA_DIR, 'thumbs');
// at most two ffmpeg processes for thumbnails at a time (keeps RAM free for renders), one job per file
let thumbSlots = 2; const thumbWait = []; const thumbInflight = new Map();
const thumbAcquire = () => thumbSlots > 0 ? (thumbSlots--, Promise.resolve()) : new Promise(r => thumbWait.push(r));
const thumbRelease = () => { const n = thumbWait.shift(); n ? n() : thumbSlots++; };
export async function thumbnail(p) {
  const usable = x => x.ok !== false && x.role !== 'broken' && fs.existsSync(x.path);
  const o = p.outputs.find(x => x.rel === p.latest && usable(x)) || p.outputs.filter(usable).sort((a, b) => b.mtime - a.mtime)[0];
  if (!o) return null;
  const st = fs.statSync(o.path);
  const file = path.join(THUMBS, p.id + '-' + idOf(o.path) + '-' + st.size + '-' + Math.round(st.mtimeMs) + '.jpg');
  if (fs.existsSync(file) && fs.statSync(file).size) return file;
  if (thumbInflight.has(file)) return thumbInflight.get(file);
  const job = (async () => {
    await thumbAcquire();
    try {
      fs.mkdirSync(THUMBS, { recursive: true });
      const t = Math.max(0, Math.min((o.dur || 0) * 0.3, (o.dur || 1) - 0.5));
      let r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', o.path, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', file], { timeout: 12000 });
      if (r.code !== 0 || !fs.existsSync(file) || !fs.statSync(file).size)
        r = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', o.path, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', file], { timeout: 12000 });
      return fs.existsSync(file) && fs.statSync(file).size ? file : null;
    } finally { thumbRelease(); thumbInflight.delete(file); }
  })();
  thumbInflight.set(file, job);
  return job;
}

export const describeLabel = p => shortPath(p.path) + (p.group ? ' · ' + p.group : '');
