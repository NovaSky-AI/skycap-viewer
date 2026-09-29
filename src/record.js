// A reader for skycap records, format_version 1 (skycap/docs/format.md).
//
// Pure functions over a decoded document plus a few file helpers. Nothing here
// needs a tokenizer: the tokens sidecar carries the decoded text and each
// token's byte offset into it.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import zlib from 'node:zlib';

export const FORMAT_VERSION = 1;
export const DOC_SUFFIX = '.json.zst';
export const SIDECAR_KINDS = ['tokens', 'experts', 'sampling_mask'];

const DTYPES = {
  uint8: { size: 1, Array: Uint8Array },
  uint16: { size: 2, Array: Uint16Array },
  int16: { size: 2, Array: Int16Array },
  int32: { size: 4, Array: Int32Array },
  int64: { size: 8, Array: BigInt64Array },
  float64: { size: 8, Array: Float64Array },
};
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class RecordError extends Error {}

// -- files ----------------------------------------------------------------------

/**
 * The zstd frames in `bytes`, as subarrays (skippable frames dropped). Walks
 * frame and block headers only; nothing is decompressed. Throws on bytes that
 * are not zstd frames.
 */
export function zstdFrames(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const frames = [];
  let at = 0;
  const need = (n) => {
    if (at + n > u8.length) throw new RecordError(`truncated zstd frame at byte ${at}`);
  };
  while (at < u8.length) {
    need(4);
    const magic = view.getUint32(at, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      need(8);
      at += 8 + view.getUint32(at + 4, true);
      continue;
    }
    if (magic !== 0xfd2fb528) throw new RecordError(`not a zstd frame at byte ${at}`);
    const start = at;
    at += 4;
    need(1);
    const fhd = u8[at++];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictSize = [0, 1, 2, 4][fhd & 3];
    const fcsSize = [single ? 1 : 0, 2, 4, 8][fcsFlag];
    at += (single ? 0 : 1) + dictSize + fcsSize;
    for (;;) {
      need(3);
      const header = u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16);
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      if (type === 3) throw new RecordError(`reserved zstd block type at byte ${at}`);
      at += 3 + (type === 1 ? 1 : size);
      if (last) break;
    }
    at += checksum ? 4 : 0;
    need(0);
    frames.push(u8.subarray(start, at));
  }
  return frames;
}

/**
 * Decompress a skycap file with node:zlib's built-in zstd. format.md says one
 * frame per file; several are decompressed and concatenated (node:zlib alone
 * would silently stop after the first).
 */
export function decompress(bytes) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new RecordError(`this Node (${process.version}) has no built-in zstd; use Node >= 22.15 or >= 23.8`);
  }
  const frames = zstdFrames(bytes);
  if (frames.length === 1) return zlib.zstdDecompressSync(frames[0]);
  return Buffer.concat(frames.map((f) => zlib.zstdDecompressSync(f)));
}

/** Parse a decompressed document, refusing a format_version this reader doesn't know. */
export function parseDocument(bytes) {
  const doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : new TextDecoder().decode(bytes));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new RecordError('document is not a JSON object');
  if (doc.format_version !== FORMAT_VERSION) {
    throw new RecordError(`unsupported format_version ${JSON.stringify(doc.format_version)} (this reader knows ${FORMAT_VERSION})`);
  }
  if (!Array.isArray(doc.nodes)) throw new RecordError('document has no nodes array');
  return doc;
}

export const documentPath = (dir, id) => join(dir, `${id}${DOC_SUFFIX}`);

/** Trajectory ids in a record directory: one per `*.json.zst`, sorted. Temporary `.x.tmp` files are skipped. */
export function listIds(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(DOC_SUFFIX) && !name.startsWith('.'))
    .map((name) => name.slice(0, -DOC_SUFFIX.length))
    .sort();
}

export function readDocument(dir, id) {
  return parseDocument(decompress(readFileSync(documentPath(dir, id))));
}

export async function readDocumentAsync(dir, id) {
  return parseDocument(decompress(await readFile(documentPath(dir, id))));
}

// -- sidecars -------------------------------------------------------------------

/**
 * View a sidecar's decompressed buffer as typed arrays, per its manifest entry
 * (`{file, arrays: {name: {dtype, shape, offset}}}`). Each result is
 * `{dtype, shape, data}`, `data` a flat typed array of prod(shape) elements.
 */
export function viewSidecar(buffer, entry) {
  let bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // A Node Buffer may be a slice of a larger (pooled) ArrayBuffer; typed views
  // need the element alignment relative to the ArrayBuffer, so copy if needed.
  if (bytes.byteOffset % 8 !== 0) bytes = new Uint8Array(bytes);
  const out = {};
  for (const [name, spec] of Object.entries(entry.arrays ?? {})) {
    const dtype = DTYPES[spec.dtype];
    if (!dtype) throw new RecordError(`array ${name}: unknown dtype ${spec.dtype}`);
    if (!Array.isArray(spec.shape)) throw new RecordError(`array ${name}: shape is not a list`);
    const count = spec.shape.reduce((a, b) => a * b, 1);
    const offset = spec.offset;
    if (!Number.isInteger(offset) || offset < 0) throw new RecordError(`array ${name}: bad offset ${offset}`);
    if (offset % dtype.size !== 0) throw new RecordError(`array ${name}: offset ${offset} not aligned for ${spec.dtype}`);
    if (offset + count * dtype.size > bytes.byteLength) {
      throw new RecordError(`array ${name}: [${offset}, ${offset + count * dtype.size}) past the end of the ${bytes.byteLength}-byte sidecar`);
    }
    let data;
    if (LITTLE_ENDIAN || dtype.size === 1) {
      data = new dtype.Array(bytes.buffer, bytes.byteOffset + offset, count);
    } else {
      data = readBigEndianHost(bytes, offset, count, spec.dtype, dtype);
    }
    out[name] = { dtype: spec.dtype, shape: spec.shape, data };
  }
  return out;
}

function readBigEndianHost(bytes, offset, count, name, dtype) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, count * dtype.size);
  const data = new dtype.Array(count);
  const get = { uint16: 'getUint16', int16: 'getInt16', int32: 'getInt32', int64: 'getBigInt64', float64: 'getFloat64' }[name];
  for (let i = 0; i < count; i++) data[i] = view[get](i * dtype.size, true);
  return data;
}

/** A sidecar's arrays by name, or null when the document has no sidecar of that kind. */
export function readSidecar(dir, doc, kind) {
  const entry = doc.sidecars?.[kind];
  if (!entry) return null;
  const path = join(dir, entry.file);
  if (!existsSync(path)) throw new RecordError(`${doc.id}: ${kind} sidecar ${entry.file} is missing`);
  return viewSidecar(decompress(readFileSync(path)), entry);
}

/** Shapes of every sidecar, from the manifest alone (no decoding). */
export function sidecarShapes(doc) {
  const out = {};
  for (const [kind, entry] of Object.entries(doc.sidecars ?? {})) {
    out[kind] = Object.fromEntries(Object.entries(entry.arrays ?? {}).map(([name, a]) => [name, { dtype: a.dtype, shape: a.shape }]));
  }
  return out;
}

// -- the graph ------------------------------------------------------------------

/**
 * The graph's structure from the document alone.
 *
 * Paths follow the writer (skycap/samples.py): one per leaf, in leaf creation
 * (node id) order; each model node is a training target of the first path
 * that contains it. Per path, `diverges_at` is the first node no earlier path
 * contains (null for the first path) and `shared` how many leading nodes it
 * shares with earlier paths.
 */
export function graphOf(doc) {
  const nodes = doc.nodes;
  const children = new Map();
  const roots = [];
  nodes.forEach((node, i) => {
    if (node.id !== i) throw new RecordError(`${doc.id}: nodes[${i}].id is ${node.id}`);
    if (node.parent == null) roots.push(i);
    else {
      if (!(node.parent >= 0 && node.parent < i)) throw new RecordError(`${doc.id}: node ${i} has parent ${node.parent}, not an earlier node`);
      (children.get(node.parent) ?? children.set(node.parent, []).get(node.parent)).push(i);
    }
  });
  const leaves = nodes.filter((n) => !children.has(n.id)).map((n) => n.id);
  const branchPoints = [...children.entries()].filter(([, kids]) => kids.length > 1).map(([p]) => p).sort((a, b) => a - b);
  const trained = new Set();
  const seen = new Set();
  const paths = leaves.map((leaf, index) => {
    const path = [];
    for (let at = leaf; at != null; at = nodes[at].parent) path.push(at);
    path.reverse();
    const targets = path.filter((id) => nodes[id].author === 'model' && !trained.has(id));
    targets.forEach((id) => trained.add(id));
    let shared = 0;
    while (shared < path.length && seen.has(path[shared])) shared++;
    path.forEach((id) => seen.add(id));
    // Where this path leaves the earlier ones: its first new node, and the node it forks from (null: a new root).
    const diverges_at = index === 0 ? null : path[shared] ?? null;
    const fork_from = index === 0 || shared === 0 ? null : path[shared - 1];
    return { leaf, path, targets, shared, diverges_at, fork_from };
  });
  return { children, roots, leaves, branchPoints, paths };
}

/** How a call's `bridged` field reads: true, false, null, or 'absent' (a record written before the field existed). */
export const bridgedState = (call) => (Object.hasOwn(call, 'bridged') ? call.bridged : 'absent');

/** Per-token counts of a path, from the document alone. Null when a node on it has no tokens. */
export function pathTokenCounts(doc, path, targets) {
  const targetSet = new Set(targets);
  let total = 0;
  let trained = 0;
  for (const id of path) {
    const t = doc.nodes[id].tokens;
    if (t == null) return null;
    total += t.length;
    if (targetSet.has(id) && t.sampled_start != null) trained += t.length - t.sampled_start;
  }
  return { tokens: total, trained };
}

/**
 * Signs of re-rendering that need no `bridged` field (heuristics, labelled as such):
 *
 * - `retokenized`: client nodes shadowed by a model sibling. The harness sent
 *   back the model's message (same match hash) but the prompt was rendered
 *   from messages and didn't reproduce the sampled tokens, so the message got
 *   a second, client-authored node. In the Qwen3 runs this is the chat
 *   template dropping an earlier turn's thinking.
 * - `inferred_unbridged`: model nodes whose prompt, after the last model node
 *   above them, runs through such a copy. A bridged call extends a model
 *   node's tokens and hangs its new messages under it, so it never passes a
 *   re-tokenized copy; these calls were re-rendered.
 */
export function renderSigns(doc) {
  const nodes = doc.nodes;
  const retokenized = nodes
    .filter((n) => n.author === 'client' && n.shadowed_by != null && nodes[n.shadowed_by]?.author === 'model')
    .map((n) => n.id);
  const copies = new Set(retokenized);
  const inferred = [];
  for (const n of nodes) {
    if (n.author !== 'model') continue;
    for (let at = n.parent; at != null && nodes[at].author === 'client'; at = nodes[at].parent) {
      if (copies.has(at)) {
        inferred.push(n.id);
        break;
      }
    }
  }
  return { retokenized, inferred_unbridged: inferred };
}

/** A trajectory's one-row summary for listings. Reads only the document. */
export function summarize(doc) {
  const g = graphOf(doc);
  const bridged = { true: 0, false: 0, null: 0, absent: 0 };
  let calls = 0;
  const unbridgedNodes = [];
  for (const node of doc.nodes) {
    for (const call of node.calls ?? []) {
      calls++;
      const state = bridgedState(call);
      bridged[String(state)] = (bridged[String(state)] ?? 0) + 1;
      if (state === false && unbridgedNodes.at(-1) !== node.id) unbridgedNodes.push(node.id);
    }
  }
  const tokenSidecar = doc.sidecars?.tokens?.arrays?.token_ids;
  return {
    id: doc.id,
    status: doc.status,
    ended: doc.ended,
    meta: doc.meta ?? {},
    annotations: doc.annotations ?? {},
    mode: doc.capture?.mode ?? null,
    created_at: doc.created_at ?? null,
    finished_at: doc.finished_at ?? null,
    nodes: doc.nodes.length,
    calls,
    paths: g.paths.length,
    branch_points: g.branchPoints.length,
    bridged,
    unbridged_nodes: unbridgedNodes,
    ...renderSigns(doc),
    failures: (doc.failures ?? []).length,
    shadowed: doc.nodes.filter((n) => n.shadowed_by != null).length,
    tokens: tokenSidecar ? tokenSidecar.shape[0] : null,
    sidecars: Object.keys(doc.sidecars ?? {}),
    retries: doc.retries ?? null,
  };
}

// -- tokens ---------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * One node's tokens: ids, logprobs (null where unknown / not recorded), the
 * sampled boundary, and each token's text piece. `pieces` is null when the
 * node recorded no text.
 */
export function nodeTokens(doc, tokens, nodeId) {
  const meta = doc.nodes[nodeId].tokens;
  if (meta == null) return null;
  if (!tokens) throw new RecordError(`${doc.id}: node ${nodeId} has tokens but the document has no tokens sidecar`);
  const { offset, length } = meta;
  const n = tokens.token_ids.data.length;
  if (offset < 0 || offset + length > n) throw new RecordError(`${doc.id}: node ${nodeId} tokens [${offset}, ${offset + length}) outside the ${n}-token sidecar`);
  const ids = Array.from(tokens.token_ids.data.subarray(offset, offset + length));
  const logprobs = meta.has_logprobs
    ? Array.from(tokens.logprobs.data.subarray(offset, offset + length), (x) => (Number.isNaN(x) ? null : x))
    : null;
  let pieces = null;
  let text = null;
  if (meta.text_offset != null) {
    const all = tokens.text.data;
    if (meta.text_offset + meta.text_bytes > all.length) throw new RecordError(`${doc.id}: node ${nodeId} text past the end of the sidecar`);
    const bytes = all.subarray(meta.text_offset, meta.text_offset + meta.text_bytes);
    const starts = tokens.text_offsets.data.subarray(offset, offset + length);
    text = utf8.decode(bytes);
    pieces = new Array(length);
    for (let k = 0; k < length; k++) {
      const a = starts[k];
      const b = k + 1 < length ? starts[k + 1] : meta.text_bytes;
      if (a < 0 || b < a || b > meta.text_bytes) throw new RecordError(`${doc.id}: node ${nodeId} token ${k} span [${a}, ${b}) is not within its ${meta.text_bytes}-byte text`);
      try {
        pieces[k] = utf8.decode(bytes.subarray(a, b));
      } catch {
        throw new RecordError(`${doc.id}: node ${nodeId} token ${k} span is not whole UTF-8 characters`);
      }
    }
  }
  return { node: nodeId, token_ids: ids, logprobs, sampled_start: meta.sampled_start, text, pieces };
}

/**
 * Token kinds, per format.md and samples.py:
 *   trained  - sampled by the model, and this path is the one that trains the node
 *   sampled  - sampled, but trained on an earlier path (context here)
 *   scaffold - template tokens of a model node, before sampled_start
 *   prompt   - a client node's tokens
 */
export function tokenKind(node, isTarget, k, sampledStart) {
  if (node.author !== 'model' || sampledStart == null) return 'prompt';
  if (k < sampledStart) return 'scaffold';
  return isTarget ? 'trained' : 'sampled';
}

/** Every node of path `index`, with its tokens and a per-token kind. */
export function pathTokens(doc, tokens, graph, index) {
  const p = graph.paths[index];
  if (!p) throw new RecordError(`${doc.id}: no path ${index}`);
  const targets = new Set(p.targets);
  const counts = { trained: 0, sampled: 0, scaffold: 0, prompt: 0 };
  const nodes = p.path.map((id) => {
    const node = doc.nodes[id];
    const t = nodeTokens(doc, tokens, id);
    if (!t) return { node: id, author: node.author, role: node.role, missing: true };
    const kinds = t.token_ids.map((_, k) => tokenKind(node, targets.has(id), k, t.sampled_start));
    kinds.forEach((kind) => counts[kind]++);
    return { ...t, author: node.author, role: node.role, target: targets.has(id), kinds };
  });
  return { index, leaf: p.leaf, path: p.path, targets: p.targets, counts, nodes };
}

// -- checking ---------------------------------------------------------------------

/**
 * Check a document (and, when given, its decoded tokens sidecar) against
 * format.md. Returns a list of problems; empty means it conforms.
 */
export function check(doc, sidecars = {}) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  for (const field of ['id', 'status', 'nodes', 'sidecars']) if (!(field in doc)) bad(`missing ${field}`);
  if (!['finished', 'failed', 'abandoned', 'open'].includes(doc.status)) bad(`unknown status ${doc.status}`);
  try {
    graphOf(doc);
  } catch (e) {
    bad(e.message);
  }
  const tokenMode = doc.capture?.mode === 'tokens';
  let cursor = 0;
  let textCursor = 0;
  doc.nodes.forEach((node, i) => {
    const parent = node.parent == null ? null : doc.nodes[node.parent];
    if (node.depth !== (parent ? parent.depth + 1 : 0)) bad(`node ${i}: depth ${node.depth}, expected ${parent ? parent.depth + 1 : 0}`);
    if (!['client', 'model'].includes(node.author)) bad(`node ${i}: author ${node.author}`);
    if (node.author === 'client' && (node.calls ?? []).length) bad(`node ${i}: client node with calls`);
    if (node.author === 'model' && !(node.calls ?? []).length) bad(`node ${i}: model node without calls`);
    if (node.shadowed_by != null) {
      const sib = doc.nodes[node.shadowed_by];
      if (!sib || sib.parent !== node.parent || sib.match_hash !== node.match_hash) bad(`node ${i}: shadowed_by ${node.shadowed_by} is not a sibling with the same match hash`);
    }
    for (const call of node.calls ?? []) {
      if (call.tools != null && !(call.tools in (doc.tools ?? {}))) bad(`node ${i}: call tools ${call.tools} not in document tools`);
      if (!tokenMode && call.bridged != null) bad(`node ${i}: bridged ${call.bridged} in text mode`);
    }
    const t = node.tokens;
    if (t == null) {
      if (tokenMode) bad(`node ${i}: token mode but tokens is null`);
      return;
    }
    if (t.offset !== cursor) bad(`node ${i}: tokens offset ${t.offset}, expected ${cursor} (node order)`);
    cursor = t.offset + t.length;
    if (t.text_offset != null) {
      if (t.text_offset !== textCursor) bad(`node ${i}: text_offset ${t.text_offset}, expected ${textCursor} (node order)`);
      textCursor = t.text_offset + t.text_bytes;
    }
    if (node.author === 'client' && t.sampled_start != null) bad(`node ${i}: client node with sampled_start`);
    if (node.author === 'model' && (t.sampled_start == null || t.sampled_start < 0 || t.sampled_start > t.length)) bad(`node ${i}: sampled_start ${t.sampled_start} of ${t.length}`);
    if (t.mask_offset != null && node.author === 'model' && t.mask_rows !== t.length - t.sampled_start) bad(`node ${i}: ${t.mask_rows} mask rows for ${t.length - t.sampled_start} sampled tokens`);
    if (t.experts_offset != null && t.experts_rows !== t.length) bad(`node ${i}: ${t.experts_rows} expert rows for ${t.length} tokens`);
  });
  const entry = doc.sidecars?.tokens;
  if (entry) {
    const n = entry.arrays?.token_ids?.shape?.[0];
    if (n !== cursor) bad(`tokens sidecar has ${n} tokens, nodes cover ${cursor}`);
    if (entry.arrays?.text?.shape?.[0] !== textCursor) bad(`tokens sidecar has ${entry.arrays?.text?.shape?.[0]} text bytes, nodes cover ${textCursor}`);
    for (const [name, a] of Object.entries(entry.arrays ?? {})) if (a.offset % 8) bad(`tokens.${name} offset ${a.offset} not a multiple of 8`);
  } else if (cursor > 0) bad('nodes have tokens but there is no tokens sidecar');
  if (sidecars.tokens) {
    for (let i = 0; i < doc.nodes.length; i++) {
      try {
        const t = nodeTokens(doc, sidecars.tokens, i);
        const meta = doc.nodes[i].tokens;
        if (t && meta.has_logprobs && t.sampled_start != null) {
          // format.md: logprobs are "NaN where unknown, 0 for scaffold".
          for (let k = 0; k < t.sampled_start; k++) {
            if (t.logprobs[k] !== 0 && t.logprobs[k] !== null) { bad(`node ${i}: scaffold token ${k} logprob ${t.logprobs[k]}, expected 0 or NaN`); break; }
          }
        }
      } catch (e) {
        bad(e.message);
      }
    }
  }
  for (const kind of Object.keys(doc.sidecars ?? {})) if (!SIDECAR_KINDS.includes(kind)) bad(`unknown sidecar kind ${kind}`);
  const maskEntry = doc.sidecars?.sampling_mask;
  const maskRows = doc.nodes.reduce((s, n) => s + (n.tokens?.mask_offset != null ? n.tokens.mask_rows : 0), 0);
  if (maskEntry && maskEntry.arrays?.offsets?.shape?.[0] !== maskRows + 1) bad(`sampling_mask offsets has ${maskEntry.arrays?.offsets?.shape?.[0]} entries for ${maskRows} rows`);
  return problems;
}

// -- training sidecars (the viewer only shows their shapes) -------------------------

/** A node's routed experts as {rows, shape: [rows, layers, k], data}, or null when absent. */
export function nodeExperts(doc, experts, nodeId) {
  const meta = doc.nodes[nodeId].tokens;
  if (meta?.experts_offset == null) return null;
  if (!experts) throw new RecordError(`${doc.id}: node ${nodeId} has experts but there is no experts sidecar`);
  const { shape, data } = experts.routed_experts;
  const row = shape.slice(1).reduce((a, b) => a * b, 1);
  if (meta.experts_offset + meta.experts_rows > shape[0]) throw new RecordError(`${doc.id}: node ${nodeId} expert rows past the end`);
  return {
    shape: [meta.experts_rows, ...shape.slice(1)],
    data: data.subarray(meta.experts_offset * row, (meta.experts_offset + meta.experts_rows) * row),
  };
}

/** A node's sampling-mask rows (one id list per sampled token), or null when absent. */
export function nodeSamplingMask(doc, mask, nodeId) {
  const meta = doc.nodes[nodeId].tokens;
  if (meta?.mask_offset == null) return null;
  if (meta.mask_rows === 0) return []; // the writer omits the sidecar when every node has zero rows
  if (!mask) throw new RecordError(`${doc.id}: node ${nodeId} has mask rows but there is no sampling_mask sidecar`);
  const ids = mask.ids.data;
  const bounds = mask.offsets.data;
  if (meta.mask_offset + meta.mask_rows + 1 > bounds.length) throw new RecordError(`${doc.id}: node ${nodeId} mask rows past the end`);
  const rows = [];
  for (let r = meta.mask_offset; r < meta.mask_offset + meta.mask_rows; r++) {
    rows.push(Array.from(ids.subarray(Number(bounds[r]), Number(bounds[r + 1]))));
  }
  return rows;
}
