// VideoHub server: http://127.0.0.1:7788  (UI + JSON API + server-sent events). Local only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config, saveConfig, discoverRoots, baseDir } from './config.js';
import { detectEncoders, LABELS as ENC_LABELS } from './encoders.js';
import { scan, index, project, rescanProject, thumbnail, onScan, dropProject, hideKey } from './scan.js';
import { findCandidates, startClean, cleanStatus, onClean, busyProjects, RULES, invalidate, summary, recyclePaths, busyWhy } from './janitor.js';
import { guardState, guardHistory, guardCommand, snippRenders, guardSettings, saveGuardSettings, ensureGuard, quitGuard, guardExe } from './guard.js';
import { HUB_DIR, DATA_DIR, TOOLS, isInside, readJson, writeJson, shortPath } from './util.js';
import { readMeta, normalizeMeta } from './legacy.js';
import * as example from './example.js';
import * as notesApi from './notes.js';
import * as jobs from './jobs.js';
import * as media from './media.js';
import * as live from './live.js';
import { refreshSources } from './source-revision.js';
import * as sound from './sound.js';
import * as outputsApi from './outputs.js';
import * as ciktilar from './ciktilar.js';
import * as layersApi from './layers.js';
import * as scenesApi from './scenes.js';
import * as edit2d from './edit2d.js';
import * as soundEdit from './soundedit.js';
import * as tweaksApi from './tweaks.js';
import { openFile } from './open-file.js';
import { transcript } from './transcript.js';
import { ramHogs } from './ramhogs.js';
import * as thumbstudio from './thumbstudio/store.js';

const UI = path.join(HUB_DIR, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac' };

// ---------- UI version: open pages reload themselves when the UI files change
let uiVersion = '';
function computeUiVersion() {
  try { uiVersion = fs.readdirSync(UI, { recursive: true }).map(f => { const s = fs.statSync(path.join(UI, f)); return s.isFile() ? f + s.size + Math.round(s.mtimeMs) : ''; }).join('|'); } catch { }
  uiVersion = String([...uiVersion].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
}
computeUiVersion();
let uiTimer = null;
try { fs.watch(UI, { recursive: true }, () => { clearTimeout(uiTimer); uiTimer = setTimeout(() => { const old = uiVersion; computeUiVersion(); if (old !== uiVersion) broadcast('version', { v: uiVersion }); }, 400); }); } catch { }

// ---------- live events (SSE)
const clients = new Set();
export function broadcast(type, data) { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
onScan(ev => { if (ev.phase === 'done' || ev.type === 'project') invalidate(); broadcast('scan', ev); });
// warm the cleanup list in the background after a scan so pages open fast
onScan(ev => { if (ev.phase === 'done') setTimeout(() => { findCandidates().catch(() => { }); }, 200); });
// a finished full scan re-walks every project's code in the background (cards' live revision / thumbVersion)
onScan(ev => { if (ev.phase === 'done' && ev.full) refreshSources(index().projects); });
// a render ended: a Windows notification too (the open VideoHub window shows its own notice)
jobs.onJob(ev => { if (ev.type === 'done') outputsApi.notifyWindows(`Render finished: ${ev.job.projectName}${ev.job.version ? ' v' + ev.job.version : ''}`, ev.job.outputPath || ev.job.output || ''); else if (ev.type === 'failed') outputsApi.notifyWindows(`Render failed: ${ev.job.projectName}`, ev.job.error || ''); });
// a custom command waits for a yes: a Windows notification, and an open VideoHub window jumps to the Renders page
jobs.onJob(ev => { if (ev.type === 'approval') { outputsApi.notifyWindows('A render command needs your approval', `${ev.job.projectName}: ${ev.job.cmd || ''}`); broadcast('navigate', { hash: '#/renders' }); } });
jobs.onJob(ev => { broadcast('job', ev); if (ev.type === 'running' && !GUARD_OFF) ensureGuard().catch(() => { }); });   // a render always runs protected
setInterval(() => { if (clients.size) broadcast('renders', rendersPayload(false)); }, 2000);

function rendersPayload(withHistory = true) {
  const guard = guardState(), list = jobs.list();
  // programs holding RAM: looked up (one PowerShell call, cached 30 s) only while a render runs or waits, or the page opens
  const rendering = (guard.renders || []).length > 0 || list.some(j => j.state === 'running' || j.state === 'queued');
  return { guard, snipp: snippRenders(), jobs: list, hogs: rendering || withHistory ? ramHogs() : [], ...(withHistory ? { history: guardHistory() } : {}) };
}

// ---------- helpers
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => { const bufs = []; let n = 0; req.on('data', b => { n += b.length; if (n > 50 << 20) { reject(new Error('too large')); req.destroy(); } else bufs.push(b); }); req.on('end', () => { const t = Buffer.concat(bufs).toString('utf8'); try { resolve(t ? JSON.parse(t) : {}); } catch { resolve({}); } }); req.on('error', reject); });
// files we are willing to serve: inside a root, the archive, or a project's .videohub folder
function allowedFile(p) {
  const ts = config().thumbstudio || {};
  const roots = config().roots.map(r => r.path).concat([config().archiveDir, media.PROXY, ts.globalDir, ts.templatesDir, ts.styleRefsDir].filter(Boolean));
  return roots.some(r => isInside(p, r));
}
function serveFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // one range "bytes=a-b" / "a-" / "-n"; anything else (malformed, several ranges) gets the whole file
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] || m[2])) {
    const a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (a >= st.size || b < a) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes' }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 });
    fs.createReadStream(file, { start: a, end: b }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}
function lite(p) {
  const { outputs, meta, ...rest } = p;
  const canLive = live.liveCapable(p);
  const lo = outputs.find(o => o.rel === p.latest);   // no final yet: the film's length (manifest / DUR / sound), not a preview's
  return { ...rest, label: shortPath(p.path) + (p.group ? ' · ' + p.group : ''), latestDur: (lo?.role === 'final' ? lo.dur : p.filmDur || lo?.dur) || 0, outputsCount: outputs.length, live: canLive, thumbVersion: canLive ? live.codeRevision(p) : String(p.latest || '') + ':' + String(lo?.mtime || p.updated || 0), silentCovered: outputs.filter(o => o.role === 'silent' && o.coveredBy).length };
}
// what this PC has of the required and optional parts (Settings shows it; features without their part explain why)
function integrations() {
  const studio = config().studioDir && fs.existsSync(path.join(config().studioDir, 'engine', 'audio', 'synth.js'));
  return {
    ffmpeg: fs.existsSync(TOOLS.ffmpeg) || TOOLS.ffmpeg !== 'ffmpeg',
    browser: TOOLS.edge || TOOLS.chrome || null,
    agent: { ok: true, builtIn: true, exe: null, why: null },   // render protection is part of the hub (no helper program since Nov 2026)
    sfx: { ok: !!studio, why: studio ? null : 'Ready-made sound effects need the optional 3D studio engine (studioDir). Your own sound folder works without it.' },
  };
}
function projectMetaPath(p) { return p.group ? path.join(HUB_DIR, 'data', 'meta', p.id + '.json') : path.join(p.path, '.videohub', 'project.json'); }
// ---------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/ping', () => ({ ok: true, app: 'videohub', pid: process.pid }));
route('GET', '/api/projects', async (req, url) => {
  if (url.searchParams.get('refresh') === '1' || !index().at) await scan();
  const s = index();
  return { at: s.at, scanning: s.scanning, projects: s.projects.map(lite), dupGroups: s.dups.length };
});
route('POST', '/api/scan', (req, url) => { if (url.searchParams.get('soft')) return { started: softScan(60e3) }; scan().catch(() => { }); return { started: true }; });
// which project is this folder (or a file inside it)? deepest match wins; also accepts an id or a name
route('GET', '/api/find', async (req, url) => {
  const q = url.searchParams.get('q') || '';
  const pick = () => {
    const s = index().projects;
    const byId = s.find(p => p.id === q); if (byId) return byId;
    const inside = s.filter(p => !p.group && isInside(q, p.path)).sort((a, b) => b.path.length - a.path.length)[0]; if (inside) return inside;
    const lq = q.toLowerCase(); return s.find(p => p.name.toLowerCase() === lq) || s.find(p => (p.title || '').toLowerCase() === lq) || null;
  };
  let p = pick();
  if (!p && q && fs.existsSync(q)) { await scan({ soft: true }); p = pick(); }   // new folders are found by soft scans too
  if (!p) throw Object.assign(new Error('This folder is not a project VideoHub knows: ' + q + '. Put it inside one of VideoHub\'s folders, or add its parent folder in Settings → Folders.'), { code: 404 });
  return { ...lite(p), outputs: p.outputs, notes: notesApi.list(p), versionsLog: notesApi.versions(p) };
});
route('GET', '/api/project/:id', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const name = p.name.toLowerCase();
  const history = guardHistory(1000).filter(h => h.project && (h.project.toLowerCase().replace(/\//g, '\\').endsWith('\\' + name) || h.project.toLowerCase() === name)).slice(0, 60);
  // the review page does not need the cleanup list (lite=1); the project page waits at most 1.5 s for it
  const cand = url.searchParams.get('lite') ? null : await Promise.race([findCandidates().catch(() => []), new Promise(r => setTimeout(() => r(null), 1500))]);
  return { ...p, label: shortPath(p.path), cleanup: (cand || []).filter(c => c.project === id), cleanupPending: !cand && !url.searchParams.get('lite'), busy: busyProjects().find(b => b.project === id)?.reason || null, notes: notesApi.list(p), versionsLog: notesApi.versions(p), history };
});
route('POST', '/api/project/:id/meta', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const body = await readBody(req), file = projectMetaPath(p);
  const meta = normalizeMeta({ ...readMeta(file, {}), ...body, updated: new Date().toISOString() });   // a Turkish status word is accepted too
  writeJson(file, meta);
  return await rescanProject(id).then(lite);
});
route('POST', '/api/project/:id/rescan', async (req, url, { id }) => lite(await rescanProject(id)));
// a film with no video yet: the picture its live page drew (the card draws it and sends it here; X-Stale = code is newer)
const LIVE_THUMBS = path.join(HUB_DIR, 'data', 'thumbs');
// the last automatic scan of a live film (ui/review/autoscan.js): ranges of problems, kept with the project
route('GET', '/api/project/:id/autoscan', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  return readJson(path.join(p.path, '.videohub', 'autoscan.json'), null);
});
route('PUT', '/api/project/:id/autoscan', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  if (!b || !Array.isArray(b.ranges)) throw Object.assign(new Error('missing ranges'), { code: 400 });
  fs.mkdirSync(path.join(p.path, '.videohub'), { recursive: true });
  writeJson(path.join(p.path, '.videohub', 'autoscan.json'), { ...b, ranges: b.ranges.slice(0, 2000) });
  return { ok: true };
});
const TWEAK_CLEANERS = { cleanAudio: soundEdit.cleanAudio, cleanItems: edit2d.cleanItems, cleanActors: edit2d.cleanActors };
// the scene editor's fixes (camera, objects) for pages that draw them themselves (3D studio engine/tweaks.js)
route('GET', '/api/project/:id/tweaks', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  return readJson(path.join(p.path, 'tweaks.json'), { v: 1, shots: {} });
});
route('PUT', '/api/project/:id/tweaks', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  if (!b || typeof b.shots !== 'object' || Array.isArray(b.shots)) throw Object.assign(new Error('missing shots'), { code: 400 });
  const f = path.join(p.path, 'tweaks.json');
  // PUT always sets shots, cuts and sound (an absent cuts/sound = none); items2d / actors2d / audio only when given
  const { soundOps, ...rest } = b;
  const out = tweaksApi.mergeTweaks(tweaksApi.readTweaksStrict(f), { ...rest, cuts: b.cuts, sound: b.sound }, TWEAK_CLEANERS);
  tweaksApi.writeTweaks(f, out);
  return { ok: true, shots: Object.keys(b.shots).length, cuts: out.cuts.length, items2d: (out.items2d || []).length };
});
// each editor sends only its own keys: { shots, cuts, items2d, actors2d, audio, sound, soundOps } (any of them);
// read-modify-write runs synchronously after the body is read, so concurrent PATCHes never interleave
route('PATCH', '/api/project/:id/tweaks', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw Object.assign(new Error('missing body'), { code: 400 });
  if ('shots' in b && (!b.shots || typeof b.shots !== 'object' || Array.isArray(b.shots))) throw Object.assign(new Error('shots must be an object'), { code: 400 });
  if ('soundOps' in b && (!b.soundOps || typeof b.soundOps !== 'object')) throw Object.assign(new Error('soundOps must be an object'), { code: 400 });
  const keys = ['shots', 'cuts', 'items2d', 'actors2d', 'audio', 'sound', 'soundOps'].filter((k) => k in b);
  const f = path.join(p.path, 'tweaks.json');
  const body = Object.fromEntries(keys.map((k) => [k, b[k]]));
  const out = tweaksApi.mergeTweaks(tweaksApi.readTweaksStrict(f), body, TWEAK_CLEANERS);
  tweaksApi.writeTweaks(f, out);
  return { ok: true, keys, sound: out.sound || [], ...(out.audio ? { audio: out.audio } : {}) };
});
route('POST', '/api/project/:id/live-thumb', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const body = await readBody(req);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.data || '');
  if (!m) throw Object.assign(new Error('not a JPEG'), { code: 400 });
  const revision = live.codeRevision(p, { fresh: true });   // never the cached one: a stale frame must get 409
  if (body.revision && body.revision !== revision) throw Object.assign(new Error('The code changed; the cover has to be drawn again.'), { code: 409 });
  fs.mkdirSync(LIVE_THUMBS, { recursive: true });
  fs.writeFileSync(path.join(LIVE_THUMBS, 'live-' + p.id + '.jpg'), Buffer.from(m[1], 'base64'));
  writeJson(path.join(LIVE_THUMBS, 'live-' + p.id + '.json'), { revision: body.revision || null });
  return { ok: true };
});
route('GET', '/api/thumb/:id', async (req, url, { id }, res) => {
  const p = project(id); if (!p) return send(res, 404, { error: 'Project not found' });
  const wantsLive = url.searchParams.get('source') === 'live' || !p.latest;
  if (wantsLive && live.liveCapable(p)) {
    const lf = path.join(LIVE_THUMBS, 'live-' + p.id + '.jpg');
    const meta = readJson(path.join(LIVE_THUMBS, 'live-' + p.id + '.json'), {});
    if (fs.existsSync(lf)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Thumb-Source': 'live', 'X-Stale': meta.revision === live.codeRevision(p) ? '0' : '1' });
      return fs.createReadStream(lf).on('error', () => res.destroy()).pipe(res);
    }
  }
  const f = await thumbnail(p);
  if (!f) return send(res, 404, { error: 'Cover not ready yet' });
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Thumb-Source': 'video', 'X-Stale': wantsLive && live.liveCapable(p) ? '1' : '0' });
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
});
route('GET', '/media', (req, url, _, res) => {
  const f = url.searchParams.get('p');
  if (!f || !allowedFile(f)) return send(res, 403, { error: 'not allowed' });
  serveFile(req, res, f);
});
route('POST', '/api/open', async (req) => {
  const { path: p, how } = await readBody(req);
  if (typeof p !== 'string' || !p || !allowedFile(p)) throw Object.assign(new Error('not allowed'), { code: 403 });
  return openFile(p, how || 'file');
});
// "Open folder": the project folder in Explorer, or (file) the folder of one of its videos with that file selected.
// Only folders inside a configured root (or the archive); test hubs (VIDEOHUB_NO_WINDOW) answer without opening.
route('POST', '/api/project/:id/open-folder', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  const o = b.file ? p.outputs.find(x => x.rel === b.file || x.path === b.file) : null;
  if (b.file && !o) throw Object.assign(new Error('This project has no such video'), { code: 404 });
  const target = o ? o.path : (p.groupFiles ? path.dirname(p.outputs[0]?.path || p.path) : p.path);
  if (!allowedFile(target) || !fs.existsSync(target)) throw Object.assign(new Error('This folder cannot be opened (outside VideoHub\'s folders, or missing)'), { code: 403 });
  const args = o ? `/select,"${target}"` : `"${target}"`;
  if (!process.env.VIDEOHUB_NO_WINDOW) spawn('explorer.exe', [args], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  return { ok: true, path: target, select: !!o };
});
// ---------- removing a project from the Projects page
// "Remove from list": hidden (config.hiddenProjects), no file touched, back from Settings → Hidden projects
route('POST', '/api/project/:id/hide', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const list = (config().hiddenProjects || []).filter(h => h.key !== hideKey(p));
  list.push({ key: hideKey(p), name: p.title || p.name, path: p.path + (p.group ? ' · ' + p.group : ''), at: new Date().toISOString() });
  saveConfig({ hiddenProjects: list }); dropProject(id);
  return { ok: true };
});
route('GET', '/api/hidden', () => config().hiddenProjects || []);
route('POST', '/api/hidden/restore', async (req) => {
  const { key } = await readBody(req);
  saveConfig({ hiddenProjects: (config().hiddenProjects || []).filter(h => h.key !== key) });
  scan().catch(() => { }); return { ok: true };
});
// "Delete folder": the project's folder (a 3D scene: also its out\<scene>; loose files: just those files) to the Recycle Bin.
// Never a configured root itself or anything outside one, never while it renders or is queued.
route('POST', '/api/project/:id/delete-folder', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const roots = config().roots.map(r => r.path);
  const targets = p.group ? p.groupFiles.map(f => path.join(p.path, f)) : [p.path, ...(p.studio && p.outDir && fs.existsSync(p.outDir) ? [p.outDir] : [])];
  for (const t of targets) {
    if (!roots.some(r => isInside(t, r)) || roots.some(r => path.resolve(r).toLowerCase() === path.resolve(t).toLowerCase())) throw Object.assign(new Error('This folder cannot be deleted: it is one of VideoHub\'s folders itself, or outside them.'), { code: 403 });
  }
  if (jobs.list().some(j => j.project === id && ['queued', 'running'].includes(j.state))) throw Object.assign(new Error('This project is rendering or queued; try again when it is done.'), { code: 409 });
  const why = busyWhy(p); if (why) throw Object.assign(new Error('Cannot delete right now: ' + why + '.'), { code: 409 });
  if (cleanStatus()?.state === 'running') throw Object.assign(new Error('A cleanup is running; try again when it is done.'), { code: 409 });
  const res = await recyclePaths(targets.map(t => ({ path: t, size: p.group ? 0 : (p.sizes?.total || 0) })));
  const bad = res.filter(r => !r.ok);
  if (bad.length < res.length) dropProject(id);
  return { ok: !bad.length, results: res, error: bad[0]?.error || null };
});
route('GET', '/api/renders', () => rendersPayload(true));
route('POST', '/api/renders/cmd', async (req) => {
  const { action, rootPid } = await readBody(req);
  if (!['pause', 'resume', 'kill', 'pauseAll', 'resumeAll', 'slow', 'normal'].includes(action)) throw Object.assign(new Error('unknown command'), { code: 400 });
  return guardCommand(action, rootPid);
});
// settings + the running temporary override; a manual change ends the override (the user decided)
route('GET', '/api/guard/settings', async () => ({ ...(await guardSettings()), ramTotalMB: Math.round(os.totalmem() / 1048576), cores: os.cpus().length, temp: readJson(path.join(HUB_DIR, 'data', 'guard-temp.json')) }));
route('POST', '/api/guard/settings', async (req) => { const b = await readBody(req); try { fs.unlinkSync(path.join(HUB_DIR, 'data', 'guard-temp.json')); } catch { } return saveGuardSettings(b); });
route('GET', '/api/disk', async () => {
  const c = await findCandidates(), s = index();
  const totals = s.projects.reduce((t, p) => { for (const [k, v] of Object.entries(p.sizes || {})) t[k] = (t[k] || 0) + v; return t; }, {});
  return { rules: RULES, candidates: c, totals, projects: summary(c), busy: busyProjects(), clean: cleanStatus(), archiveDir: config().archiveDir, archiveOk: fs.existsSync(path.parse(config().archiveDir).root) };
});
// a cleaning run goes in the background (one at a time); progress and the result come as SSE 'clean'
route('POST', '/api/disk/clean', async (req) => { const { ids } = await readBody(req); return startClean(ids); });
// slow-save reports from the review player (data\perf.jsonl, last ~500 lines kept) with free RAM and renders at that moment
route('POST', '/api/perf', async (req) => {
  const b = await readBody(req), f = path.join(HUB_DIR, 'data', 'perf.jsonl'), g = guardState();
  const line = JSON.stringify({ at: new Date().toISOString(), ...b, freeRamMB: Math.round(os.freemem() / 1048576), renders: (g.renders || []).length, jobs: jobs.busy() }) + '\n';
  try { const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-499).join('\n') + '\n' : ''; fs.writeFileSync(f, old + line); } catch { }
  return { ok: true };
});
route('GET', '/api/disk/clean', () => cleanStatus() || { state: 'none' });
onClean(st => { broadcast('clean', st); if (st.state === 'done') { ciktilar.afterClean(st.results).catch(() => { }); scan().catch(() => { }); } });
// after every scan: each project's newest final in the outputs folder (the first scan fills it)
onScan(ev => { if (ev.phase === 'done') try { ciktilar.sync(); } catch (e) { console.error('ciktilar sync:', e.message); } });
route('GET', '/api/config', () => ({ ...config(), workspace: baseDir(), discovered: discoverRoots(), tools: TOOLS, example: example.info(), integrations: integrations() }));
example.routes(route, readBody, () => scan());
route('POST', '/api/config', async (req) => { const body = await readBody(req); const c = saveConfig(body); scan().catch(() => { }); return c; });
// render encoders this PC can use (one tiny test encode each, cached in data/encoders.json; ?refresh=1 probes again)
route('GET', '/api/encoders', async (req, url) => ({ ...(await detectEncoders({ ffmpeg: TOOLS.ffmpeg, cacheFile: path.join(DATA_DIR, 'encoders.json'), refresh: url.searchParams.get('refresh') === '1' })), chosen: config().render?.encoder || 'auto', labels: ENC_LABELS }));
notesApi.routes(route, readBody);
thumbstudio.routes(route, readBody);
sound.routes(route, project);
outputsApi.routes(route, readBody);
ciktilar.routes(route);
layersApi.routes(route);
scenesApi.routes(route, readBody);
edit2d.routes(route, readBody);
soundEdit.routes(route, readBody);
jobs.routes(route, readBody);
media.routes(route, allowedFile);
media.onProxy(ev => broadcast('proxy', ev));
notesApi.onNote(ev => broadcast('note', ev));
thumbstudio.onStore(ev => broadcast('thumbstudio', ev));
setTimeout(() => { try { notesApi.resumePending(index().projects); } catch (e) { console.error('[notes] resume:', e.message); } }, 8000);

// the narration's text with timings (timeline row, captions)
route('GET', '/api/project/:id/transcript', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  return transcript(p);
});

// show a page to the user (Claude's hub_live): an open VideoHub window jumps there, otherwise a window opens
route('POST', '/api/show', async (req) => {
  const { hash } = await readBody(req);
  if (typeof hash !== 'string' || !/^#\/[\w\-/~%.]*$/.test(hash)) throw Object.assign(new Error('invalid page'), { code: 400 });
  if (process.env.VIDEOHUB_GUARD !== 'off') ensureGuard().catch(() => { });
  if (clients.size) { broadcast('navigate', { hash }); return { ok: true, how: 'window' }; }
  if (process.env.VIDEOHUB_NO_WINDOW) return { ok: true, how: 'none' };
  const url = `http://127.0.0.1:${port}/${hash}`, exe = TOOLS.edge || TOOLS.chrome;
  if (exe) spawn(exe, ['--app=' + url], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { ok: true, how: 'opened' };
});

// live preview (no render): what to play for a project; open players hear about code changes
route('GET', '/api/project/:id/live', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const info = await live.liveInfo(p);
  if (info.ok && !url.searchParams.get('probe')) live.watch(p, ev => broadcast('live-changed', ev));
  return info;
});

route('GET', '/api/events', (req, url, _, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ v: uiVersion })}\n\n`); clients.add(res);
  req.on('close', () => { clients.delete(res); lastUse = Date.now(); });   // the 2 min count from the window closing
  softScan(30e3);   // a VideoHub window opened: pick up projects other chats made meanwhile
  if (!GUARD_OFF) ensureGuard().catch(() => { });
});

// ---------- new projects show up by themselves: rescan when a window opens or comes back to the front,
// every 10 min while one is open, and when Claude asks about a folder (see /api/project). A full scan takes ~7 s.
function softScan(maxAgeMs) {
  const at = index().at, t = typeof at === 'number' ? at : Date.parse(at || 0) || 0;
  if (index().scanning || Date.now() - t < maxAgeMs) return false;
  scan({ soft: true }).catch(() => { }); return true;   // only changed projects are walked again (scan.js)
}
setInterval(() => { if (clients.size) softScan(9 * 60e3); }, 60e3);

// ---------- a temporary RenderGuard override ("just this time", data/guard-temp.json): put the saved settings back once it expired
const TEMP_FILE = path.join(HUB_DIR, 'data', 'guard-temp.json');
async function checkGuardTemp(force = false) {
  const t = readJson(TEMP_FILE);
  if (!t?.until || (!force && Date.now() < Date.parse(t.until))) return false;
  try { await saveGuardSettings(t.restore || {}); fs.unlinkSync(TEMP_FILE); console.log('VideoHub: the temporary render setting ended, the previous settings are back.'); return true; } catch { return false; }
}
// POST {hours}: full power until then (keeps the settings from before the first override); {cancel:true}: restore now
route('POST', '/api/guard/temp', async (req) => {
  const b = await readBody(req);
  if (b.cancel) { await checkGuardTemp(true); return { ok: true }; }
  const hours = Math.max(0.25, Math.min(24, +b.hours || 2));
  const old = readJson(TEMP_FILE), cur = await guardSettings();
  const restore = old?.restore || { CapActive: cur.CapActive, CapIdle: cur.CapIdle, LowPrio: !!cur.LowPrio };
  const until = new Date(Date.now() + hours * 3600e3).toISOString();
  writeJson(TEMP_FILE, { reason: 'Renders page: temporary full power', until, restore });
  await saveGuardSettings({ CapActive: 100, CapIdle: 100, LowPrio: false });
  return { ok: true, until };
});
checkGuardTemp(); setInterval(checkGuardTemp, 60e3).unref();

// ---------- run only while used: no VideoHub window, no render, no queued work for 2 min → RenderGuard and the hub close.
// Claude's hub_* tools start the hub again when needed; a render job starts RenderGuard again.
// "Start with Windows" on = the user wants them always running, so nothing closes.
const IDLE_MS = (+process.env.VIDEOHUB_IDLE_SEC || 120) * 1000;
const GUARD_OFF = process.env.VIDEOHUB_GUARD === 'off';   // test instances: never start or stop the real RenderGuard
let lastUse = Date.now(), startupCache = { at: 0, on: false };
async function alwaysOn() {
  if (Date.now() - startupCache.at > 60e3) { try { startupCache = { at: Date.now(), on: !!(await guardSettings()).Startup }; } catch { } }
  return startupCache.on;
}
setInterval(async () => {
  const g = guardState();
  if (clients.size || jobs.busy() || cleanStatus()?.state === 'running' || notesApi.busyPictures() || media.makingCopies() || index().scanning || (!GUARD_OFF && g.running && (g.renders || []).length)) { lastUse = Date.now(); return; }
  if (Date.now() - lastUse < IDLE_MS || await alwaysOn()) return;
  console.log('VideoHub: not in use, closing together with the render protection.');
  if (!GUARD_OFF) await quitGuard().catch(() => { });
  process.exit(0);
}, 20e3).unref();
// "Start with Windows" (open.vbs --server at log-in): the hub stays on, so the render protection runs from the start
if (!GUARD_OFF) alwaysOn().then(on => { if (on) ensureGuard().catch(() => { }); }).catch(() => { });

// only this PC's own pages and tools: a page on another website (or a DNS name pointed at 127.0.0.1) must not drive
// the hub — its job queue can run commands. Claude's MCP tools, RenderGuard and scripts send no Origin/Sec-Fetch-Site.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
function foreign(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!LOOPBACK.has(host)) return 'host';
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return 'site';
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let o = null; try { o = new URL(origin); } catch { }
    if (!o || !LOOPBACK.has(o.hostname.toLowerCase().replace(/^\[(.*)\]$/, '[$1]')) || String(o.port || '80') !== String(server.address()?.port)) return 'origin';
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  const why = foreign(req);
  if (why) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('VideoHub: only VideoHub windows and tools on this computer may use this server (' + why + ')'); }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/api/ping') lastUse = Date.now();   // RenderGuard's keep-alive ping is not a use
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const out = await r.fn(req, url, m.groups || {}, res);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
    // a film page for live preview: /live/<project id>/<file>; absolute URLs from such a page land here via its Referer
    if (url.pathname.startsWith('/live/')) {
      const [, , pid, ...rest] = url.pathname.split('/'), lp = project(pid);
      if (!lp) return send(res, 404, { error: 'not found' });
      return live.serve(req, res, lp, rest.join('/'));
    }
    // (browsers don't always send a Referer for module imports, so the cookie set by /live/<id>/... decides too)
    const ref = (req.headers.referer || '').match(/\/live\/([0-9a-f]{12})\//) || (req.headers.cookie || '').match(/(?:^|;\s*)vhlive=([0-9a-f]{12})/);
    if (ref && !fs.existsSync(path.join(UI, decodeURIComponent(url.pathname)))) { const lp = project(ref[1]); if (lp && fs.existsSync(path.join(lp.studio || lp.path, decodeURIComponent(url.pathname)))) return live.serve(req, res, lp, url.pathname.slice(1)); }
    // static UI
    let f = path.join(UI, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!isInside(f, UI) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(UI, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] ||'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: String(e.message || e) });
  }
});

const port = +(process.env.VIDEOHUB_PORT || config().port || 7788);
server.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`VideoHub is already running (port ${port}).`); process.exit(0); } throw e; });
server.listen(port, '127.0.0.1', () => {
  console.log(`VideoHub: http://127.0.0.1:${port}`);
  if (!index().at || index().projects.length === 0) scan().catch(e => console.error('scan:', e.message)); else scan().catch(() => { });
  if (process.env.VIDEOHUB_JOBS !== 'off') jobs.resume();   // test instances never pick up the real render queue
});
