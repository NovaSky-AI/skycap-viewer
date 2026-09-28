// The record parser against real records, records the Python writer produced
// for the spec's edge cases, and synthetic buffers. `expected.json` is what
// skycap's own Python reader (record.load + samples.build_samples) says about
// every fixture; test/expect.py regenerates it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  RecordError, bridgedState, zstdFrames, check, decompress, graphOf, listIds, nodeExperts, nodeSamplingMask, nodeTokens,
  parseDocument, pathTokenCounts, pathTokens, readDocument, readSidecar, summarize, viewSidecar,
} from '../src/record.js';
import { directoryStats } from '../src/stats.js';
import { RecordDirectory } from '../src/directory.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REAL = here('./fixtures/real');
const SPEC = here('./fixtures/spec');
const expected = JSON.parse(readFileSync(here('./fixtures/expected.json'), 'utf8'));
const fixtures = [...listIds(REAL).map((id) => [REAL, id]), ...listIds(SPEC).map((id) => [SPEC, id])];

test('every fixture has a Python expectation', () => {
  assert.deepEqual(fixtures.map(([, id]) => id).sort(), Object.keys(expected).sort());
});

for (const [dir, id] of fixtures) {
  test(`${id}: graph, paths and token counts match skycap's Python reader`, () => {
    const doc = readDocument(dir, id);
    const want = expected[id];
    const g = graphOf(doc);
    assert.equal(doc.nodes.length, want.nodes);
    assert.deepEqual(g.branchPoints, want.branch_points);
    assert.deepEqual(g.paths.map(({ leaf, path, targets }) => ({ leaf, path, targets })),
      want.paths.map(({ leaf, path, targets }) => ({ leaf, path, targets })));
    for (const [i, p] of g.paths.entries()) {
      const counts = pathTokenCounts(doc, p.path, p.targets);
      assert.deepEqual(counts && [counts.tokens, counts.trained], want.paths[i].tokens == null ? null : [want.paths[i].tokens, want.paths[i].trained_tokens]);
    }
    const s = summarize(doc);
    assert.equal(s.calls, want.calls);
    assert.equal(s.bridged.false, want.unbridged);
    assert.deepEqual(doc.nodes.flatMap((n) => n.calls.map((c) => (bridgedState(c) === 'absent' ? null : c.bridged))), want.bridged);
  });

  test(`${id}: every node's text and token pieces decode as Python decodes them`, () => {
    const doc = readDocument(dir, id);
    const tokens = readSidecar(dir, doc, 'tokens');
    for (const node of doc.nodes) {
      const t = nodeTokens(doc, tokens, node.id);
      if (!t) continue;
      assert.equal(t.token_ids.length, node.tokens.length);
      assert.equal(t.text, expected[id].node_text[String(node.id)] ?? null);
      if (t.pieces) assert.equal(t.pieces.join(''), t.text);
    }
  });
}

test('the real forked record: 21 paths, each model node trained exactly once', () => {
  const doc = readDocument(REAL, 'tr_21ffd62fd84bd796');
  const g = graphOf(doc);
  assert.equal(g.paths.length, 21);
  const trained = g.paths.flatMap((p) => p.targets).sort((a, b) => a - b);
  assert.deepEqual(trained, doc.nodes.filter((n) => n.author === 'model').map((n) => n.id));
  // Every path after the first forks from a branch point, at a node no earlier path has.
  for (const p of g.paths.slice(1)) {
    assert.ok(g.branchPoints.includes(p.fork_from), `path to ${p.leaf} forks from ${p.fork_from}`);
    assert.equal(doc.nodes[p.diverges_at].parent, p.fork_from);
  }
  assert.equal(g.paths[0].diverges_at, null);
});

test('records written before `bridged` existed read as absent, not null', () => {
  const s = summarize(readDocument(REAL, 'tr_2759680d072b0773'));
  assert.equal(s.bridged.absent, s.calls);
  assert.equal(s.bridged.null, 0);
});

test('the Python-written fork with re-rendered calls: bridged false is flagged per node', () => {
  const doc = readDocument(SPEC, 'tr_forked_unbridged');
  const s = summarize(doc);
  assert.deepEqual(s.bridged, { true: 0, false: 2, null: 1, absent: 0 });
  assert.deepEqual(s.unbridged_nodes, [4, 7]);
  assert.equal(s.paths, 3);
  assert.deepEqual(s.sidecars.sort(), ['experts', 'sampling_mask', 'tokens']);
});

test('path tokens: kinds follow sampled_start and which path trains the node', () => {
  const doc = readDocument(SPEC, 'tr_forked_unbridged');
  const tokens = readSidecar(SPEC, doc, 'tokens');
  const g = graphOf(doc);
  const first = pathTokens(doc, tokens, g, 0);
  const model = first.nodes.find((n) => n.author === 'model');
  assert.equal(model.kinds.slice(0, model.sampled_start).every((k) => k === 'scaffold'), true);
  assert.equal(model.kinds.slice(model.sampled_start).every((k) => k === 'trained'), true);
  assert.equal(first.nodes[0].kinds.every((k) => k === 'prompt'), true);
  const want = expected.tr_forked_unbridged.paths;
  g.paths.forEach((p, i) => {
    const pt = pathTokens(doc, tokens, g, i);
    assert.equal(pt.counts.trained, want[i].trained_tokens);
    assert.equal(Object.values(pt.counts).reduce((a, b) => a + b, 0), want[i].tokens);
  });
  assert.throws(() => pathTokens(doc, tokens, g, 3), RecordError);
});

test('multi-byte text: a character split across tokens belongs to the token that completes it', () => {
  const doc = readDocument(SPEC, 'tr_tokens');
  const t = nodeTokens(doc, readSidecar(SPEC, doc, 'tokens'), 1);
  assert.deepEqual(t.pieces, ['<s>assistant\n', '', '🙂', 'ok']);
  assert.deepEqual(t.logprobs, [0, -0.5, -0.25, -1]);
  assert.deepEqual(nodeTokens(doc, readSidecar(SPEC, doc, 'tokens'), 0).pieces, ['<s>', 'user\n', 'qé\n']);
});

test('no text recorded: pieces are null; no logprobs recorded: logprobs are null', () => {
  const doc = readDocument(SPEC, 'tr_notext');
  const tokens = readSidecar(SPEC, doc, 'tokens');
  const client = nodeTokens(doc, tokens, 0);
  assert.equal(client.pieces, null);
  assert.equal(client.logprobs, null);
  assert.deepEqual(nodeTokens(doc, tokens, 1).pieces, ['<a>', 'y', 'z']);
});

test('experts and sampling masks read per node', () => {
  const doc = readDocument(SPEC, 'tr_forked_unbridged');
  const tokens = readSidecar(SPEC, doc, 'tokens');
  const experts = readSidecar(SPEC, doc, 'experts');
  const mask = readSidecar(SPEC, doc, 'sampling_mask');
  assert.equal(mask.offsets.data.constructor, BigInt64Array);
  for (const node of doc.nodes) {
    const t = nodeTokens(doc, tokens, node.id);
    assert.deepEqual(nodeExperts(doc, experts, node.id).shape, [t.token_ids.length, 2, 2]);
    const rows = nodeSamplingMask(doc, mask, node.id);
    if (node.author === 'client') assert.equal(rows, null);
    // The mock engine's support for a sampled token t is [t, t + 1].
    else assert.deepEqual(rows, t.token_ids.slice(t.sampled_start).map((id) => [id, id + 1]));
  }
});

test('an empty sampling mask needs no sidecar', () => {
  const doc = readDocument(SPEC, 'tr_empty_mask');
  assert.equal(doc.sidecars.sampling_mask, undefined);
  assert.deepEqual(nodeSamplingMask(doc, null, 0), []);
});

test('text mode: no sidecars, no tokens, calls bridged null', () => {
  const doc = readDocument(SPEC, 'tr_text');
  assert.deepEqual(doc.sidecars, {});
  assert.equal(readSidecar(SPEC, doc, 'tokens'), null);
  assert.equal(nodeTokens(doc, null, 0), null);
  assert.equal(pathTokenCounts(doc, [0, 1], [1]), null);
});

test('an empty trajectory: no nodes, no paths', () => {
  const s = summarize(readDocument(SPEC, 'tr_empty'));
  assert.equal(s.nodes, 0);
  assert.equal(s.paths, 0);
  assert.equal(s.tokens, null);
});

test('check: real records and the Python-written edge cases conform', () => {
  for (const [dir, id] of fixtures) {
    const doc = readDocument(dir, id);
    const problems = check(doc, { tokens: readSidecar(dir, doc, 'tokens') });
    // tr_empty_mask is a hand-built graph with a model node and no call; the spec implies one.
    assert.deepEqual(problems, id === 'tr_empty_mask' ? ['node 0: model node without calls'] : [], id);
  }
});

test('check: catches broken documents', () => {
  const doc = readDocument(SPEC, 'tr_forked_unbridged');
  const broken = structuredClone(doc);
  broken.nodes[2].depth = 5;
  broken.nodes[3].tokens.offset += 1;
  broken.nodes[4].calls[0].tools = 'nope';
  const problems = check(broken);
  assert.ok(problems.some((p) => p.startsWith('node 2: depth')));
  assert.ok(problems.some((p) => p.startsWith('node 3: tokens offset')));
  assert.ok(problems.some((p) => p.includes('not in document tools')));
});

// -- the spec's edge cases, synthetically --------------------------------------------

const docBytes = (obj) => Buffer.from(JSON.stringify(obj));

test('a format_version this reader does not know is refused', () => {
  for (const v of [0, 2, '1', undefined]) {
    assert.throws(() => parseDocument(docBytes({ format_version: v, nodes: [] })), /format_version/);
  }
  assert.throws(() => parseDocument(docBytes([1])), RecordError);
});

test('unknown fields are ignored', () => {
  const doc = parseDocument(docBytes({ format_version: 1, id: 'x', status: 'open', nodes: [], sidecars: {}, future: { a: 1 } }));
  assert.equal(summarize(doc).status, 'open');
});

test('graph: a node must point at an earlier node, and ids must be positions', () => {
  const node = (id, parent) => ({ id, parent, depth: 0, author: 'client', calls: [] });
  assert.throws(() => graphOf({ id: 'x', nodes: [node(0, null), node(1, 1)] }), /parent/);
  assert.throws(() => graphOf({ id: 'x', nodes: [node(1, null)] }), /id is 1/);
  const g = graphOf({ id: 'x', nodes: [node(0, null), node(1, null)] });
  assert.deepEqual(g.paths.map((p) => [p.path, p.fork_from, p.diverges_at]), [[[0], null, null], [[1], null, 1]]);
});

test('zstd: several frames, a large frame, and a frame without a content size', () => {
  const a = Buffer.alloc(3_000_000, 7);
  const b = Buffer.from('tail'.repeat(1000));
  const two = Buffer.concat([zlib.zstdCompressSync(a), zlib.zstdCompressSync(b)]);
  assert.ok(decompress(two).equals(Buffer.concat([a, b])));
  const big = Buffer.alloc(64 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 255;
  assert.ok(decompress(zlib.zstdCompressSync(big)).equals(big));
  const noSize = zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_contentSizeFlag]: 0, [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
  assert.ok(decompress(noSize).equals(b));
  // A skippable frame is skipped; truncation and garbage are refused, not silently shortened.
  const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 9, 9]);
  assert.ok(decompress(Buffer.concat([skippable, zlib.zstdCompressSync(b)])).equals(b));
  assert.throws(() => decompress(two.subarray(0, two.length - 2)), /truncated/);
  assert.throws(() => decompress(Buffer.concat([two, Buffer.from('junk')])), /not a zstd frame/);
});

test('every fixture file is exactly one zstd frame, as format.md says', () => {
  for (const dir of [REAL, SPEC]) {
    for (const name of readdirSync(dir)) assert.equal(zstdFrames(readFileSync(`${dir}/${name}`)).length, 1, name);
  }
});

test('sidecar views: aligned arrays of every dtype, from a buffer at any byteOffset', () => {
  const raw = new ArrayBuffer(64);
  new Int32Array(raw, 0, 3).set([1, -2, 3]);
  new Float64Array(raw, 16, 2).set([NaN, -0.5]);
  new BigInt64Array(raw, 32, 2).set([0n, 5n]);
  new Uint8Array(raw, 48, 3).set([104, 105, 33]);
  new Int16Array(raw, 56, 2).set([-1, 2]);
  new Uint16Array(raw, 60, 2).set([65535, 3]);
  const entry = {
    arrays: {
      token_ids: { dtype: 'int32', shape: [3], offset: 0 },
      logprobs: { dtype: 'float64', shape: [2], offset: 16 },
      offsets: { dtype: 'int64', shape: [2], offset: 32 },
      text: { dtype: 'uint8', shape: [3], offset: 48 },
      i16: { dtype: 'int16', shape: [2], offset: 56 },
      u16: { dtype: 'uint16', shape: [2], offset: 60 },
      empty: { dtype: 'uint8', shape: [0], offset: 64 },
      grid: { dtype: 'int32', shape: [1, 3], offset: 0 },
    },
  };
  // A buffer that starts 3 bytes into its ArrayBuffer, like a pooled Node Buffer slice.
  const shifted = new Uint8Array(new ArrayBuffer(67), 3);
  shifted.set(new Uint8Array(raw));
  for (const buffer of [new Uint8Array(raw), shifted, Buffer.from(raw)]) {
    const v = viewSidecar(buffer, entry);
    assert.deepEqual(Array.from(v.token_ids.data), [1, -2, 3]);
    assert.ok(Number.isNaN(v.logprobs.data[0]));
    assert.deepEqual(Array.from(v.offsets.data), [0n, 5n]);
    assert.equal(Buffer.from(v.text.data).toString(), 'hi!');
    assert.deepEqual(Array.from(v.i16.data), [-1, 2]);
    assert.deepEqual(Array.from(v.u16.data), [65535, 3]);
    assert.equal(v.empty.data.length, 0);
    assert.equal(v.grid.data.length, 3);
  }
});

test('sidecar views: unknown dtypes, misaligned and out-of-range arrays are refused', () => {
  const buf = new Uint8Array(16);
  assert.throws(() => viewSidecar(buf, { arrays: { a: { dtype: 'float32', shape: [1], offset: 0 } } }), /dtype/);
  assert.throws(() => viewSidecar(buf, { arrays: { a: { dtype: 'int32', shape: [5], offset: 0 } } }), /past the end/);
  assert.throws(() => viewSidecar(buf, { arrays: { a: { dtype: 'int32', shape: [1], offset: 2 } } }), /aligned/);
});

test('token spans that leave the text or break a character are refused', () => {
  const doc = {
    id: 'x',
    nodes: [{ id: 0, parent: null, author: 'client', tokens: { offset: 0, length: 2, sampled_start: null, has_logprobs: false, text_offset: 0, text_bytes: 2 } }],
  };
  const tokens = (offsets, text) => ({
    token_ids: { data: new Int32Array([1, 2]) },
    logprobs: { data: new Float64Array(2) },
    text_offsets: { data: new Int32Array(offsets) },
    text: { data: new Uint8Array(text) },
  });
  assert.deepEqual(nodeTokens(doc, tokens([0, 1], [104, 105]), 0).pieces, ['h', 'i']);
  assert.throws(() => nodeTokens(doc, tokens([1, 0], [104, 105]), 0), /span/);
  assert.throws(() => nodeTokens(doc, tokens([0, 1], [0xc3, 0xa9]), 0), /UTF-8/); // "é" split in two
});

test('directory index and stats: listing reads only documents, and caches them', async () => {
  const index = new RecordDirectory(REAL);
  const { rows, errors } = await index.summaries();
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 4);
  const stats = directoryStats(rows);
  assert.equal(stats.forked, 2);
  assert.equal(stats.empty, 1);
  assert.equal(stats.paths.max.id, 'tr_21ffd62fd84bd796');
  assert.equal(stats.bridged.absent, rows.reduce((s, r) => s + r.calls, 0));
  const before = index.cache.get('tr_21ffd62fd84bd796');
  await index.summaries();
  assert.equal(index.cache.get('tr_21ffd62fd84bd796'), before);
});
