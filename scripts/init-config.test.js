import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initConfig, state, checkWorkspace, HUB } from './init-config.mjs';

// every test in its own scratch folder under .test-tmp: never the real data\config.json or Documents
const scratch = () => { const d = path.join(HUB, '.test-tmp', 'init-config-' + randomUUID().slice(0, 8)); fs.mkdirSync(d, { recursive: true }); return d; };
const none = () => [];
const hubDir = path.join(HUB, '.test-tmp', 'fake-install');   // the scratch folders live inside the real install

test('dry run decides but writes nothing', () => {
  const d = scratch(), data = path.join(d, 'data'), ws = path.join(d, 'Work');
  const r = initConfig({ dataDir: data, workspace: ws, dryRun: true, discover: none, hubDir });
  assert.equal(r.wrote, false); assert.equal(r.workspace, ws); assert.ok(r.actions.some(a => /^would create /.test(a)));
  assert.equal(fs.existsSync(data), false); assert.equal(fs.existsSync(ws), false);
});

test('a new install: workspace folders, README, config with baseDir, the chosen folders watched and the encoder', () => {
  const d = scratch(), data = path.join(d, 'data'), ws = path.join(d, 'Work'), old = path.join(d, 'Old films'), other = path.join(d, 'Clips');
  const found = () => [{ path: old, type: 'container', enabled: false }, { path: other, type: 'media', enabled: false }];
  const r = initConfig({ dataDir: data, workspace: ws, watch: [old], encoder: 'amf', discover: found, hubDir });
  assert.equal(r.wrote, true);
  for (const f of ['films', 'outputs', 'sounds', 'thumbnails', 'archive']) assert.ok(fs.statSync(path.join(ws, f)).isDirectory(), f);
  assert.match(fs.readFileSync(path.join(ws, 'README.txt'), 'utf8'), /outputs\s+every finished render/);
  const c = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
  assert.equal(c.baseDir, ws); assert.equal(c.outputsDir, path.join(ws, 'outputs')); assert.equal(c.thumbstudio.globalDir, path.join(ws, 'thumbnails'));
  assert.equal(c.render.encoder, 'amf');
  assert.deepEqual(c.roots.map(x => [x.path, x.enabled]), [[path.join(ws, 'films'), true], [old, true], [other, false]]);
});

test('a re-run keeps every answer and value, adds only missing keys, never touches folders', () => {
  const d = scratch(), data = path.join(d, 'data'), ws = path.join(d, 'Work');
  initConfig({ dataDir: data, workspace: ws, encoder: 'x264', discover: none, hubDir });
  fs.writeFileSync(path.join(ws, 'README.txt'), 'mine');
  const file = path.join(data, 'config.json'), c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.outputsDir = 'D:\\Somewhere'; fs.writeFileSync(file, JSON.stringify(c));
  const r = initConfig({ dataDir: data, workspace: path.join(d, 'Other'), encoder: 'amf', discover: none, hubDir });
  assert.equal(r.wrote, false); assert.equal(r.workspace, ws); assert.equal(r.encoder, 'x264');
  assert.equal(fs.existsSync(path.join(d, 'Other')), false); assert.equal(fs.readFileSync(path.join(ws, 'README.txt'), 'utf8'), 'mine');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).outputsDir, 'D:\\Somewhere');
  const s = state({ dataDir: data, discover: none, hubDir }); assert.equal(s.installed, true); assert.equal(s.workspace, ws); assert.equal(s.encoder, 'x264');
  // an older install (no baseDir, no render key): the encoder key is added, nothing else changes
  fs.writeFileSync(file, JSON.stringify({ port: 7788, outputsDir: 'D:\\o', roots: [{ path: 'D:\\f', type: 'container', enabled: true }] }));
  const r2 = initConfig({ dataDir: data, encoder: 'amf', discover: none, hubDir });
  const c2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(r2.wrote, true); assert.equal(c2.render.encoder, 'amf'); assert.equal(c2.baseDir, undefined); assert.equal(c2.outputsDir, 'D:\\o'); assert.equal(c2.roots.length, 1);
  // a config that is not readable JSON is never replaced
  fs.writeFileSync(file, '{ broken'); assert.throws(() => initConfig({ dataDir: data, discover: none, hubDir }), /not readable JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('workspace checks: full path, not a drive, not inside the install, not a file', () => {
  const d = scratch(), f = path.join(d, 'file.txt'); fs.writeFileSync(f, 'x');
  assert.equal(checkWorkspace(path.join(d, 'new', 'deeper'), hubDir), null);
  assert.match(checkWorkspace('videos'), /full path/);
  const drive = process.platform === 'win32' ? 'C:\\' : '/';   // Linux (RunPod): '/' is "the whole disk"
  assert.match(checkWorkspace(drive), /whole (drive|disk)/);
  assert.match(checkWorkspace(path.join(HUB, 'films')), /outside the VideoHub program folder/);
  assert.match(checkWorkspace(f, hubDir), /file/);
  assert.throws(() => initConfig({ dataDir: path.join(d, 'data'), workspace: drive, discover: none, hubDir }), /whole (drive|disk)/);
  assert.throws(() => initConfig({ dataDir: path.join(d, 'data'), workspace: path.join(d, 'w'), encoder: 'turbo', discover: none, hubDir }), /encoder/);
});
