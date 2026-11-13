// VideoHub's render protection, built into the hub (plain Node + Windows' own PowerShell, or nice + taskset on Linux; no helper program).
// Nov 2026: the old C# agent (guard\VideoHubAgent.exe, formerly RenderGuard.exe, compiled on each PC at install) is gone.
// Windows Smart App Control blocks unsigned programs it has never seen, and its low-level calls (reading other
// processes' memory, freezing processes, global hotkeys) looked like malware to antivirus tools.
// What protection still does:
//  - every render VideoHub's queue starts gets a CPU limit (processor affinity: a share of the cores) and low priority;
//    Windows passes both on to every process the render starts later (Chrome, ffmpeg)
//  - free RAM is watched: below PauseMB the newest render slows down (idle priority, SlowCapPct of the cores), below
//    CriticalMB every render does; when RAM is back they return to normal speed, oldest first
//  - Slow down / Normal speed / Stop per render on the Renders page
// What it no longer does: freeze (pause) a render, the Ctrl+Alt+End / Ctrl+Alt+Home hotkeys, and watching renders that
// were started outside VideoHub's queue. The exported names stay the same, so the queue, cleanup and UI did not change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { APPDATA, HUB_DIR, IS_WIN, readJson, run, processAlive } from './util.js';

const RG = path.join(APPDATA, 'RenderGuard');   // settings.txt and the old agent's history.log (folder name kept)
const MB = 1048576, CORES = os.cpus().length;

// ---------- settings (settings.txt, key=value). VideoHub is its only UI.
const SETTINGS = path.join(RG, 'settings.txt');
const DEFAULTS = { CapActive: 90, CapIdle: 100, IdleMin: 2, PauseMB: 700, CriticalMB: 500, SlowCapPct: 5, LowPrio: 1 };
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// "Windows açılınca başlat" starts VideoHub itself, without a window (open.vbs --server). Older builds had a "RenderGuard"
// entry that started RenderGuard.exe: it is removed whenever the setting is saved.
const RUN_NAME = 'VideoHub', RUN_LEGACY = 'RenderGuard';
const startupCommand = () => `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')}" "${path.join(HUB_DIR, 'open.vbs')}" --server`;
function readKv() {
  const kv = {}; let txt = ''; try { txt = fs.readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, ''); } catch { }
  for (const l of txt.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return kv;
}
function current() {
  const kv = readKv(), out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) out[k] = kv[k] != null && kv[k] !== '' && Number.isFinite(+kv[k]) ? +kv[k] : d;
  return out;
}
let S = current();
export async function guardSettings() {
  const out = current();
  const r = IS_WIN ? await run('reg', ['query', RUN_KEY, '/v', RUN_NAME]) : { code: 1 };   // Linux: no "start with Windows"
  out.Startup = r.code === 0 && /open\.vbs/i.test(r.stdout);
  out.exe = null; out.builtIn = true;
  return out;
}
export async function saveGuardSettings(patch) {
  const kv = readKv();
  for (const k of Object.keys(DEFAULTS)) if (patch[k] != null) kv[k] = String(typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : Math.round(+patch[k]));
  fs.mkdirSync(RG, { recursive: true });
  fs.writeFileSync(SETTINGS, Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\r\n'));
  if (IS_WIN && patch.Startup != null) {
    if (patch.Startup) await run('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', startupCommand(), '/f']);
    else await run('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
  }
  if (IS_WIN) await run('reg', ['delete', RUN_KEY, '/v', RUN_LEGACY, '/f']);   // the old agent's autostart, if an old install left it
  guardCommand('reload');
  return guardSettings();
}
// there is no agent program any more (kept for callers and old UIs)
export const guardExe = () => null;

// ---------- the renders VideoHub started (the queue tells us: guardTrack) and what was applied to them
const tracked = new Map();   // root pid -> { rootPid, start, cwd, project, what, slow: null|'RAM'|'manual', applied, changedAt }
let timer = null, lastRamChange = 0, updated = null;
export function guardTrack(pid, info = {}) {
  if (!pid) return;
  tracked.set(pid, { rootPid: pid, start: new Date().toISOString(), cwd: info.cwd || '', project: info.project || '', what: info.what || '', slow: null, applied: null, changedAt: 0 });
  if (timer) apply(tracked.get(pid)).catch(() => { });
}

const PRIO = { Idle: os.constants.priority.PRIORITY_LOW, BelowNormal: os.constants.priority.PRIORITY_BELOW_NORMAL, Normal: os.constants.priority.PRIORITY_NORMAL };
const coresFor = pct => Math.max(1, Math.min(CORES, Math.round(CORES * Math.max(1, Math.min(100, pct)) / 100)));
// the top N cores (core 0 is where Windows itself is busiest); all N = every core (lifts an earlier limit).
// null: more than 63 cores, where one affinity mask cannot name them all (priority still applies).
function mask(n) {
  if (CORES > 63) return null;
  n = Math.min(n, CORES);
  return ((1n << BigInt(n)) - 1n) << BigInt(CORES - n);
}
function wanted(r) {
  if (!timer) return { prio: 'Normal', cores: CORES };   // protection off (the hub is closing): everything back to normal
  if (r.slow) return { prio: 'Idle', cores: coresFor(S.SlowCapPct) };
  return { prio: S.LowPrio ? 'BelowNormal' : 'Normal', cores: coresFor(S.CapActive) };
}
// priority of the root at once (Node); affinity + priority of the whole process tree through Windows' PowerShell
// (one short script per change, never a poll). Processes the render starts later inherit both.
async function apply(r, force = false) {
  const w = wanted(r), key = w.prio + '/' + w.cores;
  if (!force && r.applied === key) return;
  r.applied = key;
  try { os.setPriority(r.rootPid, PRIO[w.prio]); } catch { }
  const aff = mask(w.cores);
  if (!IS_WIN) return applyLinux(r.rootPid, PRIO[w.prio], aff);
  const script = [
    `$ids = @(${r.rootPid}); $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)`,
    'do { $n = $ids.Count; $ids = @($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId })) } while ($ids.Count -gt $n)',
    `foreach ($i in $ids) { try { $p = Get-Process -Id $i -ErrorAction Stop; $p.PriorityClass = '${w.prio}'${aff != null ? `; $p.ProcessorAffinity = [IntPtr]${aff}` : ''} } catch { } }`,
  ].join('\n');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

// Linux (RunPod pods): the same limits through /proc, os.setPriority (nice) and taskset; children started later inherit both
export function procTree(root, procDir = '/proc') {
  const kids = new Map();
  let ents = []; try { ents = fs.readdirSync(procDir).filter(n => /^\d+$/.test(n)); } catch { return [root]; }
  for (const n of ents) {
    let st; try { st = fs.readFileSync(path.join(procDir, n, 'stat'), 'utf8'); } catch { continue; }
    const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];   // the name in (…) may hold spaces
    if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(+n);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) || []) if (!out.includes(k)) out.push(k);
  return out;
}
async function applyLinux(rootPid, prio, aff) {
  for (const pid of procTree(rootPid)) {
    try { os.setPriority(pid, prio); } catch { }
    if (aff != null) await run('taskset', ['-a', '-p', aff.toString(16), String(pid)]);
  }
}
export function killTree(rootPid) {
  if (IS_WIN) return run('taskkill', ['/PID', String(rootPid), '/T', '/F']);
  for (const pid of procTree(rootPid).reverse()) try { process.kill(pid, 'SIGKILL'); } catch { }
}

// every 3 s while protection is on: forget renders that ended, slow down / restore for RAM
function tick() {
  for (const [pid] of tracked) if (!processAlive(pid)) tracked.delete(pid);
  const free = os.freemem() / MB, list = [...tracked.values()].sort((a, b) => a.start.localeCompare(b.start));
  updated = new Date().toISOString();
  if (!list.length || Date.now() - lastRamChange < 20e3) return;   // one change at a time, then 20 s to settle (no ping-pong)
  const ram = list.filter(r => r.slow === 'RAM'), normal = list.filter(r => !r.slow);
  let pick = null, slow = null;
  if (free < S.CriticalMB && normal.length) { pick = normal[0]; slow = 'RAM'; }                         // even the oldest
  else if (free < S.PauseMB && normal.length > 1) { pick = normal[normal.length - 1]; slow = 'RAM'; }   // the newest first
  else if (free > S.PauseMB + 500 && ram.length) { pick = ram[0]; slow = null; }                       // back, oldest first
  if (!pick) return;
  pick.slow = slow; lastRamChange = Date.now();
  apply(pick).catch(() => { });
}

// live state (same shape the old agent wrote to state.json)
export function guardState() {
  if (!timer) return { running: false, reason: 'render protection is off' };
  const free = os.freemem() / MB;
  return {
    running: true, builtIn: true, updated: updated || new Date().toISOString(), age: 0,
    ramAvailMB: Math.round(free), ramTotalMB: Math.round(os.totalmem() / MB), cpu: null, capNow: S.CapActive, hotkeys: false,
    pauseMB: S.PauseMB, criticalMB: S.CriticalMB, slowCapPct: S.SlowCapPct,
    renders: [...tracked.values()].map(r => ({ rootPid: r.rootPid, start: r.start, project: r.project, cwd: r.cwd, cmd: '', what: r.what, slow: r.slow, paused: false, cpu: null, ramMB: null })),
    settings: { ...S },
  };
}

// Renders page buttons and old callers. Freezing is gone: "pause" now slows the render down to the minimum instead.
export function guardCommand(action, rootPid) {
  const pick = rootPid ? [tracked.get(+rootPid)].filter(Boolean) : [...tracked.values()];
  let note = null;
  if (action === 'reload') { S = current(); for (const r of tracked.values()) apply(r).catch(() => { }); return { ok: true, note }; }
  if (action === 'kill') { for (const r of pick) killTree(r.rootPid); return { ok: true, note }; }
  if (/^(pause|pauseAll|slow)$/.test(action)) { if (action !== 'slow') note = 'Pausing is no longer available: the render was slowed down to the minimum instead.'; for (const r of pick) { r.slow = 'manual'; apply(r).catch(() => { }); } }
  else if (/^(resume|resumeAll|normal)$/.test(action)) for (const r of pick) { r.slow = null; apply(r).catch(() => { }); }
  else return { ok: false, note: 'unknown command' };
  if (!timer) note = 'Render protection is off right now.';
  return { ok: true, note };
}

// on while VideoHub is used (a page is open or a render runs); off when the hub idles out: renders back to normal
export async function guardProcRunning() { return !!timer; }
export async function ensureGuard() {
  if (timer) return false;
  S = current(); timer = setInterval(tick, 3000); timer.unref(); tick();
  for (const r of tracked.values()) apply(r, true).catch(() => { });
  return true;
}
export async function quitGuard() {
  if (!timer) return true;
  clearInterval(timer); timer = null;
  await Promise.all([...tracked.values()].map(r => apply(r, true).catch(() => { })));
  return true;
}

// ---------- the old agent's history.log (renders it saw end, also outside the queue): still read, no longer written
// "2026-10-23 18:07:04  BİTTİ     <session>  [<project>]  <what>  <dur>  %NN". Parsed once, kept by size+mtime.
const parseLine = l => {
  const m = l.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\S+(?: \([^)]*\))?)\s+(.*)$/);
  if (!m) return null;
  const rest = m[3], pm = rest.match(/\[([^\]]*)\]/);
  return { at: m[1].replace(' ', 'T'), event: m[2].trim(), session: pm ? rest.slice(0, pm.index).trim() : '', project: pm ? pm[1] : '', detail: pm ? rest.slice(pm.index + pm[0].length).trim() : rest };
};
let hist = null;
export function guardHistory(limit = 400) {
  const f = path.join(RG, 'history.log');
  let st; try { st = fs.statSync(f); } catch { return []; }
  if (!hist || hist.size !== st.size || hist.mtime !== st.mtimeMs) {
    try { hist = { size: st.size, mtime: st.mtimeMs, all: fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(parseLine) }; } catch { return []; }
  }
  return hist.all.slice(-limit).filter(Boolean).reverse();
}

// Snipp writes <cikti>\.renders\<name>.json (RenderStatus v1) for every export
export function snippRenders() {
  const out = [];
  for (const r of config().roots) {
    if (r.enabled === false) continue;
    const dir = path.join(r.path, '.renders');
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const j = readJson(path.join(dir, f)); if (!j) continue;
      let mtime = 0; try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch { }
      out.push({ source: 'snipp', name: f.replace(/\.json$/, ''), state: j.state, progress: j.progress, label: j.label, output: j.output, error: j.error, updated: mtime });
    }
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, 50);
}
