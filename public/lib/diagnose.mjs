/** What is wrong with this record, said in one word per problem.
 *
 * Ported from inference-capture's viewer. A person scrolling a run is not
 * reading trajectories; they are looking for the one that is not like the
 * others, and the useful signal is rarely a number. None of this is a
 * training metric: the viewer's job stops at *is this record right*.
 *
 * Every flag is derived from one skycap record (its document, and its tokens
 * sidecar for nothing here: flags need only the document). The server runs
 * this same module over every record it indexes, so the health band and the
 * flag filter cover the whole run, not only the page on screen.
 */

const FLAGS = {
  'failed-calls': { level: 'error', why: 'calls that produced no node: an upstream error or an unreadable reply (the record\'s failures)' },
  incomplete: { level: 'error', why: 'written at shutdown, before the trajectory ended: capture did not see all of it' },
  'no-logprobs': { level: 'error', why: 'sampled tokens without logprobs cannot be importance-weighted' },
  unbridged: { level: 'warn', why: 'a call with bridged=false: its prompt was re-rendered from the messages instead of extending the previous call\'s tokens' },
  'unbridged-inferred': { level: 'warn', why: 'no bridged field in this record, but a call\'s prompt runs through a re-tokenized copy of a model turn, so it was re-rendered (inferred)' },
  replayed: { level: 'warn', why: 'assistant text the model did not sample here is in the prompt (a client-authored assistant turn)' },
  'no-train': { level: 'warn', why: 'a path that trains nothing: its export row would be empty' },
  empty: { level: 'warn', why: 'no successful call was recorded: no nodes, no paths' },
  truncated: { level: 'warn', why: 'generation stopped on the token budget (finish_reason length), not on the model' },
  'unclosed-think': { level: 'warn', why: 'a model turn opens <think> and never closes it' },
  abandoned: { level: 'info', why: 'the trajectory went idle past the TTL and was sealed without a finish' },
  forked: { level: 'info', why: 'more than one root-to-leaf path: the history diverged' },
  'bridged-unknown': { level: 'info', why: 'written before calls recorded bridged: whether each call extended the previous tokens is unknown' },
};

export const FLAG_NAMES = Object.keys(FLAGS);
export const flagLevel = (name) => FLAGS[name]?.level || 'info';
export const flagWhy = (name) => FLAGS[name]?.why || '';

/** Roll a `/paths` response and its trajectory up into what a table row shows. */
export function summarise(paths, trajectory) {
  const flags = new Set();
  const sky = trajectory?.skycap || {};
  if (sky.failures > 0) flags.add('failed-calls');
  if (trajectory?.ended === false || trajectory?.status === 'open') flags.add('incomplete');
  if (sky.bridged?.false > 0) flags.add('unbridged');
  if (sky.inferred_unbridged?.length) flags.add('unbridged-inferred');
  if (sky.truncated_nodes?.length) flags.add('truncated');
  if (sky.unclosed_think?.length) flags.add('unclosed-think');
  if (trajectory?.status === 'abandoned') flags.add('abandoned');
  if (sky.bridged?.absent > 0) flags.add('bridged-unknown');

  const list = paths?.paths || [];
  if (list.length > 1) flags.add('forked');
  if (!list.length) flags.add('empty');
  const tokensMode = paths?.mode === 'tokens';

  let tokens = 0;
  let trainable = 0;
  const kinds = Object.create(null);
  for (const path of list) {
    tokens = Math.max(tokens, path.token_count || path.char_count || 0);
    trainable = Math.max(trainable, path.trainable_count || 0);
    if (path.abandoned) flags.add('abandoned');
    if (path.stop_reason === 'length') flags.add('truncated');
    if (tokensMode && !path.abandoned && (path.trainable_count || 0) === 0) flags.add('no-train');
    for (const block of path.blocks || []) {
      kinds[block.kind] = (kinds[block.kind] || 0) + (block.token_count || block.char_count || block.text?.length || 0);
      if (block.kind === 'replayed') flags.add('replayed');
    }
    // Stricter than "none at all": any sampled token without a logprob.
    if (tokensMode && (path.trainable_count || 0) > (path.logprob_count ?? 0)) flags.add('no-logprobs');
  }
  const order = FLAG_NAMES;
  return {
    tokens,
    trainable,
    kinds,
    flags: [...flags].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    paths: list.length,
  };
}

/** The same rollup across rows, for the band above the table. */
export function runHealth(rows) {
  const counts = Object.create(null);
  let scanned = 0;
  for (const row of rows) {
    if (!row.summary) continue;
    scanned += 1;
    for (const flag of row.summary.flags) counts[flag] = (counts[flag] || 0) + 1;
  }
  const order = FLAG_NAMES;
  return {
    scanned,
    total: rows.length,
    counts: Object.entries(counts).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])),
  };
}

/** Where two paths stop agreeing: the last node they share, and what each has after it. */
export function divergence(left, right) {
  const a = left.node_ids || [];
  const b = right.node_ids || [];
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return {
    shared_nodes: shared,
    last_common: shared ? a[shared - 1] : null,
    shared_node_ids: a.slice(0, shared),
    left_only: a.slice(shared),
    right_only: b.slice(shared),
  };
}

/** Which paths run through each node, and which of them train it (sampled blocks). */
export function trainOnce(paths) {
  const through = new Map();
  for (const path of paths || []) {
    for (const nodeId of path.node_ids || []) {
      if (!through.has(nodeId)) through.set(nodeId, { paths: [], trains: [] });
      through.get(nodeId).paths.push(path.path_id);
    }
    for (const block of path.blocks || []) {
      if (block.kind !== 'sampled' || !block.node_id) continue;
      const entry = through.get(block.node_id);
      if (entry && !entry.trains.includes(path.path_id)) entry.trains.push(path.path_id);
    }
  }
  const violations = [...through.entries()].filter(([, entry]) => entry.trains.length > 1);
  return { through, violations };
}
