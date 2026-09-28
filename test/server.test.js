// The HTTP API over the fixture directories.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../src/server.js';

const servers = [];
const start = async (dir) => {
  const { server } = createViewer(fileURLToPath(new URL(dir, import.meta.url)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};
let real;
let spec;
before(async () => {
  real = await start('./fixtures/real');
  spec = await start('./fixtures/spec');
});
after(() => servers.forEach((s) => s.close()));

const json = async (url, status = 200) => {
  const res = await fetch(url);
  assert.equal(res.status, status, url);
  return res.json();
};

test('the page is served', async () => {
  const res = await fetch(`${real}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<title>skycap viewer<\/title>/);
});

test('list and stats', async () => {
  const list = await json(`${real}/api/trajectories`);
  assert.equal(list.data.length, 4);
  assert.equal(list.data.find((t) => t.id === 'tr_21ffd62fd84bd796').paths, 21);
  const { stats } = await json(`${spec}/api/stats`);
  assert.equal(stats.with_unbridged, 1);
  assert.equal(stats.bridged.false, 2);
});

test('one trajectory: document, paths, branch points, sidecar shapes', async () => {
  const d = await json(`${spec}/api/trajectories/tr_forked_unbridged`);
  assert.equal(d.document.id, 'tr_forked_unbridged');
  assert.equal(d.paths.length, 3);
  assert.deepEqual(d.branch_points, [0, 3]);
  assert.deepEqual(d.sidecar_shapes.experts.routed_experts, { dtype: 'uint8', shape: [156, 2, 2] });
});

test('tokens for a path', async () => {
  const t = await json(`${real}/api/trajectories/tr_21ffd62fd84bd796/tokens?path=3`);
  assert.equal(t.paths, 21);
  assert.equal(t.path.leaf, 54);
  assert.deepEqual(t.path.counts, { trained: 777, sampled: 0, scaffold: 3, prompt: 6755 });
  const node = t.path.nodes.find((n) => n.target);
  assert.equal(node.pieces.join(''), node.text);
  assert.equal(node.kinds.length, node.token_ids.length);
});

test('text mode and empty trajectories have no token path', async () => {
  assert.equal((await json(`${spec}/api/trajectories/tr_text/tokens`)).path, null);
  assert.equal((await json(`${spec}/api/trajectories/tr_empty/tokens`)).path, null);
});

test('errors: unknown trajectory, unknown path, bad id, writes', async () => {
  await json(`${real}/api/trajectories/tr_nope`, 404);
  await json(`${real}/api/trajectories/tr_21ffd62fd84bd796/tokens?path=21`, 404);
  await json(`${real}/api/trajectories/tr_21ffd62fd84bd796/tokens?path=-1`, 400);
  await json(`${real}/api/trajectories/..%2F..%2Fetc`, 400);
  assert.equal((await fetch(`${real}/api/trajectories`, { method: 'POST' })).status, 405);
});
