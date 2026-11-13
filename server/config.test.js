import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ENCODERS } from './encoders.js';

// config.js with in-memory files: never writes data/config.json
// The Windows cases run with path.win32 on any OS; `os` switches to the Linux (RunPod) defaults.
function load(saved = { port: 7788, roots: [{ path: 'X:\\films', type: 'container', enabled: true }] }, env = { VIDEOHUB_BASE_DIR: 'X:\\base' }, os = { win: true, workspace: false }) {
  const code = fs.readFileSync(new URL('./config.js', import.meta.url), 'utf8').replace(/^import .+;\r?$/gm, '').replace(/\bexport /g, '');
  const written = [];
  const ctx = { fs: { existsSync: f => !os.win && os.workspace && f === '/workspace', readdirSync: () => [], mkdirSync() { } }, path: os.win ? path.win32 : path.posix, IS_WIN: os.win, HOME: os.win ? 'X:\\home' : '/root',
    DATA_DIR: os.win ? 'X:\\data' : '/opt/vh/data', DESKTOP: os.win ? 'X:\\desk' : '/root/Desktop', DOCUMENTS: os.win ? 'X:\\docs' : '/root/Documents', ENCODERS,
    process: { env }, readJson: () => saved && JSON.parse(JSON.stringify(saved)), writeJson: (f, d) => written.push(JSON.parse(JSON.stringify(d))) };
  vm.createContext(ctx); vm.runInContext(code + '\nglobalThis.api = { config, saveConfig, baseDir, defaultFilmsDir };', ctx);
  return { ...ctx.api, written };
}

test('a bad POST /api/config body cannot break the roots, thumbstudio or port', () => {
  const c = load();
  let r = c.saveConfig({ roots: 'oops', port: 'abc', thumbstudio: 5 });
  assert.equal(r.roots.length, 1); assert.equal(r.roots[0].path, 'X:\\films'); assert.equal(r.port, 7788); assert.equal(r.thumbstudio.templatesDir, path.win32.join('X:\\base', 'thumbnail-templates'));
  r = c.saveConfig({ roots: [{ path: 'X:\\a', type: 'weird' }, { nope: 1 }, null, { path: 3 }, { path: 'X:\\b', type: 'media', enabled: false }], port: '7799', thumbstudio: { styleRefsDir: 'X:\\styles' } });
  assert.deepEqual(JSON.parse(JSON.stringify(r.roots)), [{ path: 'X:\\a', type: 'container', enabled: true }, { path: 'X:\\b', type: 'media', enabled: false }]);
  assert.equal(r.port, 7799); assert.equal(r.thumbstudio.styleRefsDir, 'X:\\styles'); assert.equal(r.thumbstudio.globalDir, path.win32.join('X:\\base', 'thumbnails'));
  r = c.saveConfig(null); assert.equal(r.roots.length, 2); assert.equal(c.written.length, 3);
});

test('baseDir: VIDEOHUB_BASE_DIR, then config.baseDir, then Documents\\VideoHub; the folder defaults follow it', () => {
  let c = load({ baseDir: 'E:\\Work\\VH', roots: [] }, {}); c.config();
  assert.equal(c.baseDir(), 'E:\\Work\\VH'); assert.equal(c.config().outputsDir, path.win32.join('E:\\Work\\VH', 'outputs'));
  assert.equal(c.config().thumbstudio.globalDir, path.win32.join('E:\\Work\\VH', 'thumbnails')); assert.equal(c.defaultFilmsDir(), path.win32.join('E:\\Work\\VH', 'films'));
  c = load({ baseDir: 'E:\\Work\\VH', roots: [] }, { VIDEOHUB_BASE_DIR: 'X:\\scratch' }); c.config(); assert.equal(c.baseDir(), 'X:\\scratch');
  c = load({ roots: [] }, {}); c.config(); assert.equal(c.baseDir(), path.win32.join('X:\\docs', 'VideoHub'));
  c = load({ baseDir: 'relative\\bad', roots: [] }, {}); c.config(); assert.equal(c.baseDir(), path.win32.join('X:\\docs', 'VideoHub'));
  // first run without setup: the same defaults, and the workspace is written down
  c = load(null, {}); const f = c.config();
  assert.equal(f.baseDir, path.win32.join('X:\\docs', 'VideoHub')); assert.equal(f.roots[0].path, path.win32.join('X:\\docs', 'VideoHub', 'films'));
  assert.equal(f.render.encoder, 'auto'); assert.equal(c.written.length, 1);
});

test('an existing config keeps its values: explicit folders win over the workspace, saveConfig cannot move the workspace', () => {
  const saved = { port: 7788, baseDir: 'E:\\VH', outputsDir: 'D:\\Old outputs', archiveDir: 'D:\\Arch', thumbstudio: { globalDir: 'D:\\Th' }, render: { encoder: 'x264' }, roots: [{ path: 'D:\\films', type: 'container', enabled: true }] };
  const c = load(saved, {}), r = c.config();
  assert.equal(r.outputsDir, 'D:\\Old outputs'); assert.equal(r.archiveDir, 'D:\\Arch'); assert.equal(r.thumbstudio.globalDir, 'D:\\Th');
  assert.equal(r.soundLibDir, path.win32.join('E:\\VH', 'sounds')); assert.equal(r.render.encoder, 'x264'); assert.equal(r.roots.length, 1); assert.equal(c.written.length, 0);
  let s = c.saveConfig({ baseDir: 'Z:\\elsewhere', render: { encoder: 'amf' } });
  assert.equal(s.baseDir, 'E:\\VH'); assert.equal(s.render.encoder, 'amf'); assert.equal(s.outputsDir, 'D:\\Old outputs');
  s = c.saveConfig({ render: { encoder: 'warp9' } }); assert.equal(s.render.encoder, 'auto');
  // an install from before baseDir: no key is added, Documents\VideoHub as before
  const old = load({ port: 7788, outputsDir: 'D:\\o', roots: [] }, {}); assert.equal(old.config().baseDir, undefined); assert.equal(old.baseDir(), path.win32.join('X:\\docs', 'VideoHub'));
});

test('Linux: the workspace defaults to /workspace/videohub on a RunPod pod, else ~/VideoHub', () => {
  let c = load(null, {}, { win: false, workspace: true }), f = c.config();
  assert.equal(c.baseDir(), '/workspace/videohub'); assert.equal(f.outputsDir, '/workspace/videohub/outputs'); assert.equal(f.roots[0].path, '/workspace/videohub/films');
  c = load(null, {}, { win: false, workspace: false }); assert.equal(c.baseDir(), '/root/VideoHub');
  c = load({ baseDir: '/data/vh', roots: [] }, {}, { win: false, workspace: true }); c.config(); assert.equal(c.baseDir(), '/data/vh');
});
