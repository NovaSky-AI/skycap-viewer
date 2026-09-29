// The read API over the fixture directories. `test/fixtures` is a parent of
// two record directories, so it is also the discovery test: `real` and `spec`
// are its runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../src/server.js';
import { discover, runName } from '../src/runs.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const expected = JSON.parse(readFileSync(`${FIXTURES}/expected.json`, 'utf8'));
let base;
let server;
before(async () => {
  ({ server } = createViewer([FIXTURES]));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = async (path, status = 200) => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, status, path);
  return res.json();
};

test('a parent directory is discovered as its record directories', () => {
  assert.deepEqual(discover(FIXTURES).map(runName), ['real', 'spec']);
  assert.deepEqual(discover(`${FIXTURES}/real`).map(runName), ['real']);
  assert.equal(runName('/tmp/harbor/runs/harbor-skycap-7e4d9eb99a09/skycap'), 'harbor-skycap-7e4d9eb99a09');
});

test('the page and its modules are served as they sit', async () => {
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<script type="module" src="\/app.mjs">/);
  const module = await fetch(`${base}/components/path.mjs`);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(`${base}/..%2f..%2fsrc/server.js`)).status, 404);
  assert.match(await (await fetch(`${base}/run/deep/link`)).text(), /skycap viewer/, 'deep links fall back to the shell');
});

test('health, and every /v1 route also under /api/v1', async () => {
  assert.equal((await json('/healthz')).source, 'record');
  assert.deepEqual(await json('/v1/runs'), await json('/api/v1/runs'));
});

test('runs carry counts, steps, tasks, statuses and annotation values', async () => {
  const { data } = await json('/v1/runs');
  const real = data.find((r) => r.id === 'real');
  await json('/v1/trajectories?run_id=real');
  const indexed = (await json('/v1/runs')).data.find((r) => r.id === 'real');
  assert.equal(real.trajectory_count, 4);
  assert.equal(indexed.indexing, false);
  assert.equal(indexed.project, 'fixtures');
  assert.deepEqual(indexed.statuses, { finished: 4 });
  assert.ok(indexed.steps.length >= 1);
  assert.ok(indexed.tasks.some((t) => t.id === 'code_contests-0000'));
  assert.ok('reward' in indexed.annotations);
});

test('the list is flat and filtered on the server, with health over the filtered run', async () => {
  const all = await json('/v1/trajectories?run_id=real');
  assert.equal(all.total, 4);
  const counts = Object.fromEntries(all.health.counts);
  assert.equal(counts.forked, 2);
  assert.equal(counts.empty, 1);
  assert.equal(counts['bridged-unknown'], 3, 'the empty record has no calls to be unknown about');
  const forked = await json('/v1/trajectories?run_id=real&flag=forked');
  assert.deepEqual(forked.data.map((r) => r.summary.paths).sort(), [21, 3]);
  assert.equal(forked.health.scanned, 4, 'the band is counted before the flag filter');
  const page = await json('/v1/trajectories?run_id=real&limit=3');
  assert.equal(page.data.length, 3);
  assert.equal(page.next_cursor, '3');
  assert.equal((await json('/v1/trajectories?run_id=real&limit=3&cursor=3')).data.length, 1);
  const byAnnotation = await json('/v1/trajectories?run_id=real&annotation=stop_reason=error');
  assert.deepEqual(byAnnotation.data.map((r) => r.id), ['tr_6b677d3638051778']);
  const one = all.data.find((r) => r.id === 'tr_21ffd62fd84bd796');
  assert.equal((await json(`/v1/trajectories?run_id=real&step=${one.step}&task_id=${one.task_id}`)).data.some((r) => r.id === one.id), true);
  const unbridged = await json('/v1/trajectories?run_id=spec&flag=unbridged');
  assert.deepEqual(unbridged.data.map((r) => r.id), ['tr_forked_unbridged']);
});

test('a row carries its flags and its first path as a strip, from the document alone', async () => {
  const { data } = await json('/v1/trajectories?run_id=real');
  const row = data.find((r) => r.id === 'tr_21ffd62fd84bd796');
  assert.deepEqual(row.summary.flags, ['unbridged-inferred', 'replayed', 'forked', 'bridged-unknown']);
  assert.equal(row.summary.strip.reduce((s, b) => s + b.token_count, 0), expected.tr_21ffd62fd84bd796.paths[0].tokens);
  assert.equal(row.task_id, 'code_contests-0000');
  assert.equal(typeof row.step, 'number');
});

test('paths: blocks tile each path, and the counts are what skycap\'s Python reader says', async () => {
  for (const [run, ids] of [['real', ['tr_21ffd62fd84bd796', 'tr_128394da4e0d77d9', 'tr_2759680d072b0773']], ['spec', ['tr_forked_unbridged', 'tr_tokens', 'tr_shared_reply', 'tr_notext']]]) {
    for (const id of ids) {
      const data = await json(`/v1/trajectories/${id}/paths?run_id=${run}`);
      assert.equal(data.paths.length, expected[id].paths.length, id);
      data.paths.forEach((path, i) => {
        const want = expected[id].paths[i];
        assert.equal(path.token_count, want.tokens, `${id} path ${i} tokens`);
        assert.equal(path.trainable_count, want.trained_tokens, `${id} path ${i} trainable`);
        assert.deepEqual(path.node_ids, want.path.map((n) => `n${n}`));
        let cursor = 0;
        for (const block of path.blocks) {
          assert.equal(block.start, cursor, `${id} path ${i} blocks are contiguous`);
          assert.equal(block.end - block.start, block.token_count);
          cursor = block.end;
          if (block.text != null) {
            assert.equal(block.token_offsets.length, block.token_count + 1);
            assert.equal(block.token_offsets.at(-1), block.text.length, 'offsets are UTF-16 units into the text');
          }
        }
        assert.equal(cursor, path.token_count);
        assert.equal(path.logprobs.length, path.token_count);
      });
    }
  }
});

test('text=false decodes nothing and still has the shape', async () => {
  const full = await json('/v1/trajectories/tr_21ffd62fd84bd796/paths');
  const bare = await json('/v1/trajectories/tr_21ffd62fd84bd796/paths?text=false');
  assert.equal(bare.paths[3].blocks.length, full.paths[3].blocks.length);
  assert.equal(bare.paths[3].blocks[0].text, undefined);
  assert.equal(bare.paths[3].logprobs, undefined);
  assert.equal(bare.paths[3].logprob_count, full.paths[3].logprob_count);
});

test('a model node trained on an earlier path is sampled-elsewhere, never sampled twice', async () => {
  const { paths } = await json('/v1/trajectories/tr_shared_reply/paths');
  const second = paths[1].blocks.filter((b) => b.node_id === 'n1');
  assert.deepEqual(second.map((b) => b.kind), ['scaffold', 'sampled-elsewhere']);
  assert.equal(second[1].trained_in, 0);
  assert.equal(second[1].trainable, false);
  assert.deepEqual(paths[0].blocks.filter((b) => b.node_id === 'n1').map((b) => b.kind), ['scaffold', 'sampled']);
});

test('a client-authored assistant turn is replayed', async () => {
  const { paths } = await json('/v1/trajectories/tr_forked_unbridged/paths');
  assert.deepEqual(paths[1].blocks.filter((b) => b.node_id === 'n2').map((b) => b.kind), ['replayed']);
});

test('graph and exchanges', async () => {
  const graph = await json('/v1/trajectories/tr_21ffd62fd84bd796/graph');
  assert.equal(graph.nodes.length, 106);
  assert.equal(graph.leaf_node_ids.length, 21);
  assert.equal(graph.branch_points.length, 20);
  assert.ok(graph.nodes.find((n) => n.node_id === 'n24').signs.retokenized);
  assert.equal(graph.nodes.find((n) => n.node_id === 'n24').shadowed_by, 'n1');
  const calls = await json('/v1/trajectories/tr_forked_unbridged/exchanges?run_id=spec');
  assert.deepEqual(calls.data.map((c) => c.bridged), [null, false, false]);
  const failed = await json('/v1/trajectories/tr_tokens/exchanges');
  assert.deepEqual(failed.data.map((c) => c.kind), ['failure', 'call']);
});

test('errors are JSON with a detail', async () => {
  assert.match((await json('/v1/trajectories/tr_nope', 404)).detail, /unknown trajectory/);
  await json('/v1/trajectories/..%2Fetc', 400);
  await json('/v1/trajectories?run_id=nope', 404);
  await json('/v1/nothing', 404);
  assert.equal((await fetch(`${base}/v1/runs`, { method: 'POST' })).status, 405);
});
