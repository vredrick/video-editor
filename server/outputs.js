// Every finished render in one list (Renders → "Recent renders"), so nobody has to ask a chat "show me the video":
//   jobs      VideoHub's queue (done, failed, cancelled; running ones with no progress for 10 min = "may be stuck")
//   versions  versions.json of every project (chats registering renders made outside the queue)
//   scan      final / web / preview films the scan found that neither of the above knows
//   guard     renders RenderGuard saw finish outside VideoHub (no file known)
// Watched state per file in data/seen-outputs.json. "new" = finished, file on disk, not opened in VideoHub yet.
// The first run takes everything already there as seen, so only renders from now on show up as new.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { index, project } from './scan.js';
import * as jobs from './jobs.js';
import { guardHistory } from './guard.js';
import { vhDir } from './notes.js';
import { DATA_DIR, DESKTOP, HOME, readJson, writeJson, refersToHub } from './util.js';
// RenderGuard writes a render's folder shortened (relative to the Desktop, or ~\ for the home folder): back to a full path
const guardPath = s => !s ? '' : s.startsWith('~') ? path.join(HOME, s.slice(1)) : path.isAbsolute(s) ? s : path.join(DESKTOP, s);

const SEEN = path.join(DATA_DIR, 'seen-outputs.json');
const STUCK_MS = 10 * 60e3;
const keyOf = (f) => path.resolve(f).toLowerCase();
let seen = null;
function seenMap() { if (!seen) seen = readJson(SEEN, null); return seen; }
function saveSeen() { writeJson(SEEN, seen); }

const vOfName = (n) => { const m = /_v(\d+)(?:[_.]|$)/i.exec(n || ''); return m ? +m[1] : null; };
const iso = (x) => { const t = typeof x === 'number' ? x : Date.parse(x || ''); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };

function collect() {
  const items = new Map(), out = [];
  const projects = index().projects || [];
  const byPath = new Map();
  for (const p of projects) for (const o of p.outputs || []) byPath.set(keyOf(o.path), { p, o });
  const put = (key, it) => { const old = items.get(key); if (old) { for (const [k, v] of Object.entries(it)) if (old[k] == null || old[k] === '') old[k] = v; return old; } items.set(key, it); return it; };

  // 1. VideoHub's queue
  for (const j of jobs.list()) {
    if (j.state === 'done' && j.outputPath) {
      put(keyOf(j.outputPath), { source: 'queue', state: 'done', file: j.outputPath, rel: j.output || null, log: j.log || null, projectId: j.project, projectName: j.projectName, version: j.version ?? null,
        finishedAt: iso(j.finishedAt), durationSec: j.durationSec ?? null, session: j.session?.title || null, manual: !j.session, mode: j.mode, copiedTo: j.copiedTo || null, jobId: j.id });
    } else if (['failed', 'cancelled'].includes(j.state)) {
      out.push({ key: 'job:' + j.id, source: 'queue', state: j.state, file: null, projectId: j.project, projectName: j.projectName, finishedAt: iso(j.finishedAt || j.createdAt),
        session: j.session?.title || null, manual: !j.session, mode: j.mode, error: j.error || (j.state === 'cancelled' ? 'cancelled' : null), log: j.log || null, jobId: j.id });
    }
  }
  // 2. versions registered by chats (and by the queue: merged by file)
  for (const p of projects) {
    let vs = []; try { vs = readJson(path.join(vhDir(p), 'versions.json'), []); } catch { }
    for (const v of vs) {
      if (!v?.file) continue;
      const o = (p.outputs || []).find((x) => x.rel === v.file);
      const f = o ? o.path : path.join(p.path, v.file);
      put(keyOf(f), { source: v.job ? 'queue' : 'chat', state: 'done', file: f, rel: v.file, projectId: p.id, projectName: p.title || p.name, version: v.v ?? null, finishedAt: iso(v.created),
        session: v.session?.title || null, manual: !v.session, mode: v.mode || v.kind || null, kind: v.kind || null });
    }
  }
  // 3. films the scan found (renders nobody registered)
  for (const p of projects) for (const o of p.outputs || []) {
    if (!['final', 'web', 'preview'].includes(o.role)) continue;
    put(keyOf(o.path), { source: 'scan', state: 'done', file: o.path, projectId: p.id, projectName: p.title || p.name, version: vOfName(o.name), finishedAt: iso(o.mtime),
      session: null, manual: null, mode: o.role === 'preview' ? 'preview' : null });
  }
  // file facts from the scan (length, size, its name in the project for the review player)
  for (const [k, it] of items) {
    const m = byPath.get(k);
    let st = null; try { st = fs.statSync(it.file); } catch { }
    it.key = k; it.exists = !!st?.isFile(); it.size = st ? st.size : null;
    if (m) { it.rel = m.o.rel; it.dur = m.o.dur || null; it.role = m.o.role; it.projectId = it.projectId || m.p.id; }
    if (!it.finishedAt && st) it.finishedAt = iso(st.mtimeMs);
    out.push(it);
  }
  // 4. renders RenderGuard saw end outside the queue (a chat's own render.js / make.mjs), when VideoHub has no file for them
  const hist = guardHistory(600);
  for (const g of hist) {
    if (!/^FINISHED|^ERROR|^KILLED|^STOPPED/i.test(g.event) || refersToHub(guardPath(g.project))) continue;   // the hub's own processes, by path (films live in Documents\VideoHub\films)
    if (!/render|make\.mjs|chunks|--range/i.test(g.detail)) continue;
    // a minute or more (muxing, probes and checks are seconds)
    const dm = /(\d+)\s*(s|min|h)\b/.exec(g.detail), secs = dm ? +dm[1] * ({ s: 1, min: 60, h: 3600 }[dm[2]]) : 0;
    if (secs < 60) continue;
    // already in the list: a render of the same folder that ended within 15 min (the queue's own, or a version a chat registered)
    const at = Date.parse(g.at) || 0, seg = String(g.project || '').split(/[\\/]/).pop().toLowerCase();
    if (seg && out.some((x) => x.file && x.file.toLowerCase().replace(/\//g, '\\').includes('\\' + seg + '\\') && Math.abs((Date.parse(x.finishedAt) || 0) - at) < 15 * 60e3)) continue;
    out.push({ key: 'guard:' + g.at + g.project, source: 'RenderGuard', state: /^FINISHED/i.test(g.event) ? 'done' : 'failed', file: null, projectName: g.project, finishedAt: iso(g.at),
      session: g.session || null, manual: !g.session, mode: null, error: /^FINISHED/i.test(g.event) ? null : g.event, detail: g.detail });
  }
  return out;
}

// running jobs: progress and whether they look stuck (no progress line for 10 min)
function active() {
  return jobs.list().filter((j) => j.state === 'running' || j.state === 'queued').map((j) => {
    const lastAt = j.progressAt || Date.parse(j.startedAt || j.createdAt || '') || Date.now();
    return { jobId: j.id, projectId: j.project, projectName: j.projectName, state: j.state, mode: j.mode, progress: j.progress || 0, session: j.session?.title || null,
      startedAt: j.startedAt || null, quietMin: Math.round((Date.now() - lastAt) / 60e3), stuck: j.state === 'running' && Date.now() - lastAt > STUCK_MS, log: j.log || null };
  });
}

export function outputs(limit = 150) {
  const all = collect().sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  let s = seenMap();
  if (!s) { s = seen = {}; for (const it of all) if (it.exists) s[it.key] = new Date().toISOString(); saveSeen(); }   // first run: what is there now is not news
  for (const it of all) it.isNew = it.state === 'done' && !!it.exists && !s[it.key];
  return { items: all.slice(0, limit), unseen: all.filter((x) => x.isNew).length, active: active() };
}
export function markSeen(key) { const s = seenMap() || (seen = {}); if (key) s[key.includes(':') && !/^[a-z]:\\/i.test(key) ? key : keyOf(key)] = new Date().toISOString(); saveSeen(); }
export function markAllSeen() { const s = seenMap() || (seen = {}); for (const it of collect()) if (it.exists) s[it.key] = s[it.key] || new Date().toISOString(); saveSeen(); }

// a Windows notification (the hub's PC): render finished or failed. Nothing on test hubs.
export function notifyWindows(title, body) {
  if (process.env.VIDEOHUB_NO_WINDOW) return;
  const q = (s) => "'" + String(s || '').replace(/'/g, "''").slice(0, 200) + "'";
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$t = $x.GetElementsByTagName("text")', `$t.Item(0).AppendChild($x.CreateTextNode(${q(title)})) | Out-Null`, `$t.Item(1).AppendChild($x.CreateTextNode(${q(body)})) | Out-Null`,
    '$n = [Windows.UI.Notifications.ToastNotification]::new($x)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($n)',
  ].join('; ');
  try { spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: 'ignore', detached: true }).unref(); } catch { }
}

export function routes(route, readBody) {
  route('GET', '/api/outputs', (req, url) => outputs(Math.min(1000, +(url.searchParams.get('limit') || 150))));
  route('POST', '/api/outputs/seen', async (req) => { const b = await readBody(req); if (b.all) markAllSeen(); else markSeen(b.key || b.path); return { ok: true, unseen: outputs(1).unseen }; });
}
