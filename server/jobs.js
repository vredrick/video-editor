// Render queue: one render at a time on this computer (also waits while a render started elsewhere is running).
// Partial renders re-render only the chunks a note touches, concatenate the film again, put the previous
// final's audio back on, and register the result as a new version with the seconds that changed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkOutput } from './ciktilar.js';
import { pickFolder as pickFolderWin } from './pickfolder.js';
import { config } from './config.js';
import { project, rescanProject } from './scan.js';
import { guardState, guardTrack, killTree } from './guard.js';
import { ramHogsNow, ramNote } from './ramhogs.js';
import { vhDir, list as listNotes, update as updateNote } from './notes.js';
import { DATA_DIR, HUB_DIR, IS_WIN, readJson, writeJson, run, TOOLS, now, pLimit, refersToHub, isInside } from './util.js';
import { audioOf } from './live.js';
import { ENCODERS, LABELS, encoderEnv } from './encoders.js';

const FILE = path.join(DATA_DIR, 'jobs.json');
let jobs = readJson(FILE, []);
const listeners = new Set();
const procs = new Map();
const executing = new Set(); // Includes preparation, validation and muxing, even after cancellation was requested.
export const onJob = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (type, job) => { if (type === 'progress' || type === 'running') job.progressAt = Date.now(); save(); for (const fn of listeners) try { fn({ type, job: pub(job) }); } catch { } };
const save = () => writeJson(FILE, jobs.slice(-200));
const pub = j => j && ({ ...j });
export const list = () => { const q = jobs.filter(j => j.state === 'queued'); return jobs.slice().reverse().map(j => ({ ...j, position: j.state === 'queued' ? q.indexOf(j) + 1 : null })); };
export const get = id => jobs.find(j => j.id === id) || null;
export const busy = () => jobs.some(j => j.state === 'running' || j.state === 'queued');

// ---------- render recipe of a project
// A 3D studio scene (a studio folder with make.mjs: scenes/<name>) renders through the studio's make.mjs into out/<name>; its chunks,
// manifest, logs and new versions live there. Everything else renders in its own folder.
const rdir = p => p.studio ? p.outDir : p.path;
function chunkDir(p) { return path.join(rdir(p), 'render', 'chunks'); }
// a file's name in the project's outputs/versions (studio outputs are listed as out\<file>)
const relOf = (p, file) => p.studio && path.resolve(file).toLowerCase().startsWith(path.resolve(p.outDir).toLowerCase() + path.sep) ? path.join('out', path.relative(p.outDir, file)) : path.relative(p.path, file);
function chunkFiles(p) { try { return fs.readdirSync(chunkDir(p)).filter(f => /^c_\d{3,}\.mp4$/.test(f)).sort(); } catch { return []; } }
async function framesOf(file, job) {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file];
  const r = job ? await spawnLogged(job, TOOLS.ffprobe, args) : await run(TOOLS.ffprobe, args);
  return parseInt(r.stdout, 10) || 0;   // ffprobe prints "120," here
}
// DUR is not stored anywhere in older projects: work it out from the chunks on disk
export async function recipe(p) {
  const meta = readJson(path.join(vhDir(p), 'project.json'), {});
  // a 2D studio scene (film2d, Canvas2D) waits on the GPU, not on its work: 3 Chrome copies render it 19 % faster than 2
  // (measured on a 7-minute 2D film: 30.5 -> 36.3 fps; 4 copies 37.7). 3D scenes stay at 2.
  const is2d = () => { try { return /film2d/.test(fs.readFileSync(path.join(p.path, 'scene.js'), 'utf8')); } catch { return false; } };
  const r = { workers: p.studio ? (is2d() ? 3 : 2) : 1, env: {}, ...(meta.render || {}) };
  r.script = r.script || p.render?.script || 'render.js';
  r.fps = r.fps || p.render?.fps || 60;
  r.chunkFrames = r.chunkFrames || p.render?.chunkFrames || null;
  r.chunkSec = r.chunkFrames ? r.chunkFrames / r.fps : null;
  if (p.studio) r.script = null;
  const man = readJson(path.join(rdir(p), 'render', 'manifest.json'));
  if (p.studio && man) { r.fps = man.fps; r.chunkFrames = man.chunkFrames; r.chunkSec = man.chunkSec || man.chunkFrames / man.fps; r.studio = true; }
  if (!r.env.DUR && man?.dur) r.env.DUR = String(man.dur);
  if (!r.env.DUR && r.chunkFrames) {
    const files = chunkFiles(p);
    const last = files[files.length - 1];
    if (last) {
      const n = +last.match(/\d+/)[0] + 1, lastFrames = await framesOf(path.join(chunkDir(p), last));
      r.env.DUR = String(+(((n - 1) * r.chunkFrames + lastFrames) / r.fps).toFixed(3)); r.durInferred = true;
    }
  }
  r.chunks = r.chunkFrames && r.env.DUR ? Math.ceil(Math.round(+r.env.DUR * r.fps) / r.chunkFrames) : null;
  return r;
}

const merge = rs => { const s = rs.slice().sort((a, b) => a[0] - b[0]), o = []; for (const [a, b] of s) { const l = o[o.length - 1]; if (l && a <= l[1] + 1e-6) l[1] = Math.max(l[1], b); else o.push([a, b]); } return o; };

// ---------- create
export async function create(body) {
  const p = project(body.project); if (!p) throw Object.assign(new Error('Project not found: ' + body.project), { code: 404 });
  const rc = await recipe(p);
  const mode = body.mode || 'partial';
  if (!['partial', 'full', 'preview', 'command'].includes(mode)) throw Object.assign(new Error('mode: partial | full | preview | command'), { code: 400 });
  const workers = +(body.workers ?? rc.workers ?? 1);
  if (!Number.isInteger(workers) || workers < 1 || workers > (p.studio ? 4 : 8)) throw Object.assign(new Error('Invalid number of render workers.'), { code: 400 });
  const job = { id: 'j' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8), project: p.id, projectName: p.title || p.name, path: p.path, mode, state: 'queued', createdAt: now(), session: body.session || null, notes: body.notes || [], env: { ...rc.env, ...(body.env || {}) }, workers, progress: 0 };
  if (mode === 'partial') {
    if (p.studio && !rc.chunkSec) throw Object.assign(new Error(`This 3D scene has no chunked render yet (out\\${p.name}\\render\\manifest.json). Render it in full once first: hub_render({mode:"full"}) or node make.mjs ${p.name}.`), { code: 400 });
    if (!p.studio && (p.family !== 'A' || !rc.chunkSec)) throw Object.assign(new Error(`Partial renders need a chunked render script (family A, see docs/PROJECT-CONTRACT.md) or a 3D studio scene; this project is "${p.family}". Use mode:"full", or mode:"command" with your own command.`), { code: 400 });
    let chunks = new Set(body.chunks || []);
    for (const [a, b] of body.seconds || []) for (let c = Math.floor(Math.max(0, a) / rc.chunkSec); c <= Math.floor(Math.max(a, b - 1e-6) / rc.chunkSec); c++) chunks.add(c);
    if (job.notes.length) { const ns = listNotes(p).filter(n => job.notes.includes(n.id)); for (const n of ns) { const a = Math.max(0, Math.min(n.t - 0.5, n.at ?? Infinity)), b = Math.max((n.t2 ?? n.t) + 0.5, n.at != null ? n.at + 0.5 : 0); for (let c = Math.floor(a / rc.chunkSec); c <= Math.floor(b / rc.chunkSec); c++) chunks.add(c); } }
    chunks = [...chunks].filter(c => c >= 0 && (rc.chunks == null || c < rc.chunks)).sort((a, b) => a - b);
    if (!chunks.length) throw Object.assign(new Error('Which chunks to re-render is not clear (give notes, seconds or chunks).'), { code: 400 });
    job.chunks = chunks; job.changedRanges = merge(chunks.map(c => [c * rc.chunkSec, Math.min((c + 1) * rc.chunkSec, +rc.env.DUR || Infinity)]));
  } else if (mode === 'command') {
    if (!body.cmd) throw Object.assign(new Error('mode "command" needs cmd'), { code: 400 });
    job.cmd = body.cmd; job.output = body.output || null;
    // a custom command is any command line: it waits in the queue until the user approves it on the Renders page
    if (config().render?.confirmCommands !== false) { job.needsApproval = true; job.waiting = APPROVAL; }
  } else if (mode === 'preview') {
    if (p.studio) throw Object.assign(new Error('3D scenes have no preview render; the live preview (hub_live) shows them without rendering.'), { code: 400 });
    job.env.PREVIEW = '1';
  }
  job.dur = +rc.env.DUR || null;
  if (body.copyTo && mode !== 'command') {
    if (!path.isAbsolute(String(body.copyTo))) throw Object.assign(new Error('The copy folder must be a full path (e.g. D:\\Videos)'), { code: 400 });
    job.copyTo = path.resolve(String(body.copyTo));
  }
  // big programs holding RAM (an Android emulator can take 8 GB of 16): hub_render tells Claude, Claude tells the user
  job.ramNote = ramNote(await ramHogsNow().catch(() => []), guardState().ramAvailMB);
  // Check after the awaits too: simultaneous clicks from two windows must not queue the same film twice.
  if (jobs.some(j => j.project === p.id && (['queued', 'running'].includes(j.state) || executing.has(j.id)))) {
    throw Object.assign(new Error('This project already has a render queued or running.'), { code: 409 });
  }
  jobs.push(job); emit('queued', job); if (job.needsApproval) emit('approval', job); pump();
  return { ...job, position: jobs.filter(j => j.state === 'queued').length };
}

// ---------- run
const APPROVAL = 'waiting for your approval in VideoHub (custom command)';
let pumping = false, waitTimer = null;   // one pending retry while a render elsewhere runs (not one more 5 s chain per call)
// wait while a render started elsewhere is actually running; renders frozen for RAM only block
// us while free RAM is short (otherwise a forgotten frozen render would block the queue forever)
function busyElsewhere() {
  const g = guardState(); if (!g.running) return null;
  const ours = new Set([...procs.values()].flatMap(children => [...children].map(child => child.pid)));
  const others = (g.renders || []).filter(r => !ours.has(r.rootPid) && !refersToHub((r.cmd || '') + ' ' + (r.cwd || '')));
  const active = others.find(r => !r.paused);
  if (active) return `${active.session?.title || 'another session'} · ${active.project || ''} is rendering`;
  if (others.length && (g.ramAvailMB || 0) < 3000) return `low RAM (${Math.round(g.ramAvailMB)} MB free) and a paused render`;
  return null;
}
async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (true) {
      const running = executing.size;
      const next = jobs.find(j => j.state === 'queued' && !j.needsApproval);
      if (!next || running >= (config().maxParallelRenders || 1)) break;
      const other = busyElsewhere();
      if (other) { if (next.waiting !== other) { next.waiting = other; emit('waiting', next); } if (!waitTimer) waitTimer = setTimeout(() => { waitTimer = null; pump(); }, 5000); break; }
      next.waiting = null;
      executing.add(next.id);
      runJob(next).catch(e => { restoreChunks(next); if (next.state === 'cancelled') return; next.state = 'failed'; next.error = String(e.message || e); next.finishedAt = now(); emit('failed', next); }).finally(() => { executing.delete(next.id); setTimeout(pump, 500); });
    }
  } finally { pumping = false; }
}

// a partial render that failed or was cancelled: put every backed-up chunk whose place is still empty back, so the
// film's chunk set stays whole (a later partial render would fail with "Only N of M chunks exist")
function restoreChunks(job) {
  if (job.mode !== 'partial' || !job.chunkBackup) return;
  const p = project(job.project); if (!p) return;
  for (const c of job.chunks || []) {
    const n = `c_${String(c).padStart(3, '0')}.mp4`, f = path.join(chunkDir(p), n), b = path.join(job.chunkBackup, n);
    try { if (!fs.existsSync(f) && fs.existsSync(b)) { fs.mkdirSync(chunkDir(p), { recursive: true }); fs.renameSync(b, f); } } catch { }
  }
}
// a free name for `f` (x, x_2, x_3 ...): renames never overwrite, and renaming a folder onto an existing one fails on Windows
const freeName = f => { const ext = path.extname(f), b = f.slice(0, f.length - ext.length); let d = f; for (let i = 2; fs.existsSync(d); i++) d = `${b}_${i}${ext}`; return d; };

function assertActive(job) {
  if (job?.state === 'cancelled') throw Object.assign(new Error('Render cancelled.'), { code: 'CANCELLED' });
}

function setPhase(job, phase) {
  assertActive(job);
  if (job.phase && job.phaseStartedAt) {
    job.phaseSeconds ||= {};
    job.phaseSeconds[job.phase] = (job.phaseSeconds[job.phase] || 0) + (Date.now() - job.phaseStartedAt) / 1000;
  }
  job.phase = phase; job.phaseStartedAt = Date.now(); emit('progress', job);
}

function spawnLogged(job, cmd, args, opts = {}) {
  assertActive(job);
  return new Promise((resolve) => {
    const log = fs.createWriteStream(job.log, { flags: 'a' });
    log.write(`\n# ${now()}  ${cmd} ${args.join(' ')}\n`);
    const child = spawn(cmd, args, { ...opts, windowsHide: true, shell: opts.shell || false });
    const children = procs.get(job.id) || new Set(); children.add(child); procs.set(job.id, children);
    job.pid = child.pid; guardTrack(child.pid, { cwd: opts.cwd || '', project: job.projectName || '', what: job.mode || '' }); emit('running', job);
    let q0 = null, done = 0, t0 = Date.now(), stdout = '', stderr = '', settled = false;
    const lines = { stdout: '', stderr: '' };
    const onLine = line => {
        let m = line.match(/^(\d+)\/(\d+) chunks(?: to render|,)/); if (m) { q0 = +m[1]; return; }
        // spotlight-shorts style: "[w0] chunk 3 ok  12/20  85s" (done / all chunks)
        m = line.match(/chunk \d+ ok\s+(\d+)\/(\d+)\s/); if (m) { const d = +m[1], all = +m[2]; done++; job.progress = Math.min(0.99, d / all); job.etaSec = (all - d) * (Date.now() - t0) / 1000 / done; emit('progress', job); return; }
        m = line.match(/chunk \d+ ok\D+(\d+) done/); if (m && q0) { done = +m[1]; job.progress = Math.min(0.99, done / q0); job.etaSec = done ? (q0 - done) * (Date.now() - t0) / 1000 / done : null; emit('progress', job); return; }
        m = line.match(/\bw\d+\]?\s+(\d+)\/(\d+)/); if (m) { job.progress = Math.min(0.99, +m[1] / +m[2]); emit('progress', job); }
    };
    const onData = (d, stream) => {
      log.write(d);
      if (stream === 'stdout') stdout = (stdout + d).slice(-65536); else stderr = (stderr + d).slice(-65536);
      const parts = (lines[stream] + String(d)).split(/\r?\n/); lines[stream] = parts.pop();
      if (job.state !== 'cancelled') for (const line of parts) onLine(line);
    };
    child.stdout.on('data', d => onData(d, 'stdout')); child.stderr.on('data', d => onData(d, 'stderr'));
    const settle = code => {
      if (settled) return; settled = true;
      if (job.state !== 'cancelled') for (const line of Object.values(lines)) if (line) onLine(line);
      children.delete(child); if (!children.size && procs.get(job.id) === children) procs.delete(job.id);
      log.end(); resolve({ code, stdout, stderr });
    };
    child.on('close', settle);
    child.on('error', e => { stderr += e.message; log.write('spawn error: ' + e.message + '\n'); settle(-1); });
  });
}

async function runJob(job) {
  const p = project(job.project); if (!p) throw new Error('The project is gone');
  job.state = 'running'; job.startedAt = now(); job.log = path.join(rdir(p), 'render', `videohub-${job.id}.log`);
  fs.mkdirSync(path.dirname(job.log), { recursive: true });
  job.ramNote = ramNote(await ramHogsNow().catch(() => []), guardState().ramAvailMB);
  if (job.ramNote) fs.appendFileSync(job.log, `\n# ${now()}  ${job.ramNote}\n`);
  emit('running', job);
  setPhase(job, 'prepare');
  const rc = await recipe(p);
  assertActive(job);
  // VIDEOHUB_DIR: render scripts may load puppeteer-core from VideoHub's node_modules; VIDEOHUB_ENCODER: the encoder chosen in
  // setup/Settings (render.encoder) unless the job sets its own (scripts that do not read it are not affected); CHROME: on Linux
  // the Chromium VideoHub found (there is no Edge), so render scripts use the same browser
  const env = { ...(!IS_WIN && TOOLS.chrome ? { CHROME: TOOLS.chrome } : {}), ...process.env, ...(job.workers ? { WK: String(job.workers) } : {}), ...encoderEnv(job.env, config().render?.encoder), ...job.env, VIDEOHUB_JOB: job.id, VIDEOHUB_DIR: HUB_DIR };
  const versions = readJson(path.join(vhDir(p), 'versions.json'), []);
  const vN = Math.max(versions.reduce((m, v) => Math.max(m, v.v || 0), 0), maxNameVersion(p)) + 1;

  if (job.mode === 'command') {
    setPhase(job, 'render');
    // quoted whole and passed verbatim: Node would escape inner quotes as \" which cmd.exe does not understand
    const { code } = await spawnLogged(job, 'cmd.exe', ['/d', '/s', '/c', '"' + job.cmd + '"'], { cwd: p.path, env, windowsVerbatimArguments: true });
    assertActive(job);
    if (code !== 0) throw new Error(`The command ended with code ${code} (log: ${job.log})`);
    if (job.output) await register(p, job, path.resolve(p.path, job.output), vN, job.changedRanges || null);
    return finish(p, job);
  }

  if (job.mode === 'partial') {
    // keep the chunks being replaced, so the old version can still be compared or restored
    // a retry after a failed render finds the good backup already there: never overwrite it (the chunk in the way goes to c_NNN_2.mp4)
    const bak = job.chunkBackup = path.join(rdir(p), 'render', `chunks_v${vN - 1}`);
    fs.mkdirSync(bak, { recursive: true });
    for (const c of job.chunks) { const f = path.join(chunkDir(p), `c_${String(c).padStart(3, '0')}.mp4`); if (fs.existsSync(f)) fs.renameSync(f, freeName(path.join(bak, path.basename(f)))); }
    if (p.render?.supportsOnly) env.ONLY = job.chunks.join(',');
  }
  if (job.mode === 'full') {
    // vN does not advance after a failed or cancelled render: the retry takes chunks_vN_2, _3 ... (names the janitor and scan know)
    if (fs.existsSync(chunkDir(p))) fs.renameSync(chunkDir(p), freeName(path.join(rdir(p), 'render', `chunks_v${vN - 1}`)));
  }
  // a studio scene: the studio's make.mjs makes only the chunks (all of them, or --only the touched ones)
  setPhase(job, 'render');
  const { code } = p.studio
    ? await spawnLogged(job, TOOLS.node, ['make.mjs', p.name, '--chunks', ...(job.chunks ? ['--only', job.chunks.join(',')] : []), '--jobs', String(job.workers)], { cwd: p.studio, env })
    : await spawnLogged(job, TOOLS.node, [rc.script, String(job.workers)], { cwd: p.path, env });
  assertActive(job);
  if (code !== 0) throw new Error(`The render ended with code ${code} (log: ${job.log})`);

  if (job.mode === 'preview') {
    const pv = ['render/preview/video.mp4', 'render/preview.mp4'].map(f => path.join(p.path, f)).find(f => fs.existsSync(f));
    if (!pv) throw new Error('No preview output found (render/preview/video.mp4). This project may not support PREVIEW=1.');
    setPhase(job, 'audio');
    await register(p, job, await withAudio(p, pv, path.join(p.path, `${baseOf(p)}_preview_v${vN}.mp4`), rc, job), vN, null, 'preview');
    return finish(p, job);
  }
  // check every chunk, then build the film again from all of them
  setPhase(job, 'validate');
  const files = chunkFiles(p);
  if (rc.chunks && files.length < rc.chunks) throw new Error(`Only ${files.length} of ${rc.chunks} chunks exist; some chunks are missing.`);
  if (job.chunks) {
    const bad = (await pLimit(job.chunks, 3, async c => ({ c, n: await framesOf(path.join(chunkDir(p), `c_${String(c).padStart(3, '0')}.mp4`), job) })))
      .filter(x => x.c < (rc.chunks || Infinity) - 1 && x.n !== rc.chunkFrames);
    if (bad.length) throw new Error('Chunks with the wrong frame count: ' + bad.map(x => `${x.c} (${x.n})`).join(', '));
  }
  const listFile = path.join(rdir(p), 'render', 'list.txt');
  setPhase(job, 'concat');
  fs.writeFileSync(listFile, files.map(f => `file '${path.join(chunkDir(p), f).split(path.sep).join('/')}'`).join('\n'));
  const video = path.join(rdir(p), 'render', 'video.mp4');
  const r = await spawnLogged(job, TOOLS.ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', video]);
  assertActive(job);
  if (r.code !== 0) throw new Error('Joining the chunks failed: ' + r.stderr.slice(0, 300));
  setPhase(job, 'audio');
  const out = await withAudio(p, video, path.join(rdir(p), `${baseOf(p)}_v${vN}.mp4`), rc, job);
  setPhase(job, 'register');
  await register(p, job, out, vN, job.changedRanges || null);
  return finish(p, job);
}

// the highest _vN in the film's video names; a film without numbers counts as v1, so its first queue render is v2 — a project
// with no film yet starts at v1
function maxNameVersion(p) { const films = p.outputs.filter(o => ['final', 'web', 'preview'].includes(o.role)); return films.reduce((m, o) => { const x = o.name.match(/_v(\d+)/i); return x ? Math.max(m, +x[1]) : m; }, films.length ? 1 : 0); }
// the project's last film (scan.js: test clips never count), else the newest final / web copy
const lastFilm = p => p.outputs.find(o => o.rel === p.latest && (o.role === 'final' || o.role === 'web'))
  || p.outputs.filter(o => o.role === 'final').sort((a, b) => b.mtime - a.mtime)[0] || null;
function baseOf(p) {
  const f = lastFilm(p) || p.outputs.find(o => o.role === 'web');
  let b = f ? f.name.replace(/\.[^.]+$/, '') : p.name;
  for (let i = 0; i < 4; i++) b = b.replace(/[_\- ](v\d+|web|1080p|2160p|preview)$/i, '');
  return b;
}
// audio: the project's own mux recipe if it has one, otherwise the previous final's audio track as is
async function withAudio(p, video, out, rc = {}, job) {
  if (p.studio) {   // the studio's own sound (audio.wav, loudness normalisation) exactly as a full make.mjs render adds it
    const r = await spawnLogged(job, TOOLS.node, ['make.mjs', p.name, '--mux', video, out], { cwd: p.studio });
    assertActive(job);
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Adding the sound (make.mjs --mux) failed: ' + (r.stderr || r.stdout).slice(-300));
    return out;
  }
  const meta = readJson(path.join(vhDir(p), 'project.json'), {});
  if (Array.isArray(meta.render?.mux) && meta.render.mux.length) {
    const args = meta.render.mux.map(a => a.replace('{video}', video).replace('{out}', out));
    const r = await spawnLogged(job, TOOLS.ffmpeg, args, { cwd: p.path }); assertActive(job); if (r.code !== 0) throw new Error('Adding the sound (render.mux recipe) failed: ' + r.stderr.slice(0, 300));
    return out;
  }
  // VideoHub rebuilt the film's mix (sound levels / added clips from the timeline, server/sound.js): that mix is the
  // film's sound now. Copying the last film's track (below) would silently drop those edits (a real bug: "Apply to film"
  // never reached a render without a mux recipe).
  const edited = editedMix(p);
  if (edited) {
    const r = await spawnLogged(job, TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', video, '-i', edited, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', out]);
    assertActive(job);
    if (r.code !== 0) throw new Error('Adding the sound (edited mix) failed: ' + r.stderr.slice(0, 300));
    return out;
  }
  // The film's own current mix (audio/mix.wav …, the file the live preview plays) comes before any older video's sound:
  // copying the last film's track gave English renders the Turkish voice and a retimed voice-over the old, shifted one.
  // An English render (FILMLANG / LANG = en) takes audio/mix_en.* only; it never falls back to the other language.
  const en = [job?.env?.FILMLANG, job?.env?.LANG].some(v => String(v || '').toLowerCase() === 'en');
  const own = en ? ['audio/mix_en.wav', 'audio/mix_en.mp3', 'mix_en.wav'].map(f => path.join(p.path, f)).find(f => fs.existsSync(f)) : audioOf(p, meta);
  if (en && !own) throw new Error('No audio/mix_en.wav for this English render; the film\'s other-language sound was not used.');
  if (own && /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(own) && fs.existsSync(own)) {
    const r0 = await spawnLogged(job, TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', video, '-i', own, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', out]);
    assertActive(job);
    if (r0.code !== 0) throw new Error('Adding the sound (' + path.basename(own) + ') failed: ' + r0.stderr.slice(0, 300));
    return out;
  }
  // no mix file at all: the sound of the last film, and only of one about as long as the new picture (never a short test clip)
  const vdur = +(await spawnLogged(job, TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])).stdout || 0;
  assertActive(job);
  const fits = o => o.audio && (!vdur || (o.dur || 0) >= vdur * 0.9);
  const last = lastFilm(p);
  const prev = (last && fits(last) ? last : null) || p.outputs.filter(o => o.role === 'final' && fits(o)).sort((a, b) => b.mtime - a.mtime)[0];
  // neither a mix nor an earlier video with sound: fail instead of quietly delivering a silent film
  if (!prev) throw new Error('The film has no sound file (audio/mix.wav) and no earlier version with sound: no silent video was made.');
  const r = await spawnLogged(job, TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', video, '-i', prev.path, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', out]);
  assertActive(job);
  if (r.code !== 0) throw new Error('Adding the sound failed: ' + r.stderr.slice(0, 300));
  return out;
}

// the film's mix when VideoHub built it with edits in it (sound.json written for this very file, with levels or clips)
export function editedMix(p) {
  try {
    const rec = readJson(path.join(vhDir(p), 'sound.json'), null);
    if (!rec || !rec.written || !((rec.entries || 0) + (rec.clips || 0))) return null;
    const target = audioOf(p, readJson(path.join(vhDir(p), 'project.json'), {}));
    if (!target || !fs.existsSync(target)) return null;
    return Math.abs(fs.statSync(target).mtimeMs - rec.written) <= 1500 ? target : null;   // the score wrote a newer mix since: not ours any more
  } catch { return null; }
}

async function register(p, job, file, vN, changedRanges, kind = 'final') {
  assertActive(job);
  if (!fs.existsSync(file)) throw new Error('Output missing: ' + file);
  const vf = path.join(vhDir(p), 'versions.json'), versions = readJson(vf, []);
  const prevFinal = lastFilm(p);
  const entry = { v: vN, file: relOf(p, file), kind, created: now(), job: job.id, mode: job.mode, session: job.session, parent: prevFinal?.rel || null, changedRanges, chunks: job.chunks || null, notes: job.notes || [], note: job.note || null };
  versions.push(entry); writeJson(vf, versions);
  job.linkedTo = linkOutput(file, { title: p.title || p.name, v: vN, kind });   // the global outputs folder: a hard link, no extra space
  job.output = entry.file; job.outputPath = file; job.version = vN;
  for (const id of job.notes || []) try { updateNote(p, id, { fixedIn: entry.file }, 'videohub'); } catch { }
  // A real bug: v2's notes were fixed in v3 but nobody marked them, stayed "open", and the next request handed them
  // to Claude again together with v3's new notes. A new film version settles every note written before its render
  // started that is still open or with Claude: "fixed" (the user checks it in the tour, "Still there" reopens it).
  if (kind === 'final') {
    const startedAt = Date.parse(job.createdAt || '') || Date.now();
    for (const n of listNotes(p)) {
      if (!['open', 'claude'].includes(n.status) || n.file === entry.file || (Date.parse(n.createdAt) || 0) >= startedAt) continue;
      try { updateNote(p, n.id, { status: 'fixed', fixedIn: entry.file, reply: n.reply || `counted as fixed in ${entry.file} (the note was written before this render)` }, 'videohub'); } catch { }
    }
  }
}

async function finish(p, job) {
  assertActive(job);
  // the user asked for a copy somewhere else too (the original stays in the project: versions, notes and partial renders need it)
  if (job.copyTo && job.outputPath) {
    try {
      fs.mkdirSync(job.copyTo, { recursive: true });
      const ext = path.extname(job.outputPath), base = path.basename(job.outputPath, ext);
      let dst = path.join(job.copyTo, base + ext); for (let i = 2; fs.existsSync(dst); i++) dst = path.join(job.copyTo, `${base}_${i}${ext}`);
      await fs.promises.copyFile(job.outputPath, dst); job.copiedTo = dst;
    } catch (e) { job.copyError = e.message; }
  }
  await rescanProject(p.id).catch(() => { });
  assertActive(job); setPhase(job, 'done');
  job.state = 'done'; job.progress = 1; job.finishedAt = now();
  job.durationSec = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000);
  emit('done', job);
}

// the user said yes to a custom command on the Renders page: it takes its turn in the queue
export function approve(id) {
  const j = get(id); if (!j || j.state !== 'queued' || !j.needsApproval) return false;
  delete j.needsApproval; j.waiting = null; j.approvedAt = now(); emit('queued', j); pump(); return true;
}

export function cancel(id) {
  const j = get(id); if (!j) return false;
  if (!['queued', 'running'].includes(j.state)) return false;
  if (j.state === 'queued') { j.state = 'cancelled'; j.finishedAt = now(); emit('cancelled', j); return true; }
  const children = procs.get(id); if (children) for (const c of children) if (!c.pid) continue; else if (!IS_WIN) killTree(c.pid); else {
    spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }).on('error', () => { try { c.kill(); } catch { } });
  }
  j.state = 'cancelled'; j.finishedAt = now(); emit('cancelled', j); return true;
}

// a job that was running when the hub stopped is put back at the front of the queue
export function resume() {
  for (const j of jobs) if (j.state === 'running') { j.state = 'queued'; j.note = 'the hub restarted; queued again'; }
  save(); pump();
}

export async function wait(id, maxSec = 540) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxSec * 1000) {
    const j = get(id); if (!j) return null;
    if (['done', 'failed', 'cancelled'].includes(j.state)) return j;
    await new Promise(r => setTimeout(r, 1500));
  }
  return get(id);
}

// render settings a project supports, read from what its render script reads (process.env.X): PREVIEW (half size,
// 30 fps), FPS, workers (WK or the script's first argument), the encoder (VIDEOHUB_ENCODER); a 3D studio scene: Chrome
// copies + encoder (make.mjs)
export async function renderOptions(p) { const o = await renderOptions0(p); o.info = await renderInfo(p).catch(() => ({})); return o; }
// what the next render will be: size, fps, length, file name and folder, and time/size from earlier renders
async function renderInfo(p) {
  const rc = await recipe(p);
  const out = (p.outputs || []).find(o => o.rel === p.latest) || (p.outputs || []).find(o => o.role === 'final');
  let w = out?.w || null, h = out?.h || null, dur = +rc.env.DUR || out?.dur || null;
  if (!w || !dur) { try { const li = await (await import('./live.js')).liveInfo(p); if (li.ok) { w = w || li.w; h = h || li.h; dur = dur || li.dur; } } catch { } }
  const versions = readJson(path.join(vhDir(p), 'versions.json'), []);
  const vN = Math.max(versions.reduce((m, v) => Math.max(m, v.v || 0), 0), maxNameVersion(p)) + 1;
  const done = jobs.filter(j => j.project === p.id && j.state === 'done' && j.durationSec).reverse();
  const lastFull = done.find(j => j.mode === 'full'), lastPart = done.find(j => j.mode === 'partial' && j.chunks?.length);
  return { w, h, fps: out?.fps || rc.fps, dur, chunkSec: rc.chunkSec || null, dir: rdir(p),
    next: { v: vN, file: `${baseOf(p)}_v${vN}.mp4`, preview: `${baseOf(p)}_preview_v${vN}.mp4`, previewDir: p.path },
    bytesPerSec: out?.size && out?.dur ? out.size / out.dur : null, fullSec: lastFull?.durationSec || null, fullFps: lastFull ? +(lastFull.env?.FPS || rc.fps) : null,
    partSecPerChunk: lastPart ? lastPart.durationSec / lastPart.chunks.length : null };
}
async function renderOptions0(p) {
  const rc = await recipe(p);
  if (p.studio) return { studio: true, partial: !!rc.chunkSec, preview: false, fps: null, workers: { default: rc.workers, max: 4 }, codecs: ['auto', 'x264', 'nvenc', 'amf'], dur: +rc.env.DUR || null };
  let src = ''; try { src = fs.readFileSync(path.join(p.path, rc.script), 'utf8'); } catch { }
  const env = new Set([...src.matchAll(/process\.env\.([A-Z_]+)/g)].map(m => m[1]));
  return { studio: false, script: fs.existsSync(path.join(p.path, rc.script)) ? rc.script : null, partial: p.family === 'A' && !!rc.chunkSec,
    preview: env.has('PREVIEW'), fps: env.has('FPS') ? { default: rc.fps || 30 } : null, workers: { default: rc.workers || 2, max: 8, env: env.has('WK') ? 'WK' : null }, dur: +rc.env.DUR || null,
    // a script that reads VIDEOHUB_ENCODER (the template's render.js) gets the encoder choice; default = Settings' choice
    ...(env.has('VIDEOHUB_ENCODER') ? { codecs: ENCODERS, codecEnv: 'VIDEOHUB_ENCODER', codecDefault: rc.env.VIDEOHUB_ENCODER || config().render?.encoder || 'auto', codecLabels: LABELS } : { codecs: null }) };
}

export function routes(route, readBody) {
  route('POST', '/api/pick-folder', async req => { const b = await readBody(req); return { path: await pickFolderWin(b.start, b.title || 'Choose a folder') }; });
  route('GET', '/api/project/:id/render-options', async (req, url, { id }) => { const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 }); return renderOptions(p); });
  route('POST', '/api/jobs', async req => create(await readBody(req)));
  route('GET', '/api/jobs', () => list());
  route('GET', '/api/jobs/:id', async (req, url, { id }) => { const w = +(url.searchParams.get('wait') || 0); const j = w ? await wait(id, Math.min(w, 900)) : get(id); if (!j) throw Object.assign(new Error('Job not found'), { code: 404 }); return j; });
  route('POST', '/api/jobs/:id/cancel', (req, url, { id }) => ({ ok: cancel(id) }));
  route('POST', '/api/jobs/:id/approve', (req, url, { id }) => ({ ok: approve(id) }));
  route('GET', '/api/project/:id/recipe', async (req, url, { id }) => { const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 }); return recipe(p); });
  route('POST', '/api/project/:id/version', async (req, url, { id }) => {
    const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
    const b = await readBody(req), versions = readJson(path.join(vhDir(p), 'versions.json'), []);
    if (typeof b.file !== 'string' || !b.file) throw Object.assign(new Error('file is required'), { code: 400 });
    const file = path.resolve(p.path, b.file);
    if (!isInside(file, p.path) && !(p.studio && p.outDir && isInside(file, p.outDir))) throw Object.assign(new Error('The file must be inside the project folder'), { code: 400 });
    const vN = Math.max(versions.reduce((m, v) => Math.max(m, v.v || 0), 0), maxNameVersion(p)) + 1;
    const job = { id: 'manual', mode: 'manual', session: b.session || null, notes: b.notes || [], note: b.note || null };
    await register(p, job, file, vN, b.changedRanges || null, b.kind || 'final');
    await rescanProject(id).catch(() => { });
    return { v: vN, file: job.output };
  });
}
