// Finds what can go, explains why, and removes it reversibly:
// deletions go to the Recycle Bin (on Linux: the workspace's trash folder), old versions are moved to the archive folder. Nothing is hard-deleted.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, baseDir } from './config.js';
import { index } from './scan.js';
import * as jobs from './jobs.js';
import { guardState } from './guard.js';
import { DATA_DIR, TEMP, IS_WIN, powershell, fingerprint, processAlive, shortPath, writeJson, now, isInside } from './util.js';

const DONE = new Set(['approved', 'published', 'archived', 'done']);
// Presets for "Clean render leftovers in all projects" (each candidate carries one):
//   safe : never needed again — replaced chunks (chunks_v*, chunks_prev*), Chrome profiles and temp files, half-written
//          parts, QA/lookdev/preview pictures and clips older than QA_DAYS, silent duplicates, previews older than the final
//   deep : safe + recent QA, old versions (moved to the archive) and the chunks of finished/approved films
//          (a partial re-render of those is no longer possible)
// Chunks of films still in review are never offered: partial re-renders need them.
const QA_DAYS = 3;
const QA_DIRS = ['snaps', 'qa', 'shots', 'sheets', 'lookdev', 'previews', 'bench', 'compare'];
const MEDIA = /\.(png|jpe?g|webp|bmp|gif|mp4|mov|webm|mkv|avi)$/i;
const LOG = path.join(DATA_DIR, 'janitor-log.jsonl');

// yields every 300 entries so the hub keeps answering while big folders are measured
const breather = () => new Promise(r => setImmediate(r));
async function dirSize(dir) {
  let total = 0, newest = 0, n = 0; const stack = [dir];
  while (stack.length) {
    const d = stack.pop(); let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++n >= 300) { n = 0; await breather(); }
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { const st = fs.statSync(p); total += st.size; newest = Math.max(newest, st.mtimeMs); } catch { } }
    }
  }
  return { size: total, newest };
}
// pictures and clips in a QA folder: the whole folder when it holds nothing else; otherwise its media-only
// sub-folders as one item each plus the loose media files (a qa folder may also keep .py/.json check scripts)
async function mediaIn(dir) {
  const r = { size: 0, newest: 0, onlyMedia: true, files: [] }; let n = 0;
  const ents = await (async () => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })();
  for (const e of ents) {
    if (++n >= 300) { n = 0; await breather(); }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await mediaIn(p); r.size += sub.size; r.newest = Math.max(r.newest, sub.newest);
      if (sub.onlyMedia) { if (sub.size) r.files.push({ path: p, dir: true, size: sub.size }); } else { r.onlyMedia = false; r.files.push(...sub.files); }
      continue;
    }
    if (!MEDIA.test(e.name)) { r.onlyMedia = false; continue; }
    try { const st = fs.statSync(p); r.size += st.size; r.newest = Math.max(r.newest, st.mtimeMs); r.files.push({ path: p, dir: false, size: st.size }); } catch { }
  }
  return r;
}
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const cid = s => crypto.createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 10);

// a project with a render running right now is left alone
function busyWhy(p) {
  if (jobs.list().some(j => j.project === p.id && (j.state === 'running' || j.state === 'queued'))) return 'a render is in the VideoHub queue';
  try { const g = guardState(); if (g.running && (g.renders || []).some(r => [r.project, r.dir, r.cwd, r.path].some(x => typeof x === 'string' && x && (isInside(x, p.path) || isInside(p.path, x))))) return 'currently rendering'; } catch { }
  for (const f of [path.join('render', 'log.txt'), 'render.log', 'render_log.txt']) { try { if (Date.now() - fs.statSync(path.join(p.path, f)).mtimeMs < 10 * 60e3) return 'render log updated in the last 10 minutes'; } catch { } }
  try { if (fs.readdirSync(path.join(p.outDir || p.path, 'render', 'chunks')).some(f => f.endsWith('.tmp.mp4') && Date.now() - fs.statSync(path.join(p.outDir || p.path, 'render', 'chunks', f)).mtimeMs < 10 * 60e3)) return 'unfinished render chunk found (a render may still be running)'; } catch { }
  return null;
}
const busy = p => !!busyWhy(p);
export { busyWhy };
// projects whose leftovers were not listed because they are busy (the Disk page says so)
let skippedBusy = [];
export const busyProjects = () => skippedBusy;

function baseName(file) {
  let b = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
  for (let i = 0; i < 6; i++) b = b.replace(/[_\- ](v\d+|web|final|master|1080p|2160p|4k|16x9|9x16|\d+fps|hq|hd|preview|prev)$/, '');
  return b;
}

// walking temp folders is slow, so results are kept for a minute (cleared after a scan or a clean)
let cache = null, inflight = null;
export const invalidate = () => { cache = null; };
// async: callers that arrive while the list is being built share that one run
export async function findCandidates(force = false) {
  if (!force && cache && Date.now() - cache.at < 60e3) return cache.list;
  if (!inflight) inflight = computeCandidates().then(list => { cache = { at: Date.now(), list }; return list; }).finally(() => { inflight = null; });
  return inflight;
}
async function computeCandidates() {
  const cfg = config(), out = [];
  const globalThumb = path.resolve(cfg.thumbstudio?.globalDir || '').toLowerCase();
  const isThumbnailItem = targetPath => {
    const res = path.resolve(targetPath).toLowerCase();
    if (globalThumb && (res === globalThumb || res.startsWith(globalThumb + path.sep))) return true;
    if (res.includes(path.sep + '.videohub' + path.sep + 'thumbnails') || res.includes('/.videohub/thumbnails')) return true;
    return false;
  };
  const paths = new Set(), skipped = [];
  const add = c => {
    if (isThumbnailItem(c.path)) return;
    const p = c.project && index().projects.find(p => p.id === c.project);
    const keep = p ? (p.outputs || []).filter(o => o.rel === p.latest || o.role === 'final' || o.role === 'web').map(o => o.path) : [];
    if (p && c.action === 'archive' && p.outputs.some(o => o.rel === p.latest && path.resolve(o.path).toLowerCase() === path.resolve(c.path).toLowerCase())) return;
    if (c.action !== 'archive' && keep.some(f => c.dir ? isInside(f, c.path) : path.resolve(f).toLowerCase() === path.resolve(c.path).toLowerCase())) return;
    const k = c.path.toLowerCase(); if (paths.has(k) || !exists(c.path)) return;   // a silent render is also a byte duplicate: list it once
    paths.add(k); out.push({ id: cid(c.action + c.path), checked: true, ...c });
  };
  for (const p of index().projects) {
    await breather();
    if (p.rootType === 'media' && p.group) continue;   // loose exports are only reported as duplicates
    const why = busyWhy(p), isBusy = !!why;
    if (why) skipped.push({ project: p.id, name: p.title || p.name, reason: why });
    // 1. silent renders whose picture is already inside a voiced file
    for (const o of p.outputs) if (o.role === 'silent' && o.coveredBy && p.outputs.some(v => v.rel === o.coveredBy && v.audio && exists(v.path)) && !isBusy)
      add({ rule: 'silent', preset: 'safe', project: p.id, projectName: p.name, path: o.path, size: o.size, action: 'recycle', reason: `Silent intermediate render; the same video is in "${o.coveredBy}" with audio.` });
    // 7. previews older than the newest final
    const newestFinal = Math.max(0, ...p.outputs.filter(o => o.role === 'final').map(o => o.mtime));
    const inQa = f => QA_DIRS.some(d => isInside(f, path.join(p.path, d))) || isInside(f, path.join(p.path, 'render', 'preview'));   // handled with their folder
    for (const o of p.outputs) if (o.role === 'preview' && newestFinal && o.mtime < newestFinal && !inQa(o.path))
      add({ rule: 'preview', preset: 'safe', project: p.id, projectName: p.name, path: o.path, size: o.size, action: 'recycle', reason: 'Preview; a final render was made afterward.' });
    // 6. older versions of the same film -> archive (newest final and newest web stay)
    const voiced = p.outputs.filter(o => (o.role === 'final' || o.role === 'web') && !o.dupOf);
    const films = new Map();
    for (const o of voiced) { const b = baseName(o.name); if (!films.has(b)) films.set(b, []); films.get(b).push(o); }
    for (const [, vs] of films) {
      if (vs.length < 2) continue;
      vs.sort((a, b) => b.mtime - a.mtime);
      const keepFinal = vs.find(o => o.role === 'final'), keepWeb = vs.find(o => o.role === 'web' && (!keepFinal || o.mtime >= keepFinal.mtime - 3600e3));
      for (const o of vs) if (o !== keepFinal && o !== keepWeb)
        add({ rule: 'oldVersion', preset: 'deep', project: p.id, projectName: p.name, path: o.path, size: o.size, action: 'archive', reason: `Old version; the latest is "${keepFinal?.name || vs[0].name}". Moved to the archive, not deleted.` });
    }
    if (isBusy) continue;
    // test clips lying outside the QA folders (named test/clip/qa…), once they are a few days old
    // (only names that say so: short footage clips of a reel project are 'clip' too, and they are source material)
    const testName = n => /(^|[_\-. ])(test|tests|clip|qa|deneme|bench|tmp)([_\-. ]|$)/i.test(n.replace(/\.[^.]+$/, ''));
    for (const o of p.outputs) if (o.role === 'clip' && !inQa(o.path) && testName(o.name) && Date.now() - o.mtime > QA_DAYS * 864e5)
      add({ rule: 'clip', preset: 'safe', project: p.id, projectName: p.name, path: o.path, size: o.size, action: 'recycle', reason: `Test clip (${QA_DAYS}+ days); not the film itself.` });
    // 2. leftovers of earlier renders (also inside render\preview)
    for (const r of [path.join(p.outDir || p.path, 'render'), path.join(p.outDir || p.path, 'render', 'preview')]) {
      let rents = []; try { rents = fs.readdirSync(r, { withFileTypes: true }); } catch { }
      for (const e of rents) {
        const full = path.join(r, e.name);
        // parts replaced by partial renders and backups of earlier renders: the film is made from render\chunks
        if (e.isDirectory() && /^chunks_(v\d|prev)/i.test(e.name)) {
          const st = await dirSize(full); if (st.size) add({ rule: 'oldChunks', preset: 'safe', project: p.id, projectName: p.name, path: full, size: st.size, dir: true, action: 'recycle', reason: /^chunks_prev/i.test(e.name) ? 'Backup chunks from the previous render.' : 'Old chunks replaced by a partial render; the film uses render\\chunks.' });
        }
        if (e.isDirectory() && /^(tmp|profiles)$/i.test(e.name)) {
          const st = await dirSize(full); if (st.size) add({ rule: 'leftover', preset: 'safe', project: p.id, projectName: p.name, path: full, size: st.size, dir: true, action: 'recycle', reason: e.name.toLowerCase() === 'profiles' ? 'Chrome profiles from the render (recreated for each render).' : 'Temporary render files.' });
        }
        if (e.isFile() && /\.tmp\.mp4$/i.test(e.name)) { let st; try { st = fs.statSync(full); } catch { continue; } add({ rule: 'leftover', preset: 'safe', project: p.id, projectName: p.name, path: full, size: st.size, action: 'recycle', reason: 'Unfinished render chunk.' }); }
      }
    }
    for (const d of ['profiles', 'tmp_profiles']) {   // Chrome profiles some render.js put next to the code
      const full = path.join(p.path, d); if (!exists(full) || !exists(path.join(full, 'w0')) && !exists(path.join(full, 'Default'))) continue;
      const st = await dirSize(full); if (st.size) add({ rule: 'leftover', preset: 'safe', project: p.id, projectName: p.name, path: full, size: st.size, dir: true, action: 'recycle', reason: 'Chrome profiles from the render (recreated for each render).' });
    }
    // 4. QA / lookdev / preview pictures and clips: only media files go, scripts stay
    for (const d of QA_DIRS) {
      const full = path.join(p.path, d); if (!exists(full)) continue;
      const m = await mediaIn(full); if (m.size < 1 << 20) continue;
      const old = Date.now() - m.newest > QA_DAYS * 864e5, what = m.onlyMedia ? 'folder' : `${m.files.length} items, scripts stay`;
      add({ rule: 'qa', preset: old ? 'safe' : 'deep', project: p.id, projectName: p.name, path: full, size: m.size, ...(m.onlyMedia ? { dir: true } : { files: m.files }), action: 'recycle', checked: old,
        reason: `QA/test frames and clips (${d}\\, ${what}); ${old ? 'older than ' + QA_DAYS + ' days' : 'recent, the film may still be in progress'}. Can be regenerated if needed.` });
    }
    // 4a. preview renders (PREVIEW=1): once a full-quality final is newer they are only leftovers
    {
      const full = path.join(p.path, 'render', 'preview');
      if (exists(full)) {
        const m = await mediaIn(full);
        if (m.size >= 1 << 20) add({ rule: 'qa', preset: newestFinal > m.newest ? 'safe' : 'deep', project: p.id, projectName: p.name, path: full, size: m.size, ...(m.onlyMedia ? { dir: true } : { files: m.files }), action: 'recycle', checked: newestFinal > m.newest,
          reason: newestFinal > m.newest ? 'Preview render (half resolution); a final was made afterward.' : 'Preview render; no newer final yet.' });
      }
    }
    // 4b. approved notes: the small close-up stays, the full frames go once the note is old enough
    const nf = path.join(p.path, '.videohub', 'notes.json');
    if (exists(nf)) {
      let ns = []; try { ns = JSON.parse(fs.readFileSync(nf, 'utf8')); } catch { }
      const cut = Date.now() - cfg.snapsMaxAgeDays * 864e5;
      for (const n of ns) {
        if (!(n.status === 'approved' || (DONE.has(p.status) && !['open', 'reopened', 'claude'].includes(n.status))) || !n.images?.crop || !exists(n.images.crop)) continue;
        if (Date.parse((n.history || []).slice(-1)[0]?.at || n.createdAt || 0) > cut) continue;
        for (const k of ['frame', 'annotated', 'start', 'end']) {
          const f = n.images[k]; if (!f || !exists(f)) continue;
          add({ rule: 'noteImages', preset: null, project: p.id, projectName: p.name, path: f, size: (() => { try { return fs.statSync(f).size; } catch { return 0; } })(), action: 'recycle', reason: `Note #${n.id} approved (${cfg.snapsMaxAgeDays}+ days); its close-up image stays.` });
        }
      }
    }
    // 5. chunks / parts of a finished film (needed only for partial re-renders while still being reviewed)
    if (DONE.has(p.status) && !p.statusAuto && !(p.notesOpen > 0) && newestFinal) {
      for (const d of [path.join('render', 'chunks'), path.join('render', 'preview')]) {
        const full = path.join(p.outDir || p.path, d); if (!exists(full)) continue;
        const s = await dirSize(full); if (s.size < 20 << 20) continue;
        add({ rule: 'chunks', preset: 'deep', project: p.id, projectName: p.name, path: full, size: s.size, dir: true, action: 'recycle', checked: !p.statusAuto,
          reason: `Render chunks of a finished film (status: ${p.status}${p.statusAuto ? ', automatic' : ''}). Partial re-rendering will no longer be possible.` });
      }
    }
  }
  // 3. Chrome profiles left in %TEMP% by renders whose process is gone
  let tents = []; try { tents = fs.readdirSync(TEMP, { withFileTypes: true }); } catch { }
  for (const e of tents) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^(?:hd2d|bench|rl|closetest)-(\d+)-/) || e.name.match(/^(?:hd2d|bench|rl|closetest)-(\d+)$/);
    const full = path.join(TEMP, e.name);
    let stale = false;
    if (m) stale = !processAlive(+m[1]);
    else if (/^puppeteer_dev_chrome_profile-/.test(e.name)) { try { stale = Date.now() - fs.statSync(full).mtimeMs > 3600e3; } catch { } }
    if (stale) { const s = await dirSize(full); add({ rule: 'tempProfile', preset: 'safe', project: null, projectName: '%TEMP%', path: full, size: s.size, dir: true, action: 'recycle', reason: 'Chrome profile left by a render; its process has exited.' }); }
  }
  // 9. old Claude scratch folders (optional)
  const ct = path.join(TEMP, 'claude');
  let projDirs = []; try { projDirs = fs.readdirSync(ct, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { }
  for (const pd of projDirs) {
    let sess = []; try { sess = fs.readdirSync(path.join(ct, pd.name), { withFileTypes: true }).filter(e => e.isDirectory()); } catch { }
    for (const s of sess) {
      const full = path.join(ct, pd.name, s.name), st = await dirSize(full);
      if (st.size > 50 << 20 && Date.now() - st.newest > cfg.tempMaxAgeDays * 864e5)
        add({ rule: 'claudeTemp', preset: null, project: null, projectName: 'Claude temporary files', path: full, size: st.size, dir: true, action: 'recycle', checked: false, reason: `Temporary folder from a Claude session; unused for ${cfg.tempMaxAgeDays} days.` });
    }
  }
  // 8. byte-identical copies: reported, never pre-selected
  for (const d of index().dups) {
    for (const f of d.files.slice(1))
      add({ rule: 'duplicate', preset: null, project: f.project, projectName: f.projectName, path: f.path, size: d.size, action: 'recycle', checked: false, reason: `Identical byte for byte to "${shortPath(d.files[0].path)}".` });
  }
  // a file inside a folder that goes anyway is not counted twice
  const dirs = out.filter(c => c.dir && c.preset);
  skippedBusy = skipped;
  return out.filter(c => !dirs.some(d => d !== c && isInside(c.path, d.path) && c.path.toLowerCase() !== d.path.toLowerCase()));
}

// per project: what the films take vs what the presets would free
export function summary(cands) {
  const by = new Map();
  for (const p of index().projects) {
    const film = p.outputs.filter(o => o.role === 'final' || o.role === 'web').reduce((t, o) => t + (o.size || 0), 0);
    by.set(p.id, { id: p.id, name: p.title || p.name, status: p.status, total: p.sizes?.total || 0, film, chunks: p.sizes?.chunk || 0, chunksKept: !DONE.has(p.status) || p.statusAuto || p.notesOpen > 0, safe: 0, deep: 0 });
  }
  for (const c of cands) { const r = by.get(c.project); if (!r) continue; if (c.preset === 'safe') { r.safe += c.size; r.deep += c.size; } else if (c.preset === 'deep') r.deep += c.size; }
  return [...by.values()].filter(r => r.deep > 0 || r.chunks > 0).sort((a, b) => b.deep - a.deep);
}

export const RULES = {
  silent: 'Silent intermediate renders', preview: 'Old previews', oldVersion: 'Old versions (to archive)', leftover: 'Chrome profiles and temporary files',
  oldChunks: 'Replaced old chunks (chunks_v*, chunks_prev*)', qa: 'QA frames, lookdev and test clips', clip: 'Test clips', noteImages: 'Full-size images from approved notes', chunks: 'Chunks of finished films', tempProfile: 'Temporary Chrome profiles', claudeTemp: 'Old Claude temporary folders', duplicate: 'Duplicate files',
};

function logLine(o) { try { fs.appendFileSync(LOG, JSON.stringify({ at: now(), ...o }) + '\n'); } catch { } }

// ---------- cleaning: one run at a time, in the background, with progress (SSE 'clean')
// Oct 26: a run gave no feedback for minutes (2–3 GB archive copies), the user clicked again and two or three
// runs raced through the same list: every other item failed with "not found" and the counts were wrong.
let job = null; const jobSubs = new Set();
export const onClean = fn => { jobSubs.add(fn); return () => jobSubs.delete(fn); };
const pub = () => job && { id: job.id, state: job.state, phase: job.phase, total: job.total, done: job.done, freed: job.freed, current: job.current, startedAt: job.startedAt, finishedAt: job.finishedAt,
  results: job.state === 'done' ? job.results : undefined, ok: job.results.filter(r => r.status === 'ok').length, failed: job.results.filter(r => r.status === 'error').length, skipped: job.results.filter(r => r.status === 'skipped' || r.status === 'gone').length };
let lastEmit = 0;
function emitJob(force) { const t = Date.now(); if (!force && t - lastEmit < 250) return; lastEmit = t; const s = pub(); for (const fn of jobSubs) try { fn(s); } catch { } }
export const cleanStatus = () => pub();

const dirOrFileSize = async p => { try { const st = fs.statSync(p); return st.isDirectory() ? (await dirSize(p)).size : st.size; } catch { return 0; } };
const units = c => c.files ? c.files.filter(f => isInside(f.path, c.path) && f.path !== c.path) : [{ path: c.path, dir: !!c.dir }];
async function leftOf(c) { let s = 0; for (const u of units(c)) s += await dirOrFileSize(u.path); return s; }
const anyLeft = c => units(c).some(u => exists(u.path));

// SHFileOperation error codes (incl. the old DE_* ones) in plain English
function why(code) {
  if (code === -1) return 'Operation interrupted.';
  if (code === -2) return 'Too large for the Recycle Bin; left untouched to avoid permanent deletion.';
  if (code === -3) return 'The Recycle Bin is disabled or unavailable on this drive; left untouched to avoid permanent deletion.';
  if (code === -4) return 'On another disk than the trash folder (a move there would be a copy); left untouched.';
  if ([2, 3, 0x7C, 0x402].includes(code)) return 'Not found.';
  if ([5, 0x78, 0x10074].includes(code)) return 'Access denied.';
  if ([32, 33].includes(code)) return 'In use by another program (open file).';
  if (code === 0x71 || code === 0x72) return 'Source and destination are the same.';
  return `Windows error code ${code}.`;
}

// to the Recycle Bin through SHFileOperation with no UI at all (FOF_NOERRORUI: a hidden error dialog used to be able
// to hang the run), one PowerShell for the whole list, one result line per item as it goes. Items bigger than the
// Bin of their drive are refused: Windows would delete those permanently without asking.
function recycleStream(items, onItem) {
  if (!IS_WIN) return trashStream(items, onItem);
  return new Promise(resolve => {
    if (!items.length) return resolve();
    const listFile = path.join(DATA_DIR, `recycle-${Date.now()}.json`);
    writeJson(listFile, items.map(i => ({ path: i.path, size: i.size || 0 })));
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class VhBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct OP { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool aborted; public IntPtr maps; public string title; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref OP op);
  public static int Recycle(string p) {
    var op = new OP(); op.wFunc = 3; op.pFrom = p + "\\0\\0"; op.fFlags = (ushort)(0x40 | 0x10 | 0x400 | 0x4 | 0x200);
    int r = SHFileOperation(ref op); if (r == 0 && op.aborted) r = -1; return r;
  }
}
"@
$caps = @{}
foreach ($v in Get-CimInstance Win32_Volume) {
  if (-not $v.DriveLetter) { continue }
  $g = [regex]::Match($v.DeviceID, '\\{[^}]+\\}').Value
  $k = Get-ItemProperty -LiteralPath "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\$g" -ErrorAction SilentlyContinue
  if ($k) { $caps[$v.DriveLetter.ToUpper()] = @{ max = [int64]$k.MaxCapacity * 1MB; nuke = [int]$k.NukeOnDelete } }
}
$items = Get-Content -LiteralPath '${listFile.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json
$n = 0
foreach ($i in @($items)) {
  $c = $caps[$i.path.Substring(0, 2).ToUpper()]
  if (-not $c -or $c.nuke -eq 1) { $r = -3 } elseif ([int64]$i.size -gt [int64]($c.max * 0.9)) { $r = -2 } else { try { $r = [VhBin]::Recycle($i.path) } catch { $r = -1 } }
  [Console]::Out.WriteLine(([pscustomobject]@{ n = $n; code = $r } | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  $n++
}`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true });
    let buf = '', err = '', seen = 0, timer = null;
    // a stuck shell operation must not hold the run forever: 5 min without a result line ends it
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { try { p.kill(); } catch { } }, 5 * 60e3); };
    arm();
    p.stdout.on('data', d => {
      buf += d; let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith('{')) continue;
        try { const j = JSON.parse(line); seen = Math.max(seen, j.n + 1); onItem(items[j.n], j.code); arm(); } catch { }
      }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('close', () => {
      clearTimeout(timer); try { fs.unlinkSync(listFile); } catch { }
      for (let i = seen; i < items.length; i++) onItem(items[i], null, (err.trim().split('\n').pop() || 'PowerShell stopped (timeout or error).').slice(0, 300));
      resolve();
    });
  });
}

// Linux (RunPod pod) has no Recycle Bin: items are moved (renamed, never copied and deleted) into <workspace>/trash/<time>/,
// keeping their full path below it, so they can be put back by hand. Another disk than the trash folder: left untouched.
export const trashDir = () => path.join(baseDir(), 'trash');
export async function trashStream(items, onItem, root = trashDir()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const i of items) {
    let dest = path.join(root, stamp, path.resolve(i.path).replace(/^[\\/]+/, ''));
    for (let k = 2; fs.existsSync(dest); k++) dest = path.join(root, stamp, path.resolve(i.path).replace(/^[\\/]+/, '') + `_${k}`);
    try { await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.rename(i.path, dest); onItem(i, 0); }
    catch (e) { onItem(i, e.code === 'EXDEV' ? -4 : e.code === 'ENOENT' ? 2 : e.code === 'EACCES' || e.code === 'EPERM' ? 5 : e.code === 'EBUSY' ? 32 : -1); }
  }
}

// old versions: copy (async, so the hub keeps answering), check, then remove the original
async function archiveOne(i) {
  const root = config().archiveDir;
  const rel = shortPath(i.path).replace(/^~[\\/]/, '').replace(/^\//, '').replace(/^[A-Za-z]:\\/, '');
  let dest = path.join(root, rel);
  for (let k = 2; fs.existsSync(dest); k++) dest = path.join(root, rel.replace(/(\.[^.\\]+)?$/, m => `_${k}${m}`));   // keep the older archived copy
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(i.path, dest, fs.constants.COPYFILE_EXCL);
  const a = fs.statSync(i.path), b = fs.statSync(dest);
  if (a.size !== b.size || await fingerprint(i.path, a.size) !== await fingerprint(dest, b.size)) throw new Error('Could not verify the archive copy; the original file was left in place.');
  await fsp.unlink(i.path);   // the verified copy now lives in the archive
  logLine({ action: 'archive', from: i.path, to: dest, size: a.size, ok: true });
  return dest;
}

// project folders to the Recycle Bin (VideoHub's "Delete folder"): same SHFileOperation path, Bin size check, log
export async function recyclePaths(items) {
  const res = new Map();
  await recycleStream(items, (it, code, err) => { res.set(it.path, code === 0 ? null : (err || why(code))); });
  const out = items.map(it => ({ path: it.path, ok: !exists(it.path), error: exists(it.path) ? (res.get(it.path) || 'Still on disk.') : null }));
  for (const r of out) logLine({ action: 'recycle-project', path: r.path, ok: r.ok, error: r.error || undefined });
  if (cache) cache.list = cache.list.filter(c => !items.some(it => isInside(c.path, it.path) || c.path.toLowerCase() === it.path.toLowerCase()));
  return out;
}

// starts a run with the items the user ticked (ids from the list they saw); answers at once
export async function startClean(ids) {
  if (job && job.state !== 'done') throw Object.assign(new Error('A cleanup is already running; wait for it to finish.'), { code: 409 });
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('Nothing selected'), { code: 400 });
  job = { id: 'c' + Date.now().toString(36), state: 'running', phase: 'list', total: ids.length, done: 0, freed: 0, current: null, startedAt: now(), finishedAt: null, results: [] };
  emitJob(true);
  runJob(ids).catch(e => { job.results.push({ path: '', status: 'error', error: String(e.message || e) }); }).finally(() => {
    job.state = 'done'; job.current = null; job.finishedAt = now(); emitJob(true);
  });
  return pub();
}

async function runJob(ids) {
  // the list the user looked at (cached); only when it is gone is it counted again
  const all = cache?.list || await findCandidates();
  const want = new Set(ids), seen = new Set();
  let pick = all.filter(c => want.has(c.id) && !seen.has(c.path.toLowerCase()) && seen.add(c.path.toLowerCase()));
  // something inside a folder that is going anyway goes with it
  const dirs = pick.filter(c => c.dir).map(c => c.path);
  pick = pick.filter(c => !dirs.some(d => d !== c.path && isInside(c.path, d)));
  const missing = ids.length - all.filter(c => want.has(c.id)).length;
  job.total = pick.length; job.phase = 'cleanup'; emitJob(true);
  const res = (c, status, extra = {}) => { job.results.push({ path: c.path, project: c.projectName, rule: c.rule, size: c.size, status, ...extra }); job.done++; emitJob(); };
  if (missing > 0) job.results.push({ path: '', status: 'gone', error: `${missing} items are no longer in the list (removed by another cleanup or changed).` });

  const allowed = [...config().roots.map(r => r.path), TEMP];
  const projects = new Map(index().projects.map(p => [p.id, p]));
  const recycleList = [], archiveList = [];
  for (const c of pick) {
    if (!allowed.some(a => isInside(c.path, a))) { res(c, 'error', { error: 'Outside the configured folders; left untouched.' }); continue; }
    if (!anyLeft(c)) { res(c, 'gone', { error: 'Already gone.' }); continue; }
    const p = c.project && projects.get(c.project), b = p && busyWhy(p);
    if (b) { res(c, 'skipped', { error: `Skipped: ${b}.` }); continue; }
    (c.action === 'archive' ? archiveList : recycleList).push(c);
  }
  // recycle: whole items, or a QA folder's media one by one (its scripts stay)
  const flat = recycleList.flatMap(c => units(c).map(u => ({ path: u.path, size: c.files ? u.size || 0 : c.size, of: c })));
  const codes = new Map();
  await recycleStream(flat, (it, code, err) => {
    job.current = it.path;
    if (code !== 0) codes.set(it.of, codes.get(it.of) || (err ? { text: err } : { code, text: why(code) }));
  });
  for (const c of recycleList) {
    const rest = await leftOf(c), freed = Math.max(0, c.size - rest), e = codes.get(c);
    // Windows says "not found" also when a file inside is held open by another program (seen with a locked Chrome profile)
    const err = !e ? null : e.code != null && e.code > 0 && rest ? `Could not delete: a file inside may be open in another program (Windows code ${e.code}). Try again after closing that program.` : e.text;
    if (!rest) { job.freed += c.size; res(c, 'ok', { freed: c.size }); logLine({ action: 'recycle', path: c.path, ok: true, size: c.size }); }
    else { job.freed += freed; res(c, 'error', { freed, left: rest, error: (freed ? `Partially removed: ${Math.round(rest / 1048576)} MB left. ` : '') + (err || 'Still on disk.') }); logLine({ action: 'recycle', path: c.path, ok: false, error: err, left: rest }); }
  }
  for (const c of archiveList) {
    job.current = c.path; emitJob(true);
    try { const to = await archiveOne(c); job.freed += c.size; res(c, 'ok', { freed: c.size, to }); }
    catch (e) { res(c, 'error', { error: String(e.message || e) }); logLine({ action: 'archive', from: c.path, ok: false, error: String(e.message || e) }); }
  }
  // the list on screen comes back at once: drop what is gone instead of measuring everything again
  if (cache) cache.list = cache.list.filter(c => anyLeft(c));
}
