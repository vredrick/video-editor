import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import path from 'node:path';

test('cleanup preserves finals and review material and only releases approved chunks', async () => {
const root=fs.mkdtempSync(path.join(os.tmpdir(),'videohub-cleanup-test-'));
fs.mkdirSync(root,{recursive:true});
const {index}=await import('./scan.js');
const {findCandidates}=await import('./janitor.js');
const {config}=await import('./config.js');config().roots=[{path:root,type:'project',enabled:true}];
try {
const make=(name,bytes=1)=>{const f=path.join(root,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,'x');if(bytes>1)fs.truncateSync(f,bytes);return f;};
const final=make('film_v2.mp4'),silent=make('render/video.mp4'),chunk=make('render/chunks/c_000.mp4',25*1024*1024);
const outsideFinal=make('out/film.mp4'),tempFinal=make('render/tmp/valuable.mp4'),backup=make('render/chunks_v1/c_000.mp4');
const now=Date.now();
const p={id:'cleanup-regression',path:root,name:'Fixture',title:'Fixture',status:'review',statusAuto:false,notesOpen:0,sizes:{chunk:25*1024*1024},latest:'film_v2.mp4',outputs:[
{path:final,rel:'film_v2.mp4',name:'film_v2.mp4',role:'final',mtime:now,audio:true},
{path:silent,rel:'render/video.mp4',name:'video.mp4',role:'silent',coveredBy:'film_v2.mp4',size:1},
{path:outsideFinal,rel:'out/film.mp4',name:'film.mp4',role:'final',mtime:now-1000,audio:true},
{path:tempFinal,rel:'render/tmp/valuable.mp4',name:'valuable.mp4',role:'final',mtime:now-1000,audio:true}
]};
index().projects=[p];
let c=await findCandidates(true);
assert(c.some(x=>x.path===silent));assert(c.some(x=>x.path.includes('chunks_v1')));
assert(!c.some(x=>x.rule==='chunks'));console.log('PASS review chunks preserved; silent duplicates and replaced chunks offered');
assert(!c.some(x=>x.path===path.join(root,'out')||x.path===path.join(root,'render','tmp')));console.log('PASS out and tmp folders containing final movies never offered');
p.status='done';p.statusAuto=true;c=await findCandidates(true);assert(!c.some(x=>x.rule==='chunks'));console.log('PASS automatic age-based status does not release chunks');
p.status='approved';p.statusAuto=false;c=await findCandidates(true);assert(c.some(x=>x.rule==='chunks'&&x.path===path.dirname(chunk)));console.log('PASS explicit approval releases only known chunk directories');
p.notesOpen=1;c=await findCandidates(true);assert(!c.some(x=>x.rule==='chunks'));console.log('PASS unresolved notes protect chunks');
p.notesOpen=0;fs.unlinkSync(final);c=await findCandidates(true);assert(!c.some(x=>x.path===silent));console.log('PASS missing voiced copy protects silent source');
console.log('NO cleanup executed; all assertions inspect candidate lists only.');
} finally { if(path.dirname(root)!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('videohub-cleanup-test-')) throw new Error('Unexpected test directory'); fs.rmSync(root,{recursive:true}); }
});

test('Linux trash: items are moved (never deleted) below trash/<time>/ with their full path, a missing one is reported', async () => {
  const { trashStream } = await import('./janitor.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videohub-trash-test-'));
  try {
    const f = path.join(root, 'films', 'a', 'old.mp4'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x');
    const res = [];
    await trashStream([{ path: f }, { path: path.join(root, 'nope.mp4') }], (i, code) => res.push(code), path.join(root, 'trash'));
    assert.deepEqual(res, [0, 2]); assert.equal(fs.existsSync(f), false);
    const [stamp] = fs.readdirSync(path.join(root, 'trash'));
    assert.equal(fs.readFileSync(path.join(root, 'trash', stamp, f.replace(/^[\\/]+/, '')), 'utf8'), 'x');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Linux render protection finds the whole process tree from /proc (names with spaces and brackets too)', async () => {
  const { procTree } = await import('./guard.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'videohub-proc-test-'));
  try {
    const add = (pid, ppid, name) => { fs.mkdirSync(path.join(d, String(pid))); fs.writeFileSync(path.join(d, String(pid), 'stat'), `${pid} (${name}) S ${ppid} 1 1 0`); };
    add(10, 1, 'node'); add(11, 10, 'chrome (renderer)'); add(12, 11, 'chrome) x'); add(20, 1, 'other'); fs.mkdirSync(path.join(d, 'self'));
    assert.deepEqual(procTree(10, d).sort(), [10, 11, 12]);
    assert.deepEqual(procTree(99, path.join(d, 'missing')), [99]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
