// Why a record's history forked, read at each branch point.
//
// A harness that only appends to its history records one root-to-leaf path.
// Every fork is a place where a request's history stopped matching what the
// graph already had, and comparing the new branch's first node with the
// sibling it should have matched says why:
//
//   resample           the model replied again to a history it had already
//                      answered (a retry, n > 1, or a reply to a cut-short history)
//   edited reply       the harness sent back a model reply with fields changed,
//                      such as stripped reasoning or a repaired tool call
//   re-rendered        token mode: the same message, but its re-render didn't
//                      reproduce the tokens the model sampled
//   different message  a different message after the same history: a
//                      compaction, a subagent, a rewritten turn
//   tools or model     the same message, sent with another tool set or model;
//                      a match covers both, so this starts a new root
//
// A second root is compared with the earlier roots the same way. Everything
// here reads the document alone.

import { graphOf } from './record.js';

export const FORK_KINDS = ['resample', 'edited reply', 're-rendered', 'different message', 'tools or model'];

// What a token-mode match hash sees of a message (skycap/hashing.py: RENDERED_FIELDS).
const RENDERED = new Set(['role', 'content', 'reasoning_content', 'reasoning', 'name', 'tool_calls', 'tool_call_id', 'tool_responses', 'task', 'wo_eos', 'response_format']);
const RENDERED_TOOL_CALL = new Set(['id', 'function', 'name', 'arguments', 'tool_call_id']);
const RENDERED_FUNCTION = new Set(['name', 'arguments']);

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => keys.has(k)));
const empty = (v) => v == null || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length);

/** The message with empty top-level values dropped, as text-mode matching sees it. */
const canonical = (message) => Object.fromEntries(Object.entries(message ?? {}).filter(([, v]) => !empty(v)));

/** The part of a message a renderer reads, as token-mode matching sees it. */
function rendered(message) {
  const kept = pick(message ?? {}, RENDERED);
  if (Array.isArray(kept.tool_calls)) {
    kept.tool_calls = kept.tool_calls.map((call) => {
      if (!isObject(call)) return call;
      const out = pick(call, RENDERED_TOOL_CALL);
      if (isObject(out.function)) out.function = pick(out.function, RENDERED_FUNCTION);
      return out;
    });
  }
  return canonical(kept);
}

/** JSON with keys sorted at every level, so equal values stringify alike. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Which top-level fields differ, e.g. ["content changed", "reasoning_content dropped"]. */
function changes(before, after) {
  const out = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(key in after)) out.push(`${key} dropped`);
    else if (!(key in before)) out.push(`${key} added`);
    else if (stable(before[key]) !== stable(after[key])) out.push(`${key} changed`);
  }
  return out;
}

/** Whether rank `a` sorts before rank `b`, comparing element by element. */
const lexLess = (a, b) => {
  const i = a.findIndex((v, k) => v !== b[k]);
  return i >= 0 && a[i] < b[i];
};

const article = (role) => {
  const word = role ?? 'unnamed';
  return `${'aeio'.includes(word[0].toLowerCase()) || word.toLowerCase().startsWith('un') ? 'an' : 'a'} ${word}`;
};

/**
 * The earlier sibling `node`'s history should have matched: one with the
 * same match hash (only the tokens or the sampling differ), then one with the
 * same message (only the tools or model differ), then one of the same role,
 * for a harness-written node the one with the fewest changed fields. Ties go
 * to a model reply over a harness-written one, then to the latest. With no
 * sibling of its role, the latest.
 */
function closest(node, earlier, messages) {
  const message = messages.get(node.id);
  const sameRole = earlier.filter((s) => s.role === node.role);
  const candidates = sameRole.length ? sameRole : earlier;
  const rank = (s) => [
    s.match_hash === node.match_hash ? 0 : 1,
    stable(messages.get(s.id)) === stable(message) ? 0 : 1,
    sameRole.length && node.author !== 'model' ? changes(messages.get(s.id), message).length : 0,
    sameRole.length && s.author === 'model' ? 0 : 1,
    -s.id,
  ];
  let best = null;
  let bestRank = null;
  for (const s of candidates) {
    const r = rank(s);
    if (!best || lexLess(r, bestRank)) [best, bestRank] = [s, r];
  }
  return best;
}

function cause(sibling, node, messages) {
  const before = messages.get(sibling.id);
  const after = messages.get(node.id);
  if (node.author === 'model') {
    if (node.match_hash === sibling.match_hash) {
      if (sibling.author === 'model') return ['resample', 'the same reply again, under other sampling parameters or tokenized differently'];
      return ['resample', 'the model sampled a message the harness had already written'];
    }
    if (sibling.role === node.role) return ['resample', 'a second reply to the same history'];
    return ['resample', `a reply to a history the other path continues with ${article(sibling.role)} message`];
  }
  if (node.match_hash === sibling.match_hash) return ['re-rendered', 'the same message, rendered to different tokens'];
  if (stable(before) === stable(after)) return ['tools or model', 'the same message, sent with a different tool set or model'];
  if (sibling.role !== node.role) return ['different message', `${article(node.role)} message where the other path has ${article(sibling.role)} message`];
  const changed = changes(before, after).join(', ');
  if (sibling.author === 'model') return ['edited reply', `the harness sent back the model's reply with ${changed}`];
  return ['different message', `a different ${node.role} message: ${changed}`];
}

/**
 * One fork per child after the first under each root and branch point, in
 * node order: `{parent, node, sibling, kind, detail}`, `parent` null for a
 * second root. Empty when the history stayed on one path.
 */
export function forksOf(doc) {
  const g = graphOf(doc);
  const normalize = doc.capture?.mode === 'tokens' ? rendered : canonical;
  const messages = new Map(doc.nodes.map((n) => [n.id, normalize(n.message)]));
  const forks = [];
  for (const parent of [null, ...g.branchPoints]) {
    const children = (parent == null ? g.roots : g.children.get(parent)).map((id) => doc.nodes[id]);
    children.forEach((node, index) => {
      if (!index) return;
      const sibling = closest(node, children.slice(0, index), messages);
      const [kind, detail] = cause(sibling, node, messages);
      forks.push({ parent, node: node.id, sibling: sibling.id, kind, detail });
    });
  }
  return forks.sort((a, b) => a.node - b.node);
}

/** How many forks of each kind, in FORK_KINDS order, kinds with none left out. */
export function forkKinds(forks) {
  const counts = {};
  for (const kind of FORK_KINDS) {
    const n = forks.filter((f) => f.kind === kind).length;
    if (n) counts[kind] = n;
  }
  return counts;
}
