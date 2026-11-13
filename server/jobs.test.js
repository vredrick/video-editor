import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { refersToHub, isInside } from './util.js';
import { ENCODERS, LABELS, encoderEnv } from './encoders.js';

// Run the actual queue with in-memory files and fake child processes: never renders a film.
const code = fs.readFileSync(new URL('./jobs.js', import.meta.url), 'utf8')
  .replace(/^import .+;\r?$/gm, '').replace(/\bexport /g, '');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function harness(opts = {}) {
  const killed = [];
  const base = path.resolve('.test-tmp', 'queue-fixture');
  const files = new Set(), children = [], timers = [], events = [], log = [];
  let pid = 100, workers = 1, maxParallel = 1, guard = { running: false }, encoder = 'auto';
  const projects = new Map(['p1', 'p2'].map(id => [id, { id, name: id, path: path.join(base, id), studio: base, outDir: path.join(base, 'out', id), outputs: [], render: {} }]));
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter(); child.pid = ++pid; child.cmd = cmd; child.args = args; child.opts = opts;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
    children.push(child); return child;
  };
  const ctx = {
    fs: { existsSync: file => files.has(file), mkdirSync: dir => files.add(dir),
      readdirSync: dir => [...files].filter(file => path.dirname(file) === dir).map(file => path.basename(file)),
      renameSync: (a, b) => { if (files.has(b)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); for (const x of [...files]) if (x === a || x.startsWith(a + path.sep)) { files.delete(x); files.add(b + x.slice(a.length)); } },   // like Windows: never onto an existing name
      writeFileSync: file => files.add(file), appendFileSync() {}, copyFileSync: (a, b) => files.add(b),
      createWriteStream: () => ({ write: value => log.push(String(value)), end() {} }),
      promises: { copyFile: async (a, b) => files.add(b) } },
    path, spawn, randomUUID, DATA_DIR: path.join(base, 'data'), TOOLS: { node: 'node', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    process: { env: {} }, setTimeout: fn => { timers.push(fn); return timers.length; },
    readJson: (file, fallback) => file.endsWith('project.json') ? { render: { workers } }
      : file.endsWith('manifest.json') ? { dur: 2, fps: 60, chunkFrames: 120, chunkSec: 2 } : fallback,
    writeJson() {}, config: () => ({ maxParallelRenders: maxParallel, render: { encoder } }), ENCODERS, LABELS, encoderEnv, project: id => projects.get(id),
    guardState: () => guard, guardTrack: () => { }, IS_WIN: opts.win ?? true, killTree: pid => killed.push(pid), ramHogsNow: async () => [], ramNote: () => null,
    vhDir: p => path.join(p.path, '.videohub'), listNotes: () => [], updateNote() {},
    linkOutput: () => null, rescanProject: async () => {}, now: () => new Date().toISOString(),
    pLimit: async (items, n, fn) => Promise.all(items.map(fn)), pickFolderWin() {},
    HUB_DIR: base, audioOf: p => { const f = path.join(p.path, 'audio', 'mix.wav'); return files.has(f) ? f : null; }, refersToHub: s => refersToHub(s, base), isInside,   // the film's own mix, when the test put one there
  };
  vm.createContext(ctx); vm.runInContext(code + '\nglobalThis.queue = {create,cancel,approve,get,pump,spawnLogged,runJob,recipe,procs,executing,onJob};', ctx);
  ctx.queue.onJob(event => events.push(event));
  return { ...ctx.queue, children, events, files, log, projects, timers, killed,
    setWorkers: value => { workers = value; }, setGuard: value => { guard = value; }, setParallel: value => { maxParallel = value; }, setEncoder: value => { encoder = value; },
    async close(child, output = '', status = 0) {
      if (status === 0) {
        const p = projects.get(child.args[1]);
        if (child.args.includes('--chunks')) { const dir = path.join(p.outDir, 'render', 'chunks'); files.add(dir); files.add(path.join(dir, 'c_000.mp4')); }
        else if (child.cmd === 'ffmpeg' || child.args.includes('--mux')) files.add(child.args.at(-1));
      }
      if (output) child.stdout.emit('data', output);
      child.emit('close', status); await flush();
    } };
}

test('studio honors one requested worker and tracks concatenation and audio phases', async () => {
  const h = harness(), job = await h.create({ project: 'p1', mode: 'full', workers: 1 }); await flush();
  const render = h.children[0]; assert.equal(render.args.at(-1), '1');
  assert.equal((await h.recipe(h.projects.get('p1'))).workers, 1);
  await h.close(render, '1/1 chunks to render\nchunk 0 ok, 1 done of 1\n');
  const concat = h.children.at(-1); assert.equal(concat.cmd, 'ffmpeg'); assert.equal(h.get(job.id).phase, 'concat');
  assert.ok(h.procs.get(job.id).has(concat)); await h.close(concat);
  const mux = h.children.at(-1); assert.ok(mux.args.includes('--mux')); assert.equal(h.get(job.id).phase, 'audio');
  await h.close(mux); assert.equal(h.get(job.id).state, 'done'); assert.equal(h.executing.size, 0);
  assert.ok(h.get(job.id).phaseSeconds.render >= 0); assert.ok(h.get(job.id).phaseSeconds.audio >= 0);
});

test('concurrent submissions for the same project queue only one job', async () => {
  const h = harness();
  const requests = await Promise.allSettled([h.create({ project: 'p1', mode: 'full' }), h.create({ project: 'p1', mode: 'full' })]);
  assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(requests.find(r => r.status === 'rejected').reason.code, 409);
});

// a regular render script: render.js → concat → then the sound step under test
async function renderUpToSound(h, body = {}) {
  const project = h.projects.get('p1'); project.studio = null;
  const job = await h.create({ project: 'p1', mode: 'full', workers: 1, ...body }); await flush();
  assert.equal(h.children[0].args[0], 'render.js');
  const dir = path.join(project.path, 'render', 'chunks'); h.files.add(dir); h.files.add(path.join(dir, 'c_000.mp4'));
  await h.close(h.children[0]); assert.equal(h.children.at(-1).cmd, 'ffmpeg');   // concat
  await h.close(h.children.at(-1));
  return { job, project };
}

test("a regular render gets the film's own audio/mix.wav", async () => {
  const h = harness(); h.files.add(path.join(h.projects.get('p1').path, 'audio', 'mix.wav'));
  const { job, project } = await renderUpToSound(h);
  const mux = h.children.at(-1); assert.equal(mux.cmd, 'ffmpeg'); assert.ok(mux.args.includes(path.join(project.path, 'audio', 'mix.wav')));
  await h.close(mux); assert.equal(h.get(job.id).state, 'done');
});

test('an English render takes audio/mix_en.wav and never the other mix', async () => {
  const h = harness(), base = h.projects.get('p1').path;
  h.files.add(path.join(base, 'audio', 'mix.wav')); h.files.add(path.join(base, 'audio', 'mix_en.wav'));
  const { job } = await renderUpToSound(h, { env: { FILMLANG: 'en' } });
  const mux = h.children.at(-1); assert.ok(mux.args.includes(path.join(base, 'audio', 'mix_en.wav'))); assert.ok(!mux.args.includes(path.join(base, 'audio', 'mix.wav')));
  await h.close(mux); assert.equal(h.get(job.id).state, 'done');
});

test('no mix and no earlier video with sound: the render fails instead of making a silent film', async () => {
  const h = harness(); const { job } = await renderUpToSound(h);
  assert.equal(h.children.at(-1).cmd, 'ffprobe'); await h.close(h.children.at(-1), '2.0\n');
  assert.equal(h.get(job.id).state, 'failed'); assert.match(h.get(job.id).error || '', /sound/i);
});

test('another project waits for a cancelled child to exit before starting', async () => {
  const h = harness(), first = await h.create({ project: 'p1', mode: 'full' }); await flush();
  const render = h.children[0]; h.cancel(first.id);
  const second = await h.create({ project: 'p2', mode: 'full' }); await flush();
  assert.notEqual(first.id, second.id); assert.equal(h.get(second.id).state, 'queued');
  assert.equal(h.children.filter(child => child.cmd === 'node').length, 1);
  await h.close(render, '', 1); await h.pump(); await flush();
  assert.equal(h.get(second.id).state, 'running'); assert.equal(h.children.filter(child => child.cmd === 'node').length, 2);
});

test('cancelled render retains the queue slot until child exit and stays cancelled', async () => {
  const h = harness(), job = await h.create({ project: 'p1', mode: 'full' }); await flush();
  const child = h.children[0]; assert.equal(h.cancel(job.id), true);
  assert.equal(h.get(job.id).state, 'cancelled'); assert.equal(h.executing.size, 1);
  assert.equal(h.children.at(-1).cmd, 'taskkill');
  await h.close(child, '', 1); assert.equal(h.get(job.id).state, 'cancelled'); assert.equal(h.executing.size, 0);
  assert.equal(h.events.some(e => e.type === 'failed'), false); assert.equal(h.cancel(job.id), false);
});

test('on Linux a cancelled render kills its whole process tree (no taskkill)', async () => {
  const h = harness({ win: false }), job = await h.create({ project: 'p1', mode: 'full' }); await flush();
  const child = h.children[0]; assert.equal(h.cancel(job.id), true);
  assert.deepEqual(h.killed, [child.pid]); assert.equal(h.children.some(c => c.cmd === 'taskkill'), false);
  await h.close(child, '', 1); assert.equal(h.get(job.id).state, 'cancelled');
});

test('cancellation during mux kills that process and does not register an output', async () => {
  const h = harness(), job = await h.create({ project: 'p1', mode: 'full' }); await flush();
  await h.close(h.children[0]); await h.close(h.children.at(-1));
  const mux = h.children.at(-1); assert.ok(mux.args.includes('--mux'));
  h.cancel(job.id); const kill = h.children.at(-1); assert.equal(kill.args[1], String(mux.pid));
  await h.close(mux, '', 1); assert.equal(h.get(job.id).state, 'cancelled'); assert.equal(h.get(job.id).output, undefined);
});

test('split stdout records retain progress and concurrent validation children stay tracked', async () => {
  const h = harness(), job = { id: 'logs', state: 'running', log: 'memory.log' };
  const result = h.spawnLogged(job, 'node', ['render.js']); const child = h.children[0];
  child.stdout.emit('data', '2/2 chunks to ren'); child.stdout.emit('data', 'der\nchunk 0 ok, ');
  child.stdout.emit('data', '1 done of 2\n'); assert.equal(job.progress, 0.5);
  const second = h.spawnLogged(job, 'ffprobe', ['chunk.mp4']); const probe = h.children.at(-1);
  assert.equal(h.procs.get(job.id).size, 2); await h.close(probe, '120,\n'); assert.equal((await second).stdout, '120,\n');
  assert.ok(h.procs.get(job.id).has(child)); await h.close(child, 'chunk 1 ok, 2 done of 2');
  assert.equal((await result).code, 0); assert.equal(job.progress, 0.99); assert.equal(h.procs.has(job.id), false);
});

test('spawn errors settle once and invalid worker counts are rejected before starting processes', async () => {
  const h = harness();
  for (const workers of [0, -1, 1.5, 5]) await assert.rejects(h.create({ project: 'p1', mode: 'full', workers }), error => error.code === 400);
  assert.equal(h.children.length, 0);
  const result = h.spawnLogged({ id: 'missing', state: 'running', log: 'memory.log' }, 'missing.exe', []);
  h.children[0].emit('error', new Error('ENOENT')); h.children[0].emit('close', -1);
  assert.equal((await result).code, -1); assert.equal(h.procs.size, 0);
});

test('unknown modes are rejected; command mode hands cmd.exe the command quoted and verbatim', async () => {
  const h = harness();
  await assert.rejects(h.create({ project: 'p1', mode: 'fulll' }), error => error.code === 400); assert.equal(h.children.length, 0);
  const cmd = 'node -e "console.log(process.argv.slice(1))" "a b" c';
  // a custom command waits for the user's yes: nothing runs, and other films' renders do not wait behind it
  const held = await h.create({ project: 'p1', mode: 'command', cmd }); await flush();
  assert.equal(held.needsApproval, true); assert.equal(h.children.length, 0); assert.ok(h.events.some(e => e.type === 'approval'));
  assert.equal(h.approve('nope'), false); assert.equal(h.approve(held.id), true); assert.equal(h.approve(held.id), false); await flush();
  const child = h.children[0]; assert.equal(child.cmd, 'cmd.exe');
  assert.deepEqual([...child.args], ['/d', '/s', '/c', '"' + cmd + '"']); assert.equal(child.opts.windowsVerbatimArguments, true);
});

test('a full render after a failed one takes a free backup name instead of failing on the existing one', async () => {
  const h = harness(), p = h.projects.get('p1'), render = path.join(p.outDir, 'render'), dir = path.join(render, 'chunks');
  h.files.add(dir); h.files.add(path.join(dir, 'c_000.mp4')); h.files.add(path.join(render, 'chunks_v0'));
  const job = await h.create({ project: 'p1', mode: 'full' }); await flush();
  assert.equal(h.get(job.id).state, 'running'); assert.ok(h.files.has(path.join(render, 'chunks_v0_2', 'c_000.mp4')));
  assert.ok(/^chunks_(v\d|prev)/i.test('chunks_v0_2'));
});

test('a failed or cancelled partial render puts the backed-up chunks back and never overwrites a backup', async () => {
  const h = harness(), p = h.projects.get('p1'), dir = path.join(p.outDir, 'render', 'chunks'), bak = path.join(p.outDir, 'render', 'chunks_v0');
  const c0 = path.join(dir, 'c_000.mp4'); h.files.add(dir); h.files.add(c0);
  let job = await h.create({ project: 'p1', mode: 'partial', chunks: [0] }); await flush();
  assert.ok(!h.files.has(c0)); assert.ok(h.files.has(path.join(bak, 'c_000.mp4')));
  await h.close(h.children[0], '', 1); assert.equal(h.get(job.id).state, 'failed');
  assert.ok(h.files.has(c0)); assert.ok(!h.files.has(path.join(bak, 'c_000.mp4')));
  // a retry while a backup is there (e.g. after a hub restart): the chunk in the way goes aside, the backup stays
  h.files.add(path.join(bak, 'c_000.mp4'));
  job = await h.create({ project: 'p1', mode: 'partial', chunks: [0] }); await flush();
  assert.ok(h.files.has(path.join(bak, 'c_000.mp4'))); assert.ok(h.files.has(path.join(bak, 'c_000_2.mp4'))); assert.ok(!h.files.has(c0));
  const render = h.children.filter(c => c.cmd === 'node').at(-1); h.cancel(job.id); await h.close(render, '', 1);
  assert.equal(h.get(job.id).state, 'cancelled'); assert.ok(h.files.has(c0)); assert.ok(h.files.has(path.join(bak, 'c_000_2.mp4')));
});

test('renders by path: a film in Documents\\VideoHub\\films is not ours; one waiting timer however often pump runs', async () => {
  const film = String.raw`C:\Users\x\Documents\VideoHub\films\x`, hub = path.resolve('.test-tmp', 'Some Install');
  assert.equal(refersToHub('node render.js 2 ' + film), false); assert.equal(refersToHub('"' + film + String.raw`\render.js"`), false);
  assert.equal(refersToHub(film, String.raw`C:\Users\x\Documents\VideoHub`), true);   // only when the install really is that folder
  assert.equal(refersToHub('node "' + hub + String.raw`\server\cli.js" hub_live`, hub), true);
  assert.equal(refersToHub('ffmpeg -i x ' + hub.split(path.sep).join('/').toUpperCase() + '/data/proxy/a.mp4', hub), true);
  assert.equal(refersToHub('node ' + hub + String.raw`2\server\cli.js`, hub), false);
  const h = harness();
  h.setGuard({ running: true, renders: [{ rootPid: 1, cmd: 'node render.js 2', cwd: film, paused: false }] });
  const job = await h.create({ project: 'p1', mode: 'full' }); await flush();
  assert.equal(h.get(job.id).state, 'queued'); assert.match(h.get(job.id).waiting, /rendering/);
  const timers = h.timers.length; for (let i = 0; i < 5; i++) await h.pump();
  assert.equal(h.timers.length, timers); assert.equal(h.children.length, 0);
  h.setGuard({ running: true, renders: [{ rootPid: 1, cmd: 'node ' + path.resolve('.test-tmp', 'queue-fixture', 'server', 'cli.js'), cwd: film, paused: false }] });
  h.timers.shift()(); await flush(); assert.equal(h.get(job.id).state, 'running');
});

test('render scripts get the encoder from Settings as VIDEOHUB_ENCODER, unless the job sets its own', async () => {
  const h = harness(), project = h.projects.get('p1'); project.studio = null; h.setEncoder('amf');
  await h.create({ project: 'p1', mode: 'full', workers: 1 }); await flush();
  assert.equal(h.children[0].opts.env.VIDEOHUB_ENCODER, 'amf'); assert.equal(h.children[0].opts.env.WK, '1');
  const h2 = harness(); h2.projects.get('p1').studio = null; h2.setEncoder('amf');
  await h2.create({ project: 'p1', mode: 'full', env: { VIDEOHUB_ENCODER: 'x264' } }); await flush();
  assert.equal(h2.children[0].opts.env.VIDEOHUB_ENCODER, 'x264');
});
