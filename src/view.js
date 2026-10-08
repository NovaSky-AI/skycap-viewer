// What the page reads: skycap records turned into the /v1 shapes the front end
// renders. Everything here is derived from one record's files.
//
// Paths are cut into blocks on the mask *and* the node (turn) boundary:
//
//   given              a client node that is not an assistant turn (system, user, tool)
//   replayed           a client-authored assistant turn: text the model did not sample
//                      here (a harness edit, stripped reasoning, a re-tokenized copy)
//   scaffold           a model node's tokens before sampled_start (the template prefix)
//   sampled            a model node's sampled tokens, on the path that trains it
//   sampled-elsewhere  a model node's sampled tokens on any later path: the model did
//                      produce them, but skycap trains each model node on exactly one
//                      path (the first containing it), so here they are loss-masked
//                      context. Carries `trained_in`, the path that trains them.
//
// `start`/`end` index the path's concatenated tokens (input_ids, loss_mask and
// rollout_logprobs alike). `token_offsets` are UTF-16 code units into the
// block's `text`, one per token plus the end, which is what String#slice counts.

import { basename } from 'node:path';
import { bridgedState, graphOf, nodeTokens, renderSigns, sidecarProblems } from './record.js';

export const nodeKey = (id) => (id == null ? null : `n${id}`);
export const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t * 1000).toISOString() : null);

/** A message as readable text: reasoning, content (string or parts), tool calls. */
export function messageText(m) {
  if (!m) return '';
  const parts = [];
  if (m.reasoning_content) parts.push(m.reasoning_content);
  if (typeof m.content === 'string') parts.push(m.content);
  else if (Array.isArray(m.content)) parts.push(m.content.map((p) => (typeof p === 'string' ? p : p?.text ?? `[${p?.type}]`)).join(''));
  else if (m.content != null) parts.push(JSON.stringify(m.content));
  for (const c of m.tool_calls ?? []) parts.push(`${c.function?.name}(${c.function?.arguments ?? ''})`);
  return parts.join('\n');
}

/** The task a trajectory attempted, from its meta: task_id, else the task path's basename, else instance_id. */
export function taskOf(meta = {}) {
  if (meta.task_id != null) return String(meta.task_id);
  if (typeof meta.task === 'string' && meta.task) return basename(meta.task);
  if (meta.instance_id != null) return String(meta.instance_id);
  return null;
}

export function stepOf(meta = {}) {
  const step = meta.step;
  if (step === null || step === undefined || step === '') return null;
  const n = Number(step);
  return Number.isFinite(n) ? n : null;
}

const modeOf = (doc) => doc.capture?.mode ?? (doc.sidecars?.tokens ? 'tokens' : 'text');

/**
 * Everything a trajectory row and the drawer header show, from the document
 * alone, and `missing`: the sidecar kinds its manifest lists whose files are not
 * beside it (record.missingSidecars), which read as absent.
 */
export function trajectoryOf(doc, { run = null, project = null, revision = null, missing = [] } = {}) {
  const bridged = { true: 0, false: 0, null: 0, absent: 0 };
  const unbridged = [];
  const truncated = [];
  let calls = 0;
  for (const node of doc.nodes) {
    for (const call of node.calls ?? []) {
      calls++;
      const state = bridgedState(call);
      bridged[String(state)]++;
      if (state === false && unbridged.at(-1) !== node.id) unbridged.push(node.id);
      if (call.finish_reason === 'length' && truncated.at(-1) !== node.id) truncated.push(node.id);
    }
  }
  const signs = renderSigns(doc);
  return {
    id: doc.id,
    run_id: run,
    project,
    task_id: taskOf(doc.meta),
    step: stepOf(doc.meta),
    mode: modeOf(doc),
    status: doc.status,
    ended: doc.ended,
    meta: doc.meta ?? {},
    annotations: doc.annotations ?? {},
    created_at: iso(doc.created_at),
    finished_at: iso(doc.finished_at),
    revision,
    tokenizer: doc.capture?.tokenizer ?? null,
    capture: {
      ...(doc.capture ?? {}),
      node_count: doc.nodes.length,
      exchange_count: calls,
      failure_count: (doc.failures ?? []).length,
    },
    retries: doc.retries ?? null,
    sidecars: Object.fromEntries(Object.entries(doc.sidecars ?? {}).map(([kind, entry]) => [kind,
      Object.fromEntries(Object.entries(entry.arrays ?? {}).map(([name, a]) => [name, { dtype: a.dtype, shape: a.shape }]))])),
    // Listed, but the file is not here (e.g. a mirror's exclude, or lost): absent.
    missing_sidecars: missing,
    record_problems: sidecarProblems(doc),
    skycap: {
      bridged,
      unbridged_nodes: unbridged.map(nodeKey),
      inferred_unbridged: bridged.absent ? signs.inferred_unbridged.map(nodeKey) : [],
      retokenized: signs.retokenized.map(nodeKey),
      truncated_nodes: truncated.map(nodeKey),
      shadowed: doc.nodes.filter((n) => n.shadowed_by != null).length,
      failures: (doc.failures ?? []).length,
    },
  };
}

function segmentsOf(node, target) {
  const t = node.tokens;
  const length = t ? t.length : 0;
  if (node.author !== 'model') return [[0, length, node.role === 'assistant' ? 'replayed' : 'given']];
  const start = t?.sampled_start ?? 0;
  const sampled = target ? 'sampled' : 'sampled-elsewhere';
  return [[0, start, 'scaffold'], [start, length, sampled]].filter(([a, b], i) => b > a || (i === 1 && !t));
}

/**
 * Why a token-mode record's paths are drawn from message text, or null:
 *   tokens-missing   the manifest lists it but the file is not here: absent (format.md)
 *   tokens-unlisted  nodes slice into it but the manifest does not list it (a malformed record)
 */
function textOnlyReason(doc, tokens, text) {
  if (doc.sidecars?.tokens) return text && !tokens ? 'tokens-missing' : null;
  return doc.nodes.some((n) => n.tokens != null) ? 'tokens-unlisted' : null;
}

/**
 * The `/paths` payload: one entry per root-to-leaf path, which is one export row.
 * `tokens` is the decoded tokens sidecar, or null; with `text: false` nothing is
 * decoded and blocks carry only their kinds and ranges. With text and no tokens
 * to decode, blocks are the messages, and `text_only` says why.
 */
export function pathsOf(doc, tokens, { text = true } = {}) {
  const g = graphOf(doc);
  const mode = modeOf(doc);
  const textOnly = textOnlyReason(doc, tokens, text);
  const tokenMode = Boolean(doc.sidecars?.tokens) && textOnly === null;
  const decode = text && tokenMode && tokens;
  const trainedIn = new Map();
  g.paths.forEach((p, i) => p.targets.forEach((id) => trainedIn.set(id, i)));
  const cache = new Map();
  const tokensOf = (id) => {
    if (!cache.has(id)) cache.set(id, nodeTokens(doc, tokens, id));
    return cache.get(id);
  };

  const paths = g.paths.map((p, index) => {
    const targets = new Set(p.targets);
    const blocks = [];
    const logprobs = decode ? [] : null;
    let cursor = 0;
    let trainable = 0;
    let logprobCount = 0;
    let chars = 0;
    for (const id of p.path) {
      const node = doc.nodes[id];
      const target = targets.has(id);
      if (tokenMode && node.tokens) {
        const meta = node.tokens;
        const t = decode ? tokensOf(id) : null;
        for (const [a, b, kind] of segmentsOf(node, target)) {
          const block = {
            kind, role: node.role ?? null, author: node.author, node_id: nodeKey(id),
            trainable: kind === 'sampled', start: cursor + a, end: cursor + b, token_count: b - a,
          };
          if (kind === 'sampled-elsewhere') block.trained_in = trainedIn.get(id) ?? null;
          if (t) {
            block.token_ids = t.token_ids.slice(a, b);
            if (t.pieces) {
              const pieces = t.pieces.slice(a, b);
              block.text = pieces.join('');
              const offsets = [0];
              for (const piece of pieces) offsets.push(offsets.at(-1) + piece.length);
              block.token_offsets = offsets;
            } else block.text = null;
          }
          if (kind === 'sampled') {
            trainable += b - a;
            if (meta.has_logprobs) logprobCount += b - a;
          }
          blocks.push(block);
        }
        if (logprobs) {
          const t2 = tokensOf(id);
          for (let k = 0; k < meta.length; k++) logprobs.push(t2.logprobs ? t2.logprobs[k] : null);
        }
        cursor += meta.length;
      } else {
        const body = messageText(node.message);
        const kind = segmentsOf({ ...node, tokens: null }, target).at(-1)[2];
        const block = { kind, role: node.role ?? null, author: node.author, node_id: nodeKey(id), trainable: kind === 'sampled', char_count: body.length };
        if (kind === 'sampled-elsewhere') block.trained_in = trainedIn.get(id) ?? null;
        if (text) block.text = body;
        if (kind === 'sampled') trainable += body.length;
        chars += body.length;
        blocks.push(block);
      }
    }
    const leaf = doc.nodes[p.leaf];
    const out = {
      path_id: `${doc.id}-p${String(index).padStart(4, '0')}`,
      index,
      node_ids: p.path.map(nodeKey),
      leaf_node_id: nodeKey(p.leaf),
      fork_from: nodeKey(p.fork_from),
      diverges_at: nodeKey(p.diverges_at),
      shared_nodes: p.shared,
      targets: p.targets.map(nodeKey),
      abandoned: false,
      masked_reason: null,
      stop_reason: leaf.author === 'model' ? leaf.calls?.at(-1)?.finish_reason ?? null : null,
      token_count: tokenMode ? cursor : 0,
      char_count: tokenMode ? null : chars,
      trainable_count: trainable,
      blocking: tokenMode ? 'mask+turns' : null,
      logprob_count: logprobCount,
      blocks,
      messages: p.path.map((id) => ({ role: doc.nodes[id].role, author: doc.nodes[id].author, chars: messageText(doc.nodes[id].message).length })),
    };
    if (logprobs) out.logprobs = logprobs;
    return out;
  });
  return { trajectory: doc.id, mode, text_only: textOnly, tokenizer: doc.capture?.tokenizer ?? null, paths };
}

/** The `/graph` payload: one entry per node, plus leaves and branch points. */
export function graphPayload(doc) {
  const g = graphOf(doc);
  const signs = renderSigns(doc);
  const absent = doc.nodes.some((n) => (n.calls ?? []).some((c) => bridgedState(c) === 'absent'));
  const inferred = new Set(absent ? signs.inferred_unbridged : []);
  const retokenized = new Set(signs.retokenized);
  return {
    trajectory: doc.id,
    nodes: doc.nodes.map((n) => {
      const t = n.tokens;
      const calls = (n.calls ?? []).map((c) => ({ ...c, bridged: bridgedState(c) }));
      return {
        node_id: nodeKey(n.id),
        parent_node_id: nodeKey(n.parent),
        depth: n.depth,
        role: n.role ?? null,
        author: n.author,
        token_count: t ? t.length : null,
        char_count: messageText(n.message).length,
        sampled_start: t?.sampled_start ?? null,
        sampled_token_count: t && t.sampled_start != null ? t.length - t.sampled_start : 0,
        has_logprobs: Boolean(t?.has_logprobs),
        created_at: iso(n.created_at),
        shadowed_by: nodeKey(n.shadowed_by),
        match_hash: n.match_hash,
        delta_hash: n.delta_hash,
        calls,
        signs: {
          unbridged: calls.some((c) => c.bridged === false),
          inferred_unbridged: inferred.has(n.id),
          retokenized: retokenized.has(n.id),
        },
        message: n.message,
      };
    }),
    leaf_node_ids: g.leaves.map(nodeKey),
    branch_points: g.branchPoints.map((id) => ({ node_id: nodeKey(id), child_count: g.children.get(id).length, child_ids: g.children.get(id).map(nodeKey) })),
  };
}

/** The `/exchanges` payload: every model call (one per recorded call on a model node) and every failure. */
export function exchangesOf(doc) {
  const rows = [];
  for (const node of doc.nodes) {
    for (const call of node.calls ?? []) {
      rows.push({
        kind: 'call',
        node_id: nodeKey(node.id),
        t: call.t_start,
        model: call.model ?? null,
        started_at: iso(call.t_start),
        duration_ms: call.t_end != null && call.t_start != null ? (call.t_end - call.t_start) * 1000 : null,
        completion_reason: call.finish_reason ?? null,
        bridged: bridgedState(call),
        usage: call.usage ?? null,
        sampling: call.sampling ?? {},
        tools: call.tools ?? null,
      });
    }
  }
  for (const f of doc.failures ?? []) {
    rows.push({ kind: 'failure', node_id: nodeKey(f.input_leaf), t: f.t, started_at: iso(f.t), http_status: f.status ?? null, error: f.error });
  }
  rows.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  rows.forEach((row, i) => {
    row.sequence = i;
    delete row.t;
  });
  return { data: rows };
}
