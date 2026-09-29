/** Boot the whole viewer, through the dom-shim, against this viewer's own
 * server over the fixture records, and drive it the way a person does: land
 * on a run, filter it, open a trajectory by its link. Ported from
 * inference-capture's app test; `fetch` goes to a real server here instead of
 * a table of canned responses.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { install } from './dom-shim.mjs';
import { createViewer } from '../src/server.js';
import { rowsSignature, runsSignature, trajectorySignature } from '../public/lib/changed.mjs';

const shim = install();
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const { server } = createViewer([FIXTURES]);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const asked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  asked.push(String(url));
  return realFetch(new URL(url, base), options);
};
globalThis.location = { hash: '' };
globalThis.history = { replaceState(_state, _title, hash) { globalThis.location.hash = hash; } };
globalThis.setInterval = () => 0;
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

const { state } = await import('../public/app.mjs');
before(() => settle(600));

test('it says it is reading skycap records, and from where', () => {
  assert.ok(asked.includes('/__viewer') && asked.includes('/api/healthz'));
  const sidebar = shim.byId('sidebar');
  assert.match(sidebar.textContent, /skycap records/);
  assert.match(sidebar.textContent, /fixtures/);
});

test('with no route it opens the newest run rather than an empty page', () => {
  assert.match(globalThis.location.hash, /^#\/run\/(real|spec)$/);
  assert.match(shim.byId('main').textContent, new RegExp(state.runId));
});

test('the run page is a flat list with a health band and filters, not a grid', () => {
  const main = shim.byId('main');
  assert.ok(main.findAll((node) => node.tagName === 'TR').length > 1);
  assert.ok(main.findAll((node) => node.hasClass('health')).length === 1);
  const selects = main.findAll((node) => node.tagName === 'SELECT').map((node) => node.getAttribute('aria-label'));
  for (const label of ['task', 'status', 'annotation']) assert.ok(selects.includes(label), label);
  assert.match(main.findAll((node) => node.hasClass('pager'))[0].textContent, /1-\d+ of \d+/);
});

test('rows arrive with their strips and flags; no per-row scan', () => {
  assert.ok(shim.byId('main').findAll((node) => node.hasClass('strip')).length > 0);
  assert.equal(asked.filter((url) => url.includes('/paths')).length, 0);
});

test('it never asks for a URL outside the documented API', () => {
  for (const url of asked) assert.ok(url.startsWith('/api/v1/') || url === '/api/healthz' || url === '/__viewer', url);
  assert.ok(asked.filter((url) => url.startsWith('/api/v1/trajectories?')).every((url) => url.includes('limit=')));
});

test('a deep link to a trajectory in another run opens the drawer on it', async () => {
  globalThis.location.hash = '#/run/real/tr_21ffd62fd84bd796';
  // The shim's window swallows hashchange listeners; drive the drawer the way the route does.
  const { Drawer } = await import('../public/components/drawer.mjs');
  const drawer = new Drawer(shim.byId('drawer'), shim.byId('scrim'));
  drawer.runId = 'real';
  await drawer.open('tr_21ffd62fd84bd796');
  await settle();
  const root = shim.byId('drawer');
  assert.ok(root.hasClass('open'));
  assert.match(root.textContent, /tr_21ffd62fd84bd796/);
  assert.match(root.textContent, /replayed/);
  assert.match(root.textContent, /Forks/);
  assert.ok(asked.some((url) => url.startsWith('/api/v1/trajectories/tr_21ffd62fd84bd796/paths') && url.includes('run_id=real')));
  drawer.setState({ tab: 'forks' });
  assert.match(root.textContent, /Train-once holds/);
  drawer.setState({ tab: 'calls' });
  assert.match(root.textContent, /bridged unknown/);
});

test('an unchanged poll is recognised, and a change is noticed', () => {
  const runs = [{ id: 'r', project: 'p', trajectory_count: 8 }];
  assert.equal(runsSignature(runs), runsSignature(structuredClone(runs)));
  assert.notEqual(runsSignature(runs), runsSignature([{ ...runs[0], trajectory_count: 9 }]));
  const view = { indexing: false, total: 1, health: { counts: [['forked', 1]] } };
  const rows = [{ id: 'tr_a', status: 'finished', revision: 1, summary: {} }];
  assert.equal(rowsSignature(rows, view), rowsSignature(structuredClone(rows), structuredClone(view)));
  assert.notEqual(rowsSignature(rows, view), rowsSignature([{ ...rows[0], revision: 2 }], view), 'the record was rewritten');
  assert.notEqual(rowsSignature(rows, view), rowsSignature(rows, { ...view, health: { counts: [] } }), 'the band changed');
  const bundle = { trajectory: { status: 'finished', revision: 1, capture: { exchange_count: 4, node_count: 10 } }, paths: { paths: [{}] }, exchanges: { data: [] } };
  assert.equal(trajectorySignature(bundle), trajectorySignature(structuredClone(bundle)));
});
