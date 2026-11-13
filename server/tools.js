// The tools Claude uses (through mcp.js, or `node server/cli.js <tool> '<json>'` without MCP).
// They talk to the hub over http://127.0.0.1:7788 and start it when it is not running.
// Status inputs accept the English values and, as aliases, the Turkish words older versions used.
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { HUB_DIR, readJson } from './util.js';
import { NOTE_STATUSES, NOTE_STATUS_ALIASES, PROJECT_STATUSES, PROJECT_STATUS_ALIASES, noteStatus, projectStatus, isOpenNote, normalizeNote } from '../ui/values.js';

// renders and versions made through these tools are labelled "Claude"; the tools never look at which chat called them
const BY_CLAUDE = { title: 'Claude' };
const PORT = +process.env.VIDEOHUB_PORT || (readJson(path.join(HUB_DIR, 'data', 'config.json'), {}) || {}).port || 7788;   // env: talk to a test hub
const BASE = `http://127.0.0.1:${PORT}`;

async function ping() { try { const r = await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
async function ensureHub() {
  if (await ping()) return;
  const child = spawn(process.execPath, [path.join(HUB_DIR, 'server', 'hub.js')], { cwd: HUB_DIR, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); if (await ping()) return; }
  throw new Error('Could not start the VideoHub server (' + BASE + ').');
}
async function call(method, p, body, timeoutMs = 120e3) {
  await ensureHub();
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const TC = s => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; };
const GB = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
async function resolve(projectArg) {
  const q = projectArg || process.cwd();
  const p = await call('GET', '/api/find?q=' + encodeURIComponent(q));
  if (Array.isArray(p.notes)) p.notes.forEach(normalizeNote);
  return p;
}
const FAM = { A: 'chunked (partial re-renders available)', B: 'worker parts', C: 'segments', studio: '3D studio scene', otomasyon: 'text-to-video pipeline', snipp: 'Snipp', media: 'video folder', code: 'code (no chunked render script)', other: 'other' };
const isOpen = n => isOpenNote({ status: noteStatus(n.status) });

// a thumbnail by project + id, or by its id alone (then the hub searches every project)
async function thumbLoc(a) {
  if (!a.id) throw new Error('id is required (the thumbnail id, e.g. 20261104-k3f9)');
  if (a.project && a.project !== '_') {
    const p = await resolve(a.project);
    const list = await call('GET', '/api/thumbstudio/list?project=' + encodeURIComponent(p.id));
    const t = (list || []).find(x => x.id === a.id);
    if (!t) throw new Error(`Project "${p.title}" has no thumbnail ${a.id}.`);
    return { pid: p.id, dir: t.dir };
  }
  const t = await call('GET', '/api/thumbstudio/find/' + encodeURIComponent(a.id));
  return { pid: t.pid, dir: t.dir };
}

export const TOOLS = {
  hub_live: {
    description: 'Open the film in VideoHub\'s live preview WITHOUT RENDERING: it plays straight from its code, the user watches and leaves notes, and the preview reloads itself when the code changes. Call this as soon as a new film (or a big change) plays, BEFORE any render; then stop and wait for the user\'s notes. Render only when the user asks. If the page lacks window.renderOut(t) + window.READY, it says why.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      open: z.boolean().optional().describe('false = only check, do not open a window'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const li = await call('GET', `/api/project/${p.id}/live`);   // also starts watching the code for changes
      if (!li.ok) return `The live preview could not open: ${li.reason}\nWhat it needs (docs/PROJECT-CONTRACT.md): the page defines window.renderOut(t), which draws second t synchronously on fixed-size canvases, and sets window.READY = true when ready; the sound in audio/mix.wav. Anything different goes in .videohub/project.json → live: {page, audio, dur, fps}.`;
      let how = 'none';
      if (a.open !== false) how = (await call('POST', '/api/show', { hash: `#/review/${p.id}/~live` })).how;
      return [
        `Live preview ready: "${p.title}" · ${li.page} · ${li.fps} fps · ${TC(li.dur)} (length from: ${li.durFrom}) · sound: ${li.audioName || 'none'}`,
        how === 'window' ? 'The open VideoHub window switched to this film.' : how === 'opened' ? 'A VideoHub window opened.' : '',
        'Now STOP, do not render. Tell the user (in their language): watch it in VideoHub, leave notes on the frames, then press "Send to Claude" and paste the message here. Get the notes with hub_notes, fix the code (the preview reloads itself), mark each with hub_note_update. Render with hub_render only when the user asks for a render.',
        li.durFrom === 'default' ? 'The film length is unknown (60 s assumed): save it with hub_project({set:{render:{env:{DUR:"…"}}}}).' : '',
      ].filter(Boolean).join('\n');
    },
  },
  hub_workspace: {
    description: 'Where this PC keeps its video work: the workspace folder and, inside it, the films folder (make every new film there, one folder per film), the outputs folder (finished renders are collected there by VideoHub; never write there yourself) and the other watched folders. Call it before creating a new film.',
    schema: {},
    run: async () => {
      const c = await call('GET', '/api/config');
      const roots = (c.roots || []).filter(r => r.enabled !== false);
      const films = (roots.find(r => r.type === 'container') || {}).path;
      return [
        `Workspace: ${c.workspace}`,
        films ? `New films go in: ${path.join(films, '<film-name>')}  (one folder per film; copy ${path.join('templates', 'new-film')} from the VideoHub folder)` : 'No films folder is set: ask the user to add one in VideoHub > Settings > Folders.',
        `Finished renders are collected in: ${c.outputsDir}  (VideoHub links every render there by day; do not write there)`,
        `Sounds: ${c.soundLibDir}  ·  Thumbnails: ${c.thumbstudio?.globalDir}  ·  Archive: ${c.archiveDir}`,
        roots.length > 1 ? 'Other watched folders: ' + roots.filter(r => r.path !== films).map(r => `${r.path} (${r.type})`).join(', ') : '',
        'Keep each film self-contained in its own folder (code, audio, render/); never put one film\'s files into another film\'s folder.',
      ].filter(Boolean).join('\n');
    },
  },
  hub_project: {
    description: 'Find this project in VideoHub (project folder, name or id). Gives its status, versions, open notes and render recipe (DUR, chunk length). `set` saves title / status / render recipe; render.mux is an ffmpeg argument array with {video} and {out} placeholders.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      set: z.object({ title: z.string().optional(), status: z.enum([...PROJECT_STATUSES, ...PROJECT_STATUS_ALIASES]).optional().describe('in-progress | review | revision | approved | published | archived | done'), render: z.object({ script: z.string().optional(), workers: z.number().optional(), env: z.record(z.string(), z.string()).optional(), mux: z.array(z.string()).optional() }).optional() }).optional(),
    },
    run: async a => {
      let p = await resolve(a.project);
      if (a.set) { const set = { ...a.set }; if (set.status) set.status = projectStatus(set.status); await call('POST', `/api/project/${p.id}/meta`, set); p = await resolve(p.id); }
      const rc = await call('GET', `/api/project/${p.id}/recipe`).catch(() => null);
      const vs = (p.versionsLog || []).slice(-5);
      const open = (p.notes || []).filter(isOpen);
      return [
        `Project: ${p.title} (id ${p.id})  ·  ${p.path}`,
        `Kind: ${FAM[p.family] || p.family}  ·  status: ${projectStatus(p.status)}${p.statusAuto ? ' (automatic)' : ''}`,
        rc ? `Render: ${rc.script || 'make.mjs'}, ${rc.fps} fps${rc.chunkSec ? `, ${rc.chunkSec} s chunks (${rc.chunks ?? '?'} chunks)` : ''}${rc.env?.DUR ? `, DUR=${rc.env.DUR}${rc.durInferred ? ' (worked out from the chunks)' : ''}` : ''}${rc.mux ? ', own sound recipe (render.mux)' : ', sound: the previous final\'s track, else the film\'s own audio file'}` : '',
        `Latest video: ${p.latest || '—'}  ·  folder ${GB(p.sizes?.total || 0)}`,
        vs.length ? 'Latest versions: ' + vs.map(v => `v${v.v} ${v.file}${v.changedRanges ? ` (changed: ${v.changedRanges.map(([x, y]) => TC(x) + '–' + TC(y)).join(', ')})` : ''}`).join(' | ') : '',
        `Notes: ${open.length} open / ${(p.notes || []).length} total${open.length ? ' → get them with hub_notes' : ''}`,
      ].filter(Boolean).join('\n');
    },
  },

  hub_notes: {
    description: 'The notes the user left on frames in VideoHub\'s review: time, frame, the render chunks it touches, text, and the paths of the annotated pictures. Open the pictures with Read (the crop first, the annotated frame if needed). Default: open + reopened notes; they are marked "claude" (taken).',
    schema: {
      project: z.string().optional(),
      status: z.enum(['all', ...NOTE_STATUSES, ...NOTE_STATUS_ALIASES]).optional().describe('open = open + reopened (default)'),
      take: z.boolean().optional().describe('Mark the returned open notes "claude" (default true)'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const st = a.status ? (a.status === 'all' ? 'all' : noteStatus(a.status)) : 'open';
      const notes = (p.notes || []).filter(n => st === 'all' || (st === 'open' ? isOpen(n) : n.status === st)).sort((x, y) => x.t - y.t);
      if (!notes.length) return `No ${st === 'open' ? 'open ' : ''}notes on "${p.title}".`;
      if (a.take !== false) for (const n of notes) if (isOpen(n)) await call('POST', `/api/project/${p.id}/note/${n.id}`, { status: 'claude', by: 'claude' });
      const lines = [`"${p.title}" (${p.path}) — ${notes.length} note${notes.length === 1 ? '' : 's'}:`];
      for (const n of notes) {
        const fr = n.frames || (n.t2 != null && n.fps ? [Math.floor(n.t * n.fps + 1e-6), Math.floor(n.t2 * n.fps + 1e-6)] : null);
        lines.push(`#${n.id} [${n.status === 'reopened' ? 'STILL THERE (the previous fix did not work)' : n.status}] ${TC(n.t)}${n.t2 != null ? '–' + TC(n.t2) : ''}  ${fr ? `RANGE frames ${fr[0]}–${fr[1]}${n.frame != null && n.frame !== fr[0] ? ` (drawing on frame ${n.frame})` : ''}` : `frame ${n.frame ?? '?'}`}${n.chunks ? `  chunks ${n.chunks.join(',')}` : ''}  ${n.kind}${n.layer ? '  layer: ' + n.layer : ''}  ${n.file === '~live' ? 'LIVE PREVIEW (no render — fix the code, do not render)' : 'file: ' + (n.file || '?')}`);
        if (n.text) lines.push(`   "${n.text}"`);
        if (n.say) lines.push(`   narration at that moment: «${n.say}»`);
        if (n.images?.crop) lines.push(`   close-up: ${n.images.crop}`);
        if (n.images?.annotated) lines.push(`   full frame + drawing: ${n.images.annotated}`);
        if (n.images?.start) lines.push(`   first frame of the range: ${n.images.start}`);
        if (n.images?.end) lines.push(`   last frame of the range: ${n.images.end}`);
        if (n.reply) lines.push(`   your previous reply: ${n.reply}`);
      }
      const liveN = notes.filter(n => n.file === '~live').length;
      if (liveN) lines.push('', `LIVE PREVIEW notes (${liveN}): fix the code, do NOT render — the user's open preview reloads itself when the code changes and shows the fix at once. Then for each note hub_note_update(status:"fixed", reply:"what you did, 1 sentence"). The user asks for the render at the end.`);
      if (liveN < notes.length) lines.push('', 'Notes on a rendered video: after fixing, mark each with hub_note_update(status:"fixed", reply:"what you did, 1 sentence"). Render only when the user asks; then hub_render({mode:"partial", notes:[...]}) re-renders just those chunks. Do not re-review the whole film yourself — the user checks the changed ranges in VideoHub.');
      return lines.join('\n');
    },
  },

  hub_note_update: {
    description: 'Save a note\'s status and a short reply (the user sees it in VideoHub). After fixing: status "fixed" + reply.',
    schema: { project: z.string().optional(), id: z.number(), status: z.enum(['claude', 'fixed', 'open', ...NOTE_STATUS_ALIASES]).optional(), reply: z.string().optional() },
    run: async a => { const p = await resolve(a.project); const n = await call('POST', `/api/project/${p.id}/note/${a.id}`, { status: a.status ? noteStatus(a.status) : undefined, reply: a.reply, by: 'claude' }); return `#${n.id} → ${n.status}${n.reply ? ' · ' + n.reply : ''}`; },
  },

  hub_render: {
    description: 'Put a render in VideoHub\'s queue (one render at a time on this computer; CPU/RAM protection on when the agent is installed). Only when the user asked for a render. mode "partial": only the chunks the notes/seconds/chunks touch are rendered again, the film is joined, the previous final\'s sound is put back, and a new version (…_vN.mp4) is saved with the changed ranges. "full": the whole film. "preview": PREVIEW=1 (projects that support it). "command": your own command (cmd) + output file; the user has to approve it in VideoHub before it runs. wait=true waits until it ends (at most ~9 min). Options: workers (parallel workers / Chrome copies for 3D), env.FPS (if the script reads FPS, full only), env.CODEC (3D: x264|nvenc|amf); what a project supports: GET /api/project/<id>/render-options.',
    schema: {
      project: z.string().optional(),
      mode: z.enum(['partial', 'full', 'preview', 'command']).optional(),
      notes: z.array(z.number()).optional().describe('Note numbers (partial)'),
      seconds: z.array(z.tuple([z.number(), z.number()])).optional().describe('[[start,end]] in seconds (partial)'),
      chunks: z.array(z.number()).optional().describe('Chunk numbers (partial)'),
      env: z.record(z.string(), z.string()).optional(),
      copyTo: z.string().optional().describe('Also copy the result into this folder when done (full path); the original stays in the project'),
      workers: z.number().optional(),
      cmd: z.string().optional().describe('mode command: the command line (runs in the project folder)'),
      output: z.string().optional().describe('mode command: the video it makes (relative to the project folder)'),
      note: z.string().optional().describe('Version description'),
      wait: z.boolean().optional(),
    },
    run: async a => {
      const p = await resolve(a.project);
      const j = await call('POST', '/api/jobs', { project: p.id, mode: a.mode || 'partial', notes: a.notes, seconds: a.seconds, chunks: a.chunks, env: a.env, workers: a.workers, cmd: a.cmd, output: a.output, note: a.note, copyTo: a.copyTo, session: BY_CLAUDE });
      const head = `Job ${j.id} queued (position ${j.position}) · ${j.mode}${j.chunks ? ` · ${j.chunks.length} chunk${j.chunks.length === 1 ? '' : 's'} (${j.chunks.join(',')}) = ${j.changedRanges.map(([x, y]) => TC(x) + '–' + TC(y)).join(', ')}` : ''}` +
        (j.ramNote ? `\n${j.ramNote} → Tell the user this in one sentence; never close the program yourself.` : '');
      if (j.needsApproval) return head + '\nThis is a custom command, so it does NOT run until the user approves it in VideoHub (Renders page: it shows the command with Approve / Cancel). Tell the user that now, in one sentence, then check with hub_job({id:"' + j.id + '", wait:true}).';
      if (!a.wait) return head + '\nWait with hub_job({id:"' + j.id + '", wait:true}).';
      return head + '\n' + await TOOLS.hub_job.run({ id: j.id, wait: true });
    },
  },

  hub_job: {
    description: 'The state of a render job. wait=true waits until it ends (at most ~9 min); call again if it has not ended.',
    schema: { id: z.string(), wait: z.boolean().optional() },
    run: async a => {
      const j = await call('GET', `/api/jobs/${a.id}` + (a.wait ? '?wait=540' : ''), null, 600e3);
      const parts = [`Job ${j.id}: ${j.state}${j.state === 'running' ? ` ${Math.round((j.progress || 0) * 100)}%` : ''}${j.state === 'queued' && j.waiting ? ` (waiting: ${j.waiting})` : ''}`];
      if (j.output) parts.push(`Output: ${j.output} (v${j.version})${j.changedRanges ? ` · changed: ${j.changedRanges.map(([x, y]) => TC(x) + '–' + TC(y)).join(', ')}` : ''}${j.durationSec ? ` · took ${j.durationSec} s` : ''}`);
      if (j.ramNote && j.state !== 'done') parts.push(j.ramNote);
      if (j.error) parts.push('Error: ' + j.error);
      if (j.log) parts.push('Log: ' + j.log);
      if (j.state === 'done') parts.push('The user checks the new version in VideoHub with "Watch only the changes"; do not re-review the whole film.');
      if (j.state === 'done' && j.outputPath) parts.push(`Full path: ${j.outputPath}${j.copiedTo ? ` (copy: ${j.copiedTo})` : ''}${j.linkedTo ? `\nIn the outputs folder: ${j.linkedTo}` : ''}\nIt is listed in VideoHub > Renders > "Recent renders" (▶ Watch / 📂 Show in folder); no need to show the video in the chat, the path is enough.`);
      return parts.join('\n');
    },
  },

  hub_register_version: {
    description: 'Register a video made outside VideoHub\'s queue as this project\'s new version (with the seconds that changed).',
    schema: { project: z.string().optional(), file: z.string(), note: z.string().optional(), changedRanges: z.array(z.tuple([z.number(), z.number()])).optional(), notes: z.array(z.number()).optional(), kind: z.enum(['final', 'preview']).optional() },
    run: async a => { const p = await resolve(a.project); const r = await call('POST', `/api/project/${p.id}/version`, { ...a, session: BY_CLAUDE }); return `Registered: v${r.v} ${r.file}`; },
  },

  hub_cleanup: {
    description: 'List the files of this project that can safely be removed (a list only; the user decides on VideoHub\'s Disk page).',
    schema: { project: z.string().optional() },
    run: async a => {
      const p = await resolve(a.project); const d = await call('GET', `/api/project/${p.id}`);
      if (!d.cleanup.length) return 'Nothing to clean up.';
      return [`"${p.title}" — ${GB(d.cleanup.reduce((s, c) => s + c.size, 0))} can be cleaned up:`, ...d.cleanup.map(c => `- ${GB(c.size)} ${c.path} — ${c.reason}`), 'Tell the user to approve it on VideoHub\'s Disk page (Recycle Bin / archive). Never delete these yourself.'].join('\n');
    },
  },

  hub_thumbs: {
    description: 'List the thumbnails of a project or of the shared area: id, title, status, number of variants and folder.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Empty: every thumbnail (projects + shared).'),
    },
    run: async a => {
      let pId = null;
      if (a.project && a.project !== '_') {
        const p = await resolve(a.project);
        pId = p.id;
      } else if (a.project === '_') {
        pId = '_';
      }
      const list = await call('GET', '/api/thumbstudio/list' + (pId ? '?project=' + encodeURIComponent(pId) : ''));
      if (!list || !list.length) return 'No thumbnails found.';
      const lines = [`${list.length} thumbnail${list.length === 1 ? '' : 's'}:`, ''];
      for (const t of list) {
        lines.push(`- [${t.id}] "${t.title}" (${t.format}) · Status: ${t.status} · Variants: ${t.variantCount || 0} · Project: ${t.projectName || 'Shared'}\n  Folder: ${t.dir}`);
      }
      return lines.join('\n');
    },
  },

  hub_thumb_brief: {
    description: 'The thumbnail brief for Claude in one text: goal, camera, light, style, the layers in words, an English prompt draft, references (role and full paths), the paths of layout.png / sketch.png / depth.png and open variant notes. Includes what to do.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. For a shared thumbnail "_" or leave empty.'),
      id: z.string().describe('Thumbnail id (e.g. 20261104-k3f9)'),
    },
    run: async a => {
      const { pid: pId } = await thumbLoc(a);
      const brief = await call('GET', `/api/thumbstudio/${pId}/${a.id}`);
      const folder = (await thumbLoc(a)).dir;

      const layoutPath = path.join(folder, 'layout.png');
      const sketchPath = path.join(folder, 'sketch.png');
      const depthPath = path.join(folder, 'depth.png');
      const hasLayout = fs.existsSync(layoutPath);
      const hasSketch = fs.existsSync(sketchPath);

      // open notes on the variants
      const openNotes = [];
      for (const v of brief.variants || []) {
        for (const n of v.notes || []) {
          if (noteStatus(n.status) === 'open') openNotes.push({ vid: v.id, ...n });
        }
      }

      const { generatePrompt } = await import('./thumbstudio/prompt.js');
      const gp = generatePrompt(brief), prompt = gp.prompt, summary = gp.summary || gp.summaryTr;
      const mark = f => fs.existsSync(f) ? '✓ (exists)' : '✗ (not exported yet)';

      const parts = [
        `=== VIDEOHUB THUMBNAIL BRIEF: "${brief.title || 'Untitled'}" (${brief.format || '16:9'}) ===`,
        `Id: ${brief.id}`,
        `Folder: ${folder}`,
        '',
        summary,
        '',
        '--- Pictures ---',
        `- layout.png: ${layoutPath} ${mark(layoutPath)}`,
        `- sketch.png: ${sketchPath} ${mark(sketchPath)}`,
        `- depth.png: ${depthPath} ${mark(depthPath)}`,
      ];

      if (openNotes.length > 0) {
        parts.push('\n--- Open variant notes (fix requests) ---');
        for (const n of openNotes) {
          const loc = n.x !== undefined ? (n.y < 0.38 ? 'top' : n.y > 0.62 ? 'bottom' : 'middle') + ' ' + (n.x < 0.38 ? 'left' : n.x > 0.62 ? 'right' : 'centre') : '';
          parts.push(`- Variant ${n.vid} [note #${n.id}]: "${n.text}" (${loc})`);
        }
      }

      const refs = (brief.refs || []).filter(r => r.file);
      if (refs.length) {
        parts.push('\n--- Reference files (full paths) ---');
        for (const r of refs) parts.push(`- [${r.role}] ${path.join(folder, r.file)}${r.note ? ' — ' + r.note : ''}`);
      }
      if ((brief.variants || []).length) {
        parts.push('\n--- Variants ---');
        for (const v of brief.variants) parts.push(`- ${v.id}${v.id === brief.chosen ? ' (CHOSEN)' : ''}: ${path.join(folder, v.file)} · ${v.by}${v.parent ? ' · fix of ' + v.parent : ''}`);
      }
      parts.push('\n--- English image prompt draft ---');
      parts.push(prompt);

      parts.push('\n--- What to do ---');
      if (!hasLayout) {
        parts.push('NOTE: layout.png has not been exported yet. Ask the user to press "💬 Send to Claude" (or Ctrl+S) in VideoHub\'s editor; do not generate anything until then.');
      } else {
        parts.push('1. Open `sketch.png` and `layout.png` with Read and study the composition.' + (hasSketch ? '' : ' (sketch.png is missing: use layout.png.)'));
        if (openNotes.length > 0) {
          parts.push(`2. There are open variant notes: take variant ${openNotes[0].vid} as the reference together with layout.png and change only what the notes ask for.`);
        } else {
          parts.push('2. Generate the image with whatever image tool you have; the first reference image must be ' + layoutPath + '.');
        }
        parts.push('3. Register the result with `hub_thumb_variant({id:"' + a.id + '", file:"<path of the generated file>"' + (openNotes.length ? ', parent:"' + openNotes[0].vid + '", fixes:[' + openNotes.filter(n => n.vid === openNotes[0].vid).map(n => n.id).join(',') + ']' : '') + '})`.');
        parts.push('4. Do NOT draw the title text into the image (text policy: overlay; the user adds the text in VideoHub).');
      }

      return parts.join('\n');
    },
  },

  hub_thumb_variant: {
    description: 'Register an image made by Claude or another tool as a VideoHub thumbnail variant. The file is copied into variants/ and shows up in the open editor at once.',
    schema: {
      project: z.string().optional().describe('Project folder or id. Shared: "_" or leave empty.'),
      id: z.string().describe('Thumbnail id'),
      file: z.string().describe('Full path of the generated image'),
      prompt: z.string().optional().describe('The English prompt used'),
      parent: z.string().optional().describe('The variant id this fixes (e.g. v1_2)'),
      fixes: z.array(z.number()).optional().describe('Ids of the variant notes this answers (e.g. [1, 2])'),
    },
    run: async a => {
      const { pid: pId } = await thumbLoc(a);
      const res = await call('POST', `/api/thumbstudio/${pId}/${a.id}/variant`, {
        file: a.file,
        prompt: a.prompt,
        parent: a.parent,
        fixes: a.fixes,
        by: 'claude',
      });
      return `Variant saved: ${res.variant.id} (${res.variant.file})\nIf the editor is open it shows up at once. Tell the user to look at it in VideoHub → Thumbnail.`;
    },
  },
};
