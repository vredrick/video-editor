import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sectionsFrom, reviewPlan, buildPage, readPageNotes, toHubNote } from './review.js';

test('sections: own file, then narration, then scenes, then render chunks; gaps and ends filled', () => {
  let r = sectionsFrom({ own: { sectionLabel: 'Line', sections: [{ n: '01', start: 0.3, text: 'a' }, { n: '02', start: 5, text: 'b' }] }, duration: 9 });
  assert.equal(r.source, 'review-sections.json'); assert.deepEqual(r.sections.map(s => [s.n, s.start, s.end]), [['00', 0, 0.3], ['01', 0.3, 5], ['02', 5, 9]]);
  r = sectionsFrom({ phrases: [[0, 2, 'Hi.'], [2.5, 4, 'Bye.']], duration: 4 });
  assert.equal(r.sectionLabel, 'Line'); assert.equal(r.sections.length, 2); assert.equal(r.sections[0].end, 2); assert.equal(r.sections[1].end, 4);
  r = sectionsFrom({ scenes: [{ name: 'Intro', t0: 0, t1: 3 }], duration: 5 }); assert.equal(r.source, 'scenes'); assert.equal(r.sections[0].end, 5);
  r = sectionsFrom({ chunkSec: 2, duration: 5 }); assert.equal(r.sectionLabel, 'Chunk'); assert.deepEqual(r.sections.map(s => [s.n, s.start, s.end]), [['00', 0, 2], ['01', 2, 4], ['02', 4, 5]]);
});

test('review copy plan fits ~14 MB: 720p for a few minutes, smaller for long videos', () => {
  const short = reviewPlan(220), long = reviewPlan(900);
  assert.equal(short.height, 720); assert.ok(long.height < 720);
  assert.ok((short.videoK + short.audioK) * 220 / 8 / 1024 < 14);
});

test('page config goes in safely and the title is set', () => {
  const html = buildPage({ title: 'A <b> & c', sections: [{ text: '</script><script>x()' }] }, '<title>Video review</title><script type="application/json" id="cfg">\n/*CONFIG*/\n</script>');
  assert.match(html, /<title>A &lt;b> &amp; c<\/title>/); assert.ok(!html.includes('</script><script>x()')); assert.equal(JSON.parse(html.split('\n')[1]).sections[0].text, '</script><script>x()');
});

test('page notes from an ArtifactData folder become VideoHub notes with their tags', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'videohub-review-test-'));
  try {
    fs.mkdirSync(path.join(d, 'notes'));
    fs.writeFileSync(path.join(d, 'notes', 'n2.json'), JSON.stringify({ start: 8.2, end: 9.4, types: ['text', 'timing'], text: ' Change it ', round: 2, state: 'submitted' }));
    fs.writeFileSync(path.join(d, 'notes', 'n1.json'), JSON.stringify({ id: 'n1', start: 1.5, end: null, type: 'voice', text: 'Louder', round: 1, state: 'draft' }));
    const docs = readPageNotes(d);
    assert.deepEqual(docs.map(x => x.id), ['n1', 'n2']);
    assert.deepEqual(toHubNote(docs[1], 'film_v2.mp4'), { t: 8.2, t2: 9.4, file: 'film_v2.mp4', kind: 'text', text: '[text, timing] Change it (review page #n2, round 2)' });
    assert.equal(toHubNote(docs[0], null).kind, 'sound'); assert.equal(toHubNote(docs[0], null).t2, null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
