/** Render every view through the dom-shim, against payloads this viewer's own
 * server returns for real records (test/fixtures: Harbor runs, and records the
 * Python writer produced for the spec's edge cases). Ported from
 * inference-capture's render tests; the payloads are fetched live from the
 * server rather than stored, so a change to the API that a view has not
 * caught up with fails here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { install, el } from './dom-shim.mjs';
import { createViewer } from '../src/server.js';

install();

const { summarise, runHealth } = await import('../public/lib/diagnose.mjs');
const { strip } = await import('../public/components/strip.mjs');
const { renderPath } = await import('../public/components/path.mjs');
const { renderTree } = await import('../public/components/tree.mjs');
const { renderForks } = await import('../public/components/forks.mjs');
const { renderCalls } = await import('../public/components/calls.mjs');
const { renderTable, renderHealth } = await import('../public/components/table.mjs');
const { renderSidebar } = await import('../public/components/sidebar.mjs');

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
let server;
let base;
const payload = {};
const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  return res.json();
};
const bundle = async (id) => ({
  trajectory: await get(`/v1/trajectories/${id}`),
  paths: await get(`/v1/trajectories/${id}/paths`),
  graph: await get(`/v1/trajectories/${id}/graph`),
  exchanges: await get(`/v1/trajectories/${id}/exchanges`),
});

before(async () => {
  ({ server } = createViewer([FIXTURES]));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const id of ['tr_21ffd62fd84bd796', 'tr_2759680d072b0773', 'tr_6b677d3638051778', 'tr_forked_unbridged', 'tr_shared_reply', 'tr_text', 'tr_tokens', 'tr_notext']) {
    payload[id] = await bundle(id);
  }
  payload.runs = (await get('/v1/runs')).data;
  payload.real = await get('/v1/trajectories?run_id=real');
});
after(() => server.close());

const STATE = { pathIndex: 0, showGiven: true, showControls: false, showLogprobs: false, openNode: null, forkLeft: 0, forkRight: 1 };
const forked = () => payload.tr_21ffd62fd84bd796;

// -- the four kinds, and skycap's qualifier ---------------------------------
test('a replayed assistant turn is its own kind, not "untrainable"', () => {
  const { paths } = forked();
  const kinds = paths.paths.flatMap((path) => path.blocks.map((block) => block.kind));
  for (const kind of ['replayed', 'scaffold', 'sampled', 'given']) assert.ok(kinds.includes(kind), kind);
  const root = el();
  renderPath(root, { data: paths, state: { ...STATE, pathIndex: 1 }, onState() {} });
  assert.ok(root.findAll((node) => node.hasClass('badge') && node.textContent === 'replayed').length >= 1);
});

test('a model turn trained on another path is shown as sampled-elsewhere, and says where', () => {
  const { paths } = payload.tr_shared_reply;
  const root = el();
  renderPath(root, { data: paths, state: { ...STATE, pathIndex: 1 }, onState() {} });
  assert.ok(root.findAll((node) => node.hasClass('badge') && node.textContent === 'sampled-elsewhere').length === 1);
  assert.match(root.textContent, /trained in path 0/);
  assert.match(root.textContent, /Train-once: \d+ tokens here were sampled by the model but are trained in path 0/);
  const first = el();
  renderPath(first, { data: paths, state: STATE, onState() {} });
  assert.equal(first.findAll((node) => node.hasClass('badge') && node.textContent === 'sampled-elsewhere').length, 0);
  assert.ok(strip(paths.paths[1].blocks).children.some((seg) => seg.hasClass('sampled-elsewhere')));
});

test('every block shows the token range it occupies', () => {
  const root = el();
  renderPath(root, { data: forked().paths, state: STATE, onState() {} });
  const ranges = root.findAll((node) => node.hasClass('range')).map((node) => node.textContent);
  assert.ok(ranges.length > 0);
  for (const range of ranges) assert.match(range, /^\[\d+:\d+\]$/);
});

test('special tokens and the scaffold are rendered, not stripped', () => {
  const root = el();
  renderPath(root, { data: forked().paths, state: STATE, onState() {} });
  assert.ok(root.textContent.includes('<|im_start|>'));
  assert.ok(root.textContent.includes('<think>'));
});

test('a block renders one span per token, and the spans tile the text', () => {
  const root = el();
  renderPath(root, { data: payload.tr_2759680d072b0773.paths, state: STATE, onState() {} });
  const blocks = payload.tr_2759680d072b0773.paths.paths[0].blocks;
  const spans = root.findAll((node) => node.hasClass('tok'));
  assert.equal(spans.length, blocks.reduce((s, b) => s + b.token_count, 0));
  assert.equal(spans.map((s) => s.textContent).join(''), blocks.map((b) => b.text).join(''));
});

test('a token that shares a character keeps a span to hover', () => {
  // tr_tokens' reply splits an emoji across two tokens: the first owns no bytes.
  const root = el();
  renderPath(root, { data: payload.tr_tokens.paths, state: STATE, onState() {} });
  const spans = root.findAll((node) => node.hasClass('tok'));
  assert.deepEqual(spans.slice(-4).map((s) => s.textContent), ['<s>assistant\n', '', '🙂', 'ok']);
  const joined = root.findAll((node) => node.hasClass('joined'));
  assert.equal(joined.length, 1);
  assert.equal(joined[0].textContent, '');
  const sampled = payload.tr_tokens.paths.paths[0].blocks.find((b) => b.kind === 'sampled');
  const pieces = sampled.token_offsets.slice(0, -1).map((a, i) => sampled.text.slice(a, sampled.token_offsets[i + 1]));
  assert.deepEqual(pieces, ['', '🙂', 'ok'], 'offsets are UTF-16 units, so slice gives whole characters');
});

test('a node that recorded no text shows its ids, not a decode', () => {
  const root = el();
  renderPath(root, { data: payload.tr_notext.paths, state: STATE, onState() {} });
  assert.match(root.textContent, /⟨ids 1 2⟩/);
});

test('the logprob ribbon is off by default and on when asked', () => {
  const off = el();
  renderPath(off, { data: forked().paths, state: STATE, onState() {} });
  assert.equal(off.findAll((node) => node.tagName === 'CANVAS').length, 0);
  const on = el();
  renderPath(on, { data: forked().paths, state: { ...STATE, showLogprobs: true }, onState() {} });
  assert.ok(on.findAll((node) => node.tagName === 'CANVAS').length > 0);
});

// -- the strip ----------------------------------------------------------------
test('a thin scaffold still gets a segment', () => {
  const path = forked().paths.paths[3];
  const node = strip(path.blocks);
  assert.equal(node.children.length, path.blocks.length);
  const scaffold = path.blocks.findIndex((block) => block.kind === 'scaffold');
  assert.equal(path.blocks[scaffold].token_count, 3);
  assert.ok(node.children[scaffold].hasClass('scaffold'));
});

test('a path with nothing in it gets a strip that says so', () => {
  assert.ok(strip([]).hasClass('none'));
});

// -- diagnosis ---------------------------------------------------------------
test('the flags a skycap record can show', () => {
  const flags = (id) => summarise(payload[id].paths, payload[id].trajectory).flags;
  assert.deepEqual(flags('tr_21ffd62fd84bd796'), ['unbridged-inferred', 'replayed', 'forked', 'bridged-unknown']);
  assert.deepEqual(flags('tr_2759680d072b0773'), ['bridged-unknown']);
  assert.deepEqual(flags('tr_6b677d3638051778'), ['empty']);
  assert.deepEqual(flags('tr_forked_unbridged'), ['unbridged', 'replayed', 'forked']);
  // Written by record.write directly, never ended: the record says so.
  assert.deepEqual(flags('tr_tokens'), ['failed-calls', 'incomplete']);
  assert.ok(flags('tr_notext').includes('abandoned'));
  assert.ok(flags('tr_notext').includes('no-logprobs'), 'a sampled node recorded without logprobs');
  assert.ok(!flags('tr_text').includes('no-logprobs') && !flags('tr_text').includes('no-train'), 'text mode has no token flags');
});

test('the band counts each flag once per trajectory', () => {
  const rows = ['tr_21ffd62fd84bd796', 'tr_2759680d072b0773'].map((id) => ({ summary: summarise(payload[id].paths, payload[id].trajectory) }));
  const counts = Object.fromEntries(runHealth(rows).counts);
  assert.equal(counts['bridged-unknown'], 2);
  assert.equal(counts.forked, 1);
});

test('the server\'s row flags are the browser\'s flags', () => {
  const opened = payload.real.data.filter((row) => payload[row.id]);
  assert.ok(opened.length >= 3);
  for (const row of opened) {
    assert.deepEqual(row.summary.flags, summarise(payload[row.id].paths, payload[row.id].trajectory).flags, row.id);
  }
});

// -- text mode ---------------------------------------------------------------
test('a text-mode trajectory says what it cannot show, and shows the messages', () => {
  const root = el();
  renderPath(root, { data: payload.tr_text.paths, state: STATE, onState() {} });
  assert.match(root.textContent, /Text mode/);
  assert.equal(root.findAll((node) => node.hasClass('block')).length, 2);
  assert.equal(root.findAll((node) => node.hasClass('range')).length, 0, 'no ranges without tokens');
});

// -- the tree, where forks are read ------------------------------------------
test('the tree marks branch points, one row per node', () => {
  const { graph, paths } = forked();
  const root = el();
  renderTree(root, { graph, paths, state: STATE, onState() {} });
  assert.equal(root.findAll((node) => node.hasClass('node')).length, graph.nodes.length);
  assert.equal(root.findAll((node) => node.hasClass('node') && node.hasClass('fork')).length, graph.branch_points.length);
});

test('a linear chain stays on its rail instead of indenting every turn', () => {
  const { graph, paths } = payload.tr_2759680d072b0773;
  const root = el();
  renderTree(root, { graph, paths, state: STATE, onState() {} });
  const rails = root.findAll((node) => node.hasClass('rail')).map((node) => node.textContent);
  assert.deepEqual(new Set(rails), new Set(['']));
});

test('an opened fork lays its branches side by side and names where they part', () => {
  const { graph, paths } = forked();
  const [point] = graph.branch_points;
  const root = el();
  renderTree(root, { graph, paths, state: { ...STATE, openNode: point.node_id }, onState() {} });
  const panel = root.findAll((node) => node.hasClass('node-panel'));
  assert.equal(panel.length, 1);
  assert.match(panel[0].textContent, new RegExp(`branches into ${point.child_count}`));
  assert.match(panel[0].textContent, /they agree for \d+ characters, then part|differ from their first character/);
  assert.equal(panel[0].findAll((node) => node.hasClass('continuation')).length, point.child_count);
});

test('a continuation reads as one, and a leaf says so', () => {
  const { graph, paths } = forked();
  let root = el();
  renderTree(root, { graph, paths, state: { ...STATE, openNode: 'n1' }, onState() {} });
  assert.match(root.findAll((node) => node.hasClass('node-panel'))[0].textContent, /then/);
  root = el();
  renderTree(root, { graph, paths, state: { ...STATE, openNode: graph.leaf_node_ids[0] }, onState() {} });
  assert.match(root.findAll((node) => node.hasClass('node-panel'))[0].textContent, /Nothing follows/);
});

test('the tree says how a node\'s prompt was made', () => {
  let root = el();
  renderTree(root, { graph: forked().graph, paths: forked().paths, state: STATE, onState() {} });
  assert.match(root.textContent, /re-tokenized copy of n1/);
  assert.match(root.textContent, /unbridged \(inferred\)/);
  root = el();
  const { graph, paths } = payload.tr_forked_unbridged;
  renderTree(root, { graph, paths, state: { ...STATE, openNode: 'n4' }, onState() {} });
  // n4 and n7 in the tree, and n4 again in its opened panel.
  assert.equal(root.findAll((node) => node.hasClass('badge') && node.textContent === 'unbridged').length, 3);
  assert.match(root.textContent, /bridged false/);
});

test('train-once is checked, not assumed, and a violation is reported', () => {
  const { graph, paths } = forked();
  let root = el();
  renderTree(root, { graph, paths, state: STATE, onState() {} });
  assert.match(root.textContent, /Train-once holds/);
  const broken = structuredClone(paths);
  const victim = broken.paths[0].blocks.find((b) => b.kind === 'sampled');
  broken.paths[1].blocks.find((b) => b.kind === 'sampled').node_id = victim.node_id;
  root = el();
  renderTree(root, { graph, paths: broken, state: STATE, onState() {} });
  assert.match(root.textContent, /Train-once violated/);
});

// -- the Forks tab -------------------------------------------------------------
test('the Forks tab compares two paths from the last node they agree on', () => {
  const { graph, paths } = payload.tr_shared_reply;
  const root = el();
  renderForks(root, { paths, graph, state: STATE, onState() {} });
  assert.match(root.textContent, /They agree on 2 nodes \(\d+ tokens\), up to n1 \(assistant, model\)/);
  assert.match(root.textContent, /Train-once holds: each of the 3 model nodes is in the loss on exactly one of the 2 paths/);
  assert.equal(root.findAll((node) => node.hasClass('continuation')).length, 2);
  const one = el();
  renderForks(one, { paths: payload.tr_2759680d072b0773.paths, graph: payload.tr_2759680d072b0773.graph, state: STATE, onState() {} });
  assert.match(one.textContent, /never forked/);
  const roots = el();
  renderForks(roots, { paths: forked().paths, graph: forked().graph, state: { ...STATE, forkRight: 5 }, onState() {} });
  assert.match(roots.textContent, /They agree on 1 nodes .* up to n0/);
});

// -- calls, table, sidebar -------------------------------------------------------
test('the calls table flags unbridged calls, failures and truncation', () => {
  let root = el();
  renderCalls(root, { exchanges: payload.tr_forked_unbridged.exchanges });
  assert.equal((root.textContent.match(/unbridged: prompt re-rendered/g) || []).length, 2);
  root = el();
  renderCalls(root, { exchanges: payload.tr_tokens.exchanges });
  assert.match(root.textContent, /failed 500: boom/);
  root = el();
  const truncated = { data: payload.tr_2759680d072b0773.exchanges.data.map((row) => ({ ...row, completion_reason: 'length' })) };
  renderCalls(root, { exchanges: truncated });
  assert.match(root.textContent, /truncated/);
});

test('the table draws a row per trajectory with its strip, reward and flags', () => {
  const root = el();
  renderTable(root, { rows: payload.real.data, selected: null, onOpen() {} });
  assert.equal(root.findAll((node) => node.tagName === 'TR').length, payload.real.data.length + 1);
  assert.ok(root.findAll((node) => node.hasClass('strip')).length >= 3);
  assert.match(root.textContent, /code_contests-0000/);
  assert.doesNotMatch(root.textContent, /bridged-unknown/, 'a flag true of every row is left to the band');
});

test('the band says a clean run is clean, and flags are clickable chips', () => {
  let root = el();
  renderHealth(root, { health: { scanned: 3, total: 3, counts: [] }, active: null, onToggle() {} });
  assert.match(root.textContent, /nothing flagged/);
  root = el();
  renderHealth(root, { health: payload.real.health, active: 'forked', onToggle() {} });
  assert.ok(root.findAll((node) => node.hasClass('chip') && node.hasClass('on')).length === 1);
});

test('the sidebar groups runs under their project, and filters', () => {
  const root = el();
  renderSidebar(root, { runs: payload.runs, active: 'real', source: { kind: 'record', label: 'skycap records', api: FIXTURES }, filter: '', onFilter() {}, onPick() {}, onTheme() {} });
  assert.match(root.textContent, /fixtures/);
  assert.match(root.textContent, /real/);
  assert.match(root.textContent, /spec/);
  const none = el();
  renderSidebar(none, { runs: payload.runs, active: null, source: { kind: 'record', label: 'x', api: '' }, filter: 'nothing-matches', onFilter() {}, onPick() {}, onTheme() {} });
  assert.match(none.textContent, /no match/);
});
