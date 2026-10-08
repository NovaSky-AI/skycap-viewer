// Mirrored records: a sidecar the document's manifest lists whose file is not
// here reads as absent (format.md). Over test/fixtures-mirror, written by
// test/gen_mirror.mjs (see it for what each record is): the API, the readers,
// run discovery, and the views through the dom-shim.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { install, el } from './dom-shim.mjs';
import { createViewer } from '../src/server.js';
import { discover } from '../src/runs.js';
import { check, listIds, missingSidecars, nodeExperts, nodeSamplingMask, nodeTokens, readDocument, readSidecar, sidecarProblems } from '../src/record.js';

install();

const { summarise } = await import('../public/lib/diagnose.mjs');
const { renderPath } = await import('../public/components/path.mjs');
const { recordNotes } = await import('../public/components/drawer.mjs');

const MIRROR = fileURLToPath(new URL('./fixtures-mirror', import.meta.url));

let server;
let base;
const json = async (path, status = 200) => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, status, path);
  return res.json();
};
before(async () => {
  ({ server } = createViewer([MIRROR]));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const RUN = 'fixtures-mirror';
const rows = async () => Object.fromEntries((await json(`/v1/trajectories?run_id=${RUN}&limit=1000`)).data.map((r) => [r.id, r]));
const both = async (id) => ({ trajectory: await json(`/v1/trajectories/${id}?run_id=${RUN}`), paths: await json(`/v1/trajectories/${id}/paths?run_id=${RUN}`) });

// -- the API -------------------------------------------------------------------
test('missing experts and sampling_mask files are absent: no flag, no problem', async () => {
  const flags = (await rows()).tr_mirror_training.summary.flags;
  for (const flag of ['tokens-missing', 'malformed-record']) assert.ok(!flags.includes(flag), flag);
  const { trajectory: t, paths } = await both('tr_mirror_training');
  assert.deepEqual(t.missing_sidecars, ['experts', 'sampling_mask']);
  assert.deepEqual(t.record_problems, []);
  assert.deepEqual(Object.keys(t.sidecars).sort(), ['experts', 'sampling_mask', 'tokens'], 'the document is unchanged');
  assert.equal(paths.text_only, null);
  assert.ok(paths.paths[0].blocks.some((b) => Array.isArray(b.token_ids)));
});

test('a missing tokens file: message text, tokens-missing, and no token flags', async () => {
  const { trajectory: t, paths } = await both('tr_mirror_text');
  assert.equal(paths.mode, 'tokens');
  assert.equal(paths.text_only, 'tokens-missing');
  assert.ok(paths.paths[0].blocks.every((b) => typeof b.text === 'string' && b.start === undefined));
  assert.ok(paths.paths[0].char_count > 0);
  const flags = (await rows()).tr_mirror_text.summary.flags;
  assert.ok(flags.includes('tokens-missing'));
  for (const flag of ['no-logprobs', 'no-train', 'malformed-record']) assert.ok(!flags.includes(flag), flag);
  assert.deepEqual(t.missing_sidecars.sort(), ['experts', 'sampling_mask', 'tokens']);
  const shapes = await json(`/v1/trajectories/tr_mirror_text/paths?run_id=${RUN}&text=false`);
  assert.equal(shapes.text_only, null, 'without text nothing is read, so the strip keeps its token ranges');
  assert.ok(shapes.paths[0].token_count > 0);
});

test('a node slice into a kind the manifest does not list is malformed-record', async () => {
  assert.ok((await rows()).tr_unlisted_experts.summary.flags.includes('malformed-record'));
  const { trajectory: t } = await both('tr_unlisted_experts');
  assert.match(t.record_problems[0], /slices into experts, which is not in the sidecars manifest/);
});

// -- the readers ---------------------------------------------------------------
test('readers: a listed sidecar whose file is missing reads as absent; check does not count it', () => {
  const doc = readDocument(MIRROR, 'tr_mirror_training');
  assert.deepEqual(missingSidecars(MIRROR, doc), ['experts', 'sampling_mask']);
  assert.equal(readSidecar(MIRROR, doc, 'experts'), null);
  const node = doc.nodes.find((n) => n.tokens?.experts_offset != null);
  assert.equal(nodeExperts(doc, null, node.id), null);
  const masked = doc.nodes.find((n) => n.tokens?.mask_rows > 0);
  assert.equal(nodeSamplingMask(doc, null, masked.id), null);
  assert.deepEqual(check(doc, { tokens: readSidecar(MIRROR, doc, 'tokens') }), []);
  const text = readDocument(MIRROR, 'tr_mirror_text');
  assert.equal(nodeTokens(text, null, 0), null);
  assert.deepEqual(check(text, { tokens: readSidecar(MIRROR, text, 'tokens') }), []);
  const unlisted = readDocument(MIRROR, 'tr_unlisted_experts');
  assert.match(check(unlisted).join('\n'), /slices into experts/);
  assert.throws(() => nodeExperts(unlisted, null, node.id), /no experts sidecar/);
  assert.equal(sidecarProblems(doc).length, 0);
});

test('an index/ folder inside a record directory is neither a run nor a record', () => {
  const root = mkdtempSync(join(tmpdir(), 'skycap-mirror-'));
  try {
    const train = join(root, 'train');
    cpSync(MIRROR, train, { recursive: true });
    mkdirSync(join(train, 'index'));
    writeFileSync(join(train, 'index', 'step-1.json'), '{"format_version": 1, "rows": []}\n');
    assert.deepEqual(discover(root), [train]);
    assert.deepEqual(discover(train), [train]);
    assert.deepEqual(listIds(train).sort(), listIds(MIRROR).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- the views -----------------------------------------------------------------
const STATE = { pathIndex: 0, showGiven: true, showControls: false, showLogprobs: false };

test('the path view: a missing tokens sidecar is message text with a warning, counted in characters', async () => {
  const { paths } = await both('tr_mirror_text');
  const root = el();
  renderPath(root, { data: paths, state: STATE, onState() {} });
  const warned = root.findAll((n) => n.hasClass('warn-text'));
  assert.equal(warned.length, 1);
  assert.match(warned[0].textContent, /tokens sidecar missing: showing message text only/);
  assert.equal(root.findAll((n) => n.hasClass('err')).length, 0);
  assert.match(root.textContent, new RegExp(`${paths.paths[0].char_count.toLocaleString('en-US')} chars`), 'counted in characters, not "0 tokens"');
  assert.doesNotMatch(root.textContent, /Text mode: no token ids were captured/, 'it was captured with tokens; this copy lacks them');
});

test('the drawer: a warning for missing tokens, nothing for missing experts or sampling_mask, an error when malformed', async () => {
  const text = await both('tr_mirror_text');
  const notes = recordNotes(text.trajectory);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].hasClass('warn-text'));
  assert.match(notes[0].textContent, /tokens sidecar missing: showing message text only/);
  assert.ok(summarise(text.paths, text.trajectory).flags.includes('tokens-missing'));
  assert.ok(!summarise(text.paths, text.trajectory).flags.includes('no-logprobs'));
  const training = await both('tr_mirror_training');
  assert.deepEqual(recordNotes(training.trajectory), []);
  assert.deepEqual(summarise(training.paths, training.trajectory).flags.filter((f) => ['tokens-missing', 'malformed-record'].includes(f)), []);
  const unlisted = await both('tr_unlisted_experts');
  const bad = recordNotes(unlisted.trajectory);
  assert.ok(bad[0].hasClass('err'));
  assert.match(bad[0].textContent, /Malformed record: node \d+ slices into experts/);
  assert.ok(summarise(unlisted.paths, unlisted.trajectory).flags.includes('malformed-record'));
});
