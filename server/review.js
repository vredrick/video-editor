// The review page bridge: a rendered version → a private claude.ai review page (video-review-notes), and the notes
// written on that page → VideoHub notes, so a partial re-render redoes only the chunks they touch.
// Flow: hub_review_build makes <project>/.videohub/review/round-N/ (review.mp4 under ~14 MB, strip.jpg, page.html) for
// Claude to publish as an Artifact; the viewer's "Send to Claude" wakes the session watching the page; Claude lists the
// page's notes collection into a folder and runs hub_review_import (adds/updates VideoHub notes, remembered by page
// note id), fixes, renders partial, and hub_review_status gives the page's status/claudeNote updates as one batch.
import fs from 'node:fs';
import path from 'node:path';
import { project } from './scan.js';
import { vhDir, list as listNotes, add as addNote, update as updateNote } from './notes.js';
import { scenesOf } from './scenes.js';
import { transcript } from './transcript.js';
import { HUB_DIR, TOOLS, readJson, writeJson, run, probe, now } from './util.js';

const TEMPLATE = path.join(HUB_DIR, 'templates', 'review-page', 'template.html');
const TYPES = ['voice', 'visuals', 'text', 'timing', 'other'];
const KIND = { voice: 'sound', visuals: 'visual', text: 'text', timing: 'timing', other: 'general' };
const pad = (i, n) => String(i + 1).padStart(Math.max(2, String(n).length), '0');

// sections for the page: review-sections.json in the film ({sectionLabel, sections:[{n,start,end,text}]}), else the
// narration sentences, else the scenes, else the render chunks (what a partial re-render redoes)
export function sectionsFrom({ own, phrases, scenes, chunkSec, duration }) {
  const fix = (list, label) => {
    const s = list.filter(x => Number.isFinite(+x.start)).map(x => ({ n: String(x.n ?? ''), start: +(+x.start).toFixed(3), end: x.end != null ? +(+x.end).toFixed(3) : null, text: String(x.text || '') }))
      .filter(x => x.start < duration).sort((a, b) => a.start - b.start);
    if (!s.length) return null;
    s.forEach((x, i) => { if (!x.n) x.n = pad(i, s.length); if (x.end == null || x.end <= x.start) x.end = i + 1 < s.length ? s[i + 1].start : duration; x.end = Math.min(x.end, duration); });
    if (s[0].start > 0.05) s.unshift({ n: '00', start: 0, end: s[0].start, text: '(before the first ' + label.toLowerCase() + ')' });
    s[s.length - 1].end = duration;
    return { sectionLabel: label, sections: s };
  };
  if (own && Array.isArray(own.sections)) { const r = fix(own.sections, own.sectionLabel || 'Section'); if (r) return { ...r, source: 'review-sections.json' }; }
  if (phrases?.length) { const r = fix(phrases.map(([a, b, t]) => ({ start: a, end: b, text: t })), 'Line'); if (r) return { ...r, source: 'narration' }; }
  if (scenes?.length) { const r = fix(scenes.map(s => ({ start: s.t0, end: s.t1, text: s.name })), 'Scene'); if (r) return { ...r, source: 'scenes' }; }
  const cs = chunkSec || 2, n = Math.max(1, Math.ceil(duration / cs - 1e-6));
  return { sectionLabel: 'Chunk', source: 'chunks', sections: Array.from({ length: n }, (_, i) => ({ n: String(i).padStart(2, '0'), start: i * cs, end: Math.min(duration, (i + 1) * cs), text: `Chunk ${i} · ${i * cs}–${Math.min(duration, (i + 1) * cs)} s` })) };
}

// review copy size: fit maxMB (Artifact files max ~15 MB), 720p when the bitrate allows, else 540p/480p
export function reviewPlan(duration, maxMB = 14, audioK = 64) {
  const videoK = Math.floor((maxMB * 0.92 * 8388.608) / Math.max(1, duration) - audioK);
  return { videoK: Math.max(60, Math.min(videoK, 2500)), height: videoK >= 300 ? 720 : videoK >= 180 ? 540 : 480, audioK };
}

export function buildPage(cfg, template = fs.readFileSync(TEMPLATE, 'utf8')) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const title = String(cfg.title || 'Video review').replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;');
  return template.replace('/*CONFIG*/', () => json).replace('<title>Video review</title>', () => `<title>${title}</title>`);
}

const reviewDir = p => path.join(vhDir(p), 'review');
const stateFile = p => path.join(reviewDir(p), 'state.json');   // {url, rounds:[{round,file,at,dir}], imported:{pageId: vhId}}
export const reviewState = p => readJson(stateFile(p), { url: null, rounds: [], imported: {} });
const saveState = (p, s) => writeJson(stateFile(p), s);

export async function build(p, { file, round, title, maxMB = 14, url, note } = {}) {
  const st = reviewState(p);
  const out = file ? p.outputs.find(o => o.rel === file || o.path === file || o.name === file) : p.outputs.find(o => o.rel === p.latest) || p.outputs[0];
  if (!out) throw Object.assign(new Error('No rendered video in this project yet: render first (hub_render).'), { code: 409 });
  const info = await probe(out.path); if (!info.ok) throw Object.assign(new Error('Cannot read ' + out.path), { code: 422 });
  const R = round || Math.max(0, ...st.rounds.map(r => r.round)) + 1, dir = path.join(reviewDir(p), 'round-' + R);
  fs.mkdirSync(dir, { recursive: true });
  const fps = info.fps || p.render?.fps || 30, dur = info.dur, plan = reviewPlan(dur, maxMB), aspect = info.w && info.h ? info.w / info.h : 16 / 9;
  // the review copy: a key frame every second so the page's frame stepping and scrubbing stay quick
  const mp4 = path.join(dir, 'review.mp4'), h = Math.min(plan.height, info.h || plan.height);
  const enc = k => [TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', out.path, '-vf', `scale=-2:${h}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-maxrate', k + 'k', '-bufsize', 2 * k + 'k',
    '-g', String(Math.round(fps)), '-pix_fmt', 'yuv420p', ...(info.audio ? ['-c:a', 'aac', '-b:a', plan.audioK + 'k'] : ['-an']), '-movflags', '+faststart', mp4]];
  let k = plan.videoK;
  for (let i = 0; i < 3; i++) {
    const r = await run(...enc(k)); if (r.code) throw new Error('ffmpeg (review copy): ' + r.stderr.slice(-300));
    if (fs.statSync(mp4).size <= maxMB * 1048576) break; k = Math.floor(k * 0.8);
  }
  // the strip's thumbnail sheet: 2 per second, 40 per row, each tile the video's shape (64 px on its long side)
  const sw = aspect >= 1 ? 64 : Math.round(64 * aspect / 2) * 2, sh = aspect >= 1 ? Math.round(64 / aspect / 2) * 2 : 64;
  const count = Math.max(1, Math.floor(dur * 2)), cols = 40, rows = Math.ceil(count / cols), jpg = path.join(dir, 'strip.jpg');
  const s = await run(TOOLS.ffmpeg, ['-v', 'error', '-y', '-i', out.path, '-vf', `fps=2,scale=${sw}:${sh},tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', jpg]);
  if (s.code) throw new Error('ffmpeg (strip): ' + s.stderr.slice(-300));
  const tr = transcript(p), own = readJson(path.join(p.path, 'review-sections.json'), null);
  const secs = sectionsFrom({ own, phrases: tr.ok ? tr.phrases : null, scenes: scenesOf(p).scenes, chunkSec: p.render?.chunkSec, duration: dur });
  const cfg = { title: title || `${p.title || p.name} review`, project: p.title || p.name, render: out.name, round: R, video: 'review.mp4', duration: dur, aspect: +aspect.toFixed(4),
    sectionLabel: secs.sectionLabel, sections: secs.sections, fps, sprite: { src: 'strip.jpg', fps: 2, w: sw, h: sh, cols },
    reviewNote: note || `Round ${R}: ${out.name}. This is a smaller review copy; the full-quality file stays with the film.` };
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, buildPage(cfg));
  writeJson(path.join(dir, 'sections.json'), { duration: dur, sectionLabel: secs.sectionLabel, sections: secs.sections, source: secs.source });
  st.rounds = st.rounds.filter(r => r.round !== R).concat({ round: R, file: out.rel, at: now(), dir }); if (url) st.url = url; saveState(p, st);
  return { round: R, dir, page, files: { 'review.mp4': mp4, 'strip.jpg': jpg }, video: out.rel, duration: dur, fps, sizeMB: +(fs.statSync(mp4).size / 1048576).toFixed(1), sections: secs.sections.length, sectionSource: secs.source, url: st.url };
}

// page notes as ArtifactData wrote them: a folder of <id>.json (any depth), a JSON file (array or {notes}), or an array
export function readPageNotes(src) {
  const docs = [];
  const take = (o, id) => { if (!o || typeof o !== 'object') return; const d = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? o.data : o; const nid = d.id || o.id || o.doc_id || id; if (nid && Number.isFinite(+d.start)) docs.push({ ...d, id: String(nid), _version: o.version ?? d._version ?? null }); };
  if (Array.isArray(src)) src.forEach(o => take(o));
  else if (typeof src === 'string' && fs.existsSync(src) && fs.statSync(src).isDirectory()) {
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.json')) take(readJson(f), e.name.replace(/\.json$/, '')); } };
    walk(src);
  } else if (typeof src === 'string') { const j = readJson(src); (Array.isArray(j) ? j : j?.notes || []).forEach(o => take(o)); }
  return docs.sort((a, b) => a.start - b.start);
}

// one page note → the VideoHub note fields (text keeps the page's tags; kind from the first tag)
export function toHubNote(n, file) {
  const types = (Array.isArray(n.types) && n.types.length ? n.types : String(n.type || 'other').split(/\s*,\s*/)).filter(t => TYPES.includes(t));
  const end = n.end != null && +n.end > +n.start ? +n.end : null;
  return { t: +n.start, t2: end, file, kind: KIND[types[0]] || 'general', text: `[${(types.length ? types : ['other']).join(', ')}] ${String(n.text || '').trim()} (review page #${n.id}, round ${n.round ?? '?'})` };
}

export async function importNotes(p, { dir, file, notes, all = false }) {
  const st = reviewState(p), docs = readPageNotes(notes || dir || file);
  const hub = new Map(listNotes(p).map(n => [n.id, n])), res = { added: [], updated: [], kept: [], skipped: [] };
  for (const n of docs) {
    if (!all && n.state !== 'submitted') { res.skipped.push(n.id); continue; }
    const round = st.rounds.find(r => r.round === n.round) || st.rounds[st.rounds.length - 1], body = toHubNote(n, round?.file || null);
    const known = st.imported[n.id] && hub.get(st.imported[n.id]);
    if (!known) { const h = await addNote(p, body); st.imported[n.id] = h.id; res.added.push({ page: n.id, note: h.id, chunks: h.chunks, text: h.text, snapshotId: n.snapshotId || null, kind: n.kind }); continue; }
    if (known.text !== body.text || known.t !== body.t || known.t2 !== body.t2) {
      updateNote(p, known.id, { text: body.text, t: body.t, t2: body.t2, ...(['fixed', 'approved'].includes(known.status) ? { status: 'reopened' } : {}) }, 'user');
      res.updated.push({ page: n.id, note: known.id, snapshotId: n.snapshotId || null });
    } else res.kept.push({ page: n.id, note: known.id });
  }
  saveState(p, st);
  return { ...res, notes: res.added.map(x => x.note).concat(res.updated.map(x => x.note)) };
}

// VideoHub status → the page: fixed/approved = done, claude = working, open/reopened = open; reply = claudeNote
export function pageUpdates(p, pageDocs = null, versions = {}) {
  const st = reviewState(p), hub = new Map(listNotes(p).map(n => [n.id, n])), vers = new Map([...(pageDocs || []).map(d => [d.id, d._version]), ...Object.entries(versions || {})]);
  const writes = [];
  for (const [pid, hid] of Object.entries(st.imported)) {
    const n = hub.get(hid); if (!n) continue;
    const status = ['fixed', 'approved'].includes(n.status) ? 'done' : n.status === 'claude' ? 'working' : 'open';
    const data = { status, ...(n.reply ? { claudeNote: n.reply } : {}), hubNote: n.id, ...(n.fixedIn ? { fixedIn: n.fixedIn } : {}) };
    writes.push({ op: 'update', collection: 'notes', doc_id: pid, data, ...(vers.get(pid) ? { if_version: vers.get(pid) } : {}) });
  }
  return writes;
}

export function routes(route, readBody) {
  const need = id => { const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 }); return p; };
  route('POST', '/api/project/:id/review/build', async (req, url, { id }) => build(need(id), await readBody(req)));
  route('POST', '/api/project/:id/review/import', async (req, url, { id }) => importNotes(need(id), await readBody(req)));
  route('POST', '/api/project/:id/review/status', async (req, url, { id }) => { const b = await readBody(req); const p = need(id); return { url: reviewState(p).url, writes: pageUpdates(p, b.dir ? readPageNotes(b.dir) : null, b.versions) }; });
}
