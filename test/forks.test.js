// Why a history forked: each kind of fork a harness can cause, on documents a
// small text-mode harness builds the way skycap's graph does (one node per
// distinct message under a parent, matched by hash), and on the fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FORK_KINDS, forkKinds, forksOf } from '../src/forks.js';
import { readDocument, summarize } from '../src/record.js';
import { directoryStats } from '../src/stats.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REAL = here('./fixtures/real');
const SPEC = here('./fixtures/spec');

const SYS = { role: 'system', content: 'You are terse.' };
const user = (content) => ({ role: 'user', content });
const assistant = (content, extra = {}) => ({ role: 'assistant', content, ...extra });

/** Drives one text-mode trajectory a call at a time, as skycap's graph commits them. */
class Harness {
  constructor(mode = 'text') {
    this.doc = { format_version: 1, id: 'tr', status: 'finished', capture: { mode }, nodes: [], sidecars: {} };
  }

  hash(message, tools, model) {
    const kept = Object.fromEntries(Object.entries(message).filter(([, v]) => v != null));
    return JSON.stringify([kept, tools ?? null, model]);
  }

  add(parent, author, message, hash, call) {
    const node = { id: this.doc.nodes.length, parent, depth: parent == null ? 0 : this.doc.nodes[parent].depth + 1, author, role: message.role, message, match_hash: hash, delta_hash: hash, created_at: this.doc.nodes.length, calls: call ? [call] : [], tokens: null, shadowed_by: null };
    this.doc.nodes.push(node);
    return node;
  }

  children(parent) {
    return this.doc.nodes.filter((n) => n.parent === parent);
  }

  call(messages, reply, { tools = null, model = 'policy', ...sampling } = {}) {
    let parent = null;
    for (const message of messages) {
      const hash = this.hash(message, tools, model);
      parent = (this.children(parent).find((n) => n.match_hash === hash) ?? this.add(parent, 'client', message, hash)).id;
    }
    const hash = this.hash(reply, tools, model);
    const call = { t_start: 0, t_end: 1, model, sampling, bridged: null };
    const same = this.children(parent).find((n) => n.author === 'model' && n.match_hash === hash && JSON.stringify(n.calls[0].sampling) === JSON.stringify(sampling));
    if (same) same.calls.push(call);
    else this.add(parent, 'model', reply, hash, call);
    return this;
  }
}

const lines = (doc) => forksOf(doc).map((f) => `node ${f.node} (${f.parent == null ? 'new root' : `under node ${f.parent}`}, vs node ${f.sibling}): ${f.kind}: ${f.detail}`);

test('an append-only history, or one without calls, has no forks', () => {
  const h = new Harness().call([SYS, user('q1')], assistant('a1')).call([SYS, user('q1'), assistant('a1'), user('q2')], assistant('a2'));
  assert.deepEqual(forksOf(h.doc), []);
  assert.deepEqual(forksOf(new Harness().doc), []);
  assert.deepEqual(forkKinds([]), {});
});

test('stripped reasoning is an edited reply', () => {
  const h = new Harness().call([user('q')], assistant('answer', { reasoning_content: 'let me think' })).call([user('q'), assistant('answer'), user('more')], assistant('more answer'));
  assert.deepEqual(lines(h.doc), ["node 2 (under node 0, vs node 1): edited reply: the harness sent back the model's reply with reasoning_content dropped"]);
  assert.deepEqual(forkKinds(forksOf(h.doc)), { 'edited reply': 1 });
});

test('an edit is compared with the reply it came from, not the latest', () => {
  const h = new Harness()
    .call([user('q')], assistant('A', { reasoning_content: 'r1' }))
    .call([user('q')], assistant('B', { reasoning_content: 'r2' }))
    .call([user('q'), assistant('A'), user('more')], assistant('ok'));
  assert.deepEqual(lines(h.doc), [
    'node 2 (under node 0, vs node 1): resample: a second reply to the same history',
    "node 3 (under node 0, vs node 1): edited reply: the harness sent back the model's reply with reasoning_content dropped",
  ]);
});

test('resamples: the same reply under other sampling, a sample equal to a harness-written message, a reply to a shortened history', () => {
  const same = new Harness().call([user('q')], assistant('a'), { top_p: 1 }).call([user('q')], assistant('a'), { top_p: 0.5 });
  assert.deepEqual(lines(same.doc), ['node 2 (under node 0, vs node 1): resample: the same reply again, under other sampling parameters or tokenized differently']);
  const written = new Harness().call([user('q'), assistant('x'), user('again')], assistant('y')).call([user('q')], assistant('x'));
  assert.deepEqual(lines(written.doc), ['node 4 (under node 0, vs node 1): resample: the model sampled a message the harness had already written']);
  const shortened = new Harness().call([SYS, user('task')], assistant('a')).call([SYS], assistant('b'));
  assert.deepEqual(lines(shortened.doc), ['node 3 (under node 0, vs node 1): resample: a reply to a history the other path continues with a user message']);
});

test('a compaction is a different message; a subagent with its own system prompt is a new root', () => {
  const compacted = new Harness()
    .call([SYS, user('task')], assistant('step1'))
    .call([SYS, user('task'), assistant('step1'), user('summarize')], assistant('summary'))
    .call([SYS, user('summary'), user('continue')], assistant('step2'));
  assert.deepEqual(lines(compacted.doc), ['node 5 (under node 0, vs node 1): different message: a different user message: content changed']);
  const subagent = new Harness().call([SYS, user('task')], assistant('delegating')).call([{ role: 'system', content: 'You are a searcher.' }, user('find x')], assistant('found'));
  assert.deepEqual(lines(subagent.doc), ['node 3 (new root, vs node 0): different message: a different system message: content changed']);
});

test('a changed tool set repeats the root it is compared with; a message of another role names both', () => {
  const search = [{ type: 'function', function: { name: 'search', parameters: {} } }];
  const tools = new Harness()
    .call([SYS, user('task')], assistant('plan'))
    .call([{ role: 'system', content: 'You are a searcher.' }, user('find x')], assistant('found'))
    .call([SYS, user('task'), assistant('plan'), user('go')], assistant('done'), { tools: search });
  assert.equal(lines(tools.doc)[1], 'node 6 (new root, vs node 0): tools or model: the same message, sent with a different tool set or model');
  const prefill = new Harness().call([SYS, user('task')], assistant('plan')).call([SYS, { role: 'assistant', content: 'prefill' }], assistant('x'));
  assert.deepEqual(lines(prefill.doc), ['node 3 (under node 0, vs node 1): different message: an assistant message where the other path has a user message']);
});

test('token mode: a re-rendered copy has its sibling\'s match hash, and only rendered fields are named', () => {
  const h = new Harness('tokens').call([user('q')], assistant('answer', { reasoning_content: 'hmm' }));
  // The harness replayed the reply; its re-render matched by hash but not by tokens, so it got a client copy.
  const copy = h.add(0, 'client', assistant('answer', { reasoning_content: 'hmm' }), h.doc.nodes[1].match_hash);
  copy.shadowed_by = 1;
  assert.deepEqual(lines(h.doc), ['node 2 (under node 0, vs node 1): re-rendered: the same message, rendered to different tokens']);
  const edited = new Harness('tokens').call([user('q')], assistant('answer', { reasoning_content: 'hmm' }));
  edited.add(0, 'client', assistant('answer', { provider_specific_fields: { x: 1 } }), 'other');
  assert.deepEqual(lines(edited.doc), ["node 2 (under node 0, vs node 1): edited reply: the harness sent back the model's reply with reasoning_content dropped"]);
});

test('the fixtures: Qwen3 re-renders, stripped reasoning, and two follow-ups to one reply', () => {
  const doc = readDocument(REAL, 'tr_21ffd62fd84bd796');
  const real = forksOf(doc);
  assert.equal(real.length, 20);
  assert.ok(real.every((f) => f.kind === 're-rendered' && doc.nodes[f.node].shadowed_by === f.sibling), 'each copy is compared with the model reply it shadows');
  assert.deepEqual(forkKinds(real), { 're-rendered': 20 });
  assert.deepEqual(forkKinds(forksOf(readDocument(REAL, 'tr_128394da4e0d77d9'))), { 're-rendered': 2 });
  const unbridged = forksOf(readDocument(SPEC, 'tr_forked_unbridged'));
  assert.deepEqual(unbridged.map((f) => [f.parent, f.node, f.sibling, f.kind]), [[0, 2, 1, 'edited reply'], [3, 5, 4, 'edited reply']]);
  assert.match(unbridged[0].detail, /reasoning_content dropped/);
  assert.deepEqual(forksOf(readDocument(SPEC, 'tr_shared_reply')), [{ parent: 1, node: 4, sibling: 2, kind: 'different message', detail: 'a different user message: content changed' }]);
  for (const id of ['tr_text', 'tr_tokens', 'tr_empty', 'tr_notext']) assert.deepEqual(forksOf(readDocument(SPEC, id)), [], id);
  assert.ok(FORK_KINDS.includes('re-rendered'));
});

test('directory stats count fork causes from rows that carry their forks', () => {
  const rows = ['tr_forked_unbridged', 'tr_shared_reply', 'tr_text'].map((id) => {
    const doc = readDocument(SPEC, id);
    return { ...summarize(doc), forks: forksOf(doc) };
  });
  const stats = directoryStats(rows);
  assert.equal(stats.forked, 2);
  assert.deepEqual(stats.fork_kinds, { 'edited reply': 2, 'different message': 1 });
  assert.deepEqual(directoryStats(rows.map(({ forks, ...row }) => row)).fork_kinds, {}, 'rows without forks count none');
});
