// GRPO groups over test/fixtures/groups (written by test/gen_groups.py with
// skycap's Python writer): a retry, a no-signal group, a short group, a masked
// group and one with non-binary rewards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../src/server.js';
import { groupKeyOf, groupRows, summariseGroup } from '../src/groups.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
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
const byKey = (data) => Object.fromEntries(data.map((g) => [g.key, g]));

test('the key is step + instance_id by default, from meta or annotations', () => {
  assert.equal(groupKeyOf({ meta: { step: 3, instance_id: 'x' } }, ['step', 'instance_id']), '3~x');
  assert.equal(groupKeyOf({ meta: { step: 3 } }, ['step', 'instance_id']), null);
  assert.equal(groupKeyOf({ meta: {}, annotations: { stop_reason: 'error' } }, ['stop_reason']), 'error');
});

test('the run says it has groups, how many, and their usual size', async () => {
  await json('/v1/groups?run_id=groups');
  const run = (await json('/v1/runs')).data.find((r) => r.id === 'groups');
  assert.equal(run.groupable, true);
  assert.equal(run.group_count, 5);
  assert.equal(run.modal_group_size, 4);
  assert.deepEqual(run.group_by, ['step', 'instance_id']);
});

test('groups: N counts repetitions, rewards in repetition order, pass only when binary', async () => {
  const { data, total, modal_n } = await json('/v1/groups?run_id=groups');
  assert.equal(total, 5);
  assert.equal(modal_n, 4);
  const g = byKey(data);
  assert.deepEqual(data.map((x) => x.key), ['2~a', '2~b', '2~c', '1~a', '1~b'], 'newest step first, then task');
  assert.equal(g['1~a'].n, 4, 'a retried repetition is one rollout');
  assert.deepEqual(g['1~a'].rewards.map((r) => r.reward), [1, 0, 1, 1]);
  assert.deepEqual(g['1~a'].rewards.map((r) => r.repetition_id), [0, 1, 2, 3]);
  assert.equal(g['1~a'].rewards[2].attempt, 1, 'the highest attempt counts');
  assert.equal(g['1~a'].pass, 3);
  assert.equal(g['2~c'].binary, false);
  assert.equal(g['2~c'].pass, null);
  assert.equal(g['1~a'].task_id, 'task-a');
  assert.deepEqual(g['1~a'].turns, [1, 1]);
  for (const group of data) {
    assert.equal('mean' in group || 'advantage' in group, false, 'no training metrics');
  }
});

test('group flags: no-signal, masked, short, retried', async () => {
  const g = byKey((await json('/v1/groups?run_id=groups')).data);
  assert.deepEqual(g['1~a'].flags, ['retried']);
  assert.deepEqual(g['1~b'].flags, ['no-signal']);
  assert.deepEqual(g['2~a'].flags, ['short']);
  assert.deepEqual(g['2~b'].flags, ['masked']);
  assert.deepEqual(g['2~c'].flags, []);
  const { health } = await json('/v1/groups?run_id=groups');
  const counts = Object.fromEntries(health.counts);
  assert.equal(health.unit, 'groups');
  for (const flag of ['no-signal', 'masked', 'short', 'retried']) assert.equal(counts[flag], 1, flag);
});

test('a superseded error does not mask its group; the attempt that counts decides', () => {
  const rows = [
    { id: 'a0', meta: { step: 1, instance_id: 'x', repetition_id: 0, attempt: 0 }, annotations: { reward: 0, stop_reason: 'error' } },
    { id: 'a1', meta: { step: 1, instance_id: 'x', repetition_id: 0, attempt: 1 }, annotations: { reward: 1, stop_reason: 'complete' } },
    { id: 'b0', meta: { step: 1, instance_id: 'x', repetition_id: 1, attempt: 0 }, annotations: { reward: 0, stop_reason: 'complete' } },
  ];
  const { groups, modal } = groupRows(rows, ['step', 'instance_id']);
  const s = summariseGroup(groups[0], modal);
  assert.deepEqual(s.flags, ['retried']);
  assert.deepEqual(s.rewards.map((r) => r.id), ['a1', 'b0']);
});

test('filters apply to groups: a group matches if any rollout does', async () => {
  const timeout = await json('/v1/groups?run_id=groups&annotation=stop_reason=agent_timeout');
  assert.deepEqual(timeout.data.map((g) => [g.key, g.matching]), [['2~b', 1]]);
  const step1 = await json('/v1/groups?run_id=groups&step=1');
  assert.deepEqual(step1.data.map((g) => g.key).sort(), ['1~a', '1~b']);
  const noSignal = await json('/v1/groups?run_id=groups&flag=no-signal');
  assert.deepEqual(noSignal.data.map((g) => g.key), ['1~b']);
  assert.equal(noSignal.health.total, 5, 'the band counts before the flag filter');
  const task = await json('/v1/groups?run_id=groups&task_id=task-c');
  assert.deepEqual(task.data.map((g) => g.key), ['2~c']);
});

test('an opened group ranks its rollouts by reward and greys the superseded attempt', async () => {
  const { group, rollouts } = await json('/v1/groups/1~a?run_id=groups');
  assert.equal(group.n, 4);
  assert.deepEqual(rollouts.map((r) => r.annotations.reward), [1, 1, 1, 0]);
  const retried = rollouts.find((r) => r.repetition_id === 2);
  assert.equal(retried.meta.attempt, 1);
  assert.equal(retried.superseded.length, 1);
  assert.equal(retried.superseded[0].meta.attempt, 0);
  assert.equal(retried.superseded[0].superseded_by, retried.id);
  assert.equal(rollouts[0].match, null, 'without a filter nothing is emphasised');
});

test('an opened group emphasises the rollouts the filters match', async () => {
  const { rollouts } = await json('/v1/groups/2~b?run_id=groups&annotation=stop_reason=agent_timeout');
  assert.deepEqual(rollouts.filter((r) => r.match).map((r) => r.annotations.stop_reason), ['agent_timeout']);
  assert.equal(rollouts.filter((r) => r.match === false).length, 3);
  await json('/v1/groups/9~z?run_id=groups', 404);
});

test('group_by overrides the key, with meta or annotation keys', async () => {
  const byInstance = await json('/v1/groups?run_id=groups&group_by=instance_id');
  assert.deepEqual(byInstance.data.map((g) => g.key).sort(), ['a', 'b', 'c']);
  const byStop = await json('/v1/groups?run_id=groups&group_by=stop_reason');
  assert.ok(byStop.data.some((g) => g.key === 'agent_timeout'));
  const { server: other } = createViewer([`${FIXTURES}/groups`], { groupBy: ['instance_id'] });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const res = await fetch(`http://127.0.0.1:${other.address().port}/v1/groups`);
  assert.equal((await res.json()).total, 3);
  other.close();
});

test('the rollout list is unchanged by grouping', async () => {
  const all = await json('/v1/trajectories?run_id=groups');
  assert.equal(all.total, 20, 'every attempt, superseded ones included');
});

test('groups sort server-side by a column; reward orders by the mean without sending it', async () => {
  const keys = async (q) => (await json(`/v1/groups?run_id=groups${q}`)).data.map((g) => g.key);
  // Means: 1~b 1, 1~a .75, 2~c .525, 2~a .333, 2~b .25.
  assert.deepEqual(await keys('&sort=reward&order=desc'), ['1~b', '1~a', '2~c', '2~a', '2~b']);
  assert.deepEqual(await keys('&sort=reward&order=asc'), ['2~b', '2~a', '2~c', '1~a', '1~b']);
  assert.deepEqual(await keys('&sort=task&order=asc'), ['2~a', '1~a', '2~b', '1~b', '2~c'], 'ties break newest step first');
  assert.deepEqual((await keys('&sort=step&order=asc')).slice(0, 2).sort(), ['1~a', '1~b']);
  assert.equal((await keys('&sort=health&order=desc')).length, 5);
  const listing = await json('/v1/groups?run_id=groups&sort=reward');
  assert.deepEqual(listing.sort, { key: 'reward', order: 'desc' });
  assert.equal(JSON.stringify(listing.data).includes('"mean'), false, 'no mean on the wire');
  await json('/v1/groups?run_id=groups&sort=advantage', 400);
});

test('an expanded group sorts its rollouts by the same column', async () => {
  const rewards = async (q) => (await json(`/v1/groups/1~a?run_id=groups${q}`)).rollouts.map((r) => r.annotations.reward);
  assert.deepEqual(await rewards(''), [1, 1, 1, 0], 'by reward, highest first, by default');
  assert.deepEqual(await rewards('&sort=reward&order=asc'), [0, 1, 1, 1]);
  const reps = (await json('/v1/groups/1~a?run_id=groups&sort=step&order=asc')).rollouts.map((r) => r.repetition_id);
  assert.deepEqual(reps, [0, 1, 2, 3], 'a tie on the column falls back to repetition order');
});

test('rollouts sort server-side too, and every listing carries the run-wide reward range', async () => {
  const list = await json('/v1/trajectories?run_id=groups&sort=reward&order=asc&limit=3');
  assert.deepEqual(list.data.map((r) => r.annotations.reward), [0, 0, 0]);
  assert.deepEqual(list.reward_range, { min: 0, max: 1 }, 'over every listed rollout, not the page');
  const desc = await json('/v1/trajectories?run_id=groups&sort=reward&order=desc&limit=1');
  assert.equal(desc.data[0].annotations.reward, 1);
  const turns = await json('/v1/trajectories?run_id=real&sort=turns&order=desc&limit=1');
  assert.equal(turns.data[0].id, 'tr_21ffd62fd84bd796');
  assert.deepEqual((await json('/v1/trajectories?run_id=groups&task_id=task-c')).reward_range, { min: 0.2, max: 0.9 });
  assert.deepEqual((await json('/v1/groups?run_id=groups')).reward_range, { min: 0, max: 1 });
  await json('/v1/trajectories?run_id=groups&sort=nope', 400);
});
