// GRPO groups: the rollouts of one prompt at one step.
//
// A group is keyed by values from each trajectory's meta (or annotations),
// `step` + `instance_id` by default. It is within one step and dense by
// construction -- every rollout of the prompt is in it -- which is why it is a
// unit here while `task x step` is not (inference-capture's
// design/run-dimensions.md): cross-step stays a filter.
//
// Within a group, a *repetition* is one rollout slot (`repetition_id`). A
// harness that retries a repetition writes a new trajectory with a higher
// `attempt`; the highest attempt is the one that counts, and the others are
// superseded. No training metrics are computed: no mean, no advantage.

import { flagLevel } from '../public/lib/diagnose.mjs';

export const DEFAULT_GROUP_BY = ['step', 'instance_id'];

const valueOf = (row, key) => {
  if (row.meta && key in row.meta) return row.meta[key];
  if (row.annotations && key in row.annotations) return row.annotations[key];
  return undefined;
};

/** A row's group key, or null when it lacks one of the key's fields. */
export function groupKeyOf(row, keys) {
  const values = keys.map((key) => valueOf(row, key));
  if (values.some((v) => v === undefined || v === null || typeof v === 'object')) return null;
  return values.map(String).join('~');
}

/** Whether a run's rows carry the group key: most of them do. */
export const groupable = (rows, keys) => rows.length > 0 && rows.filter((r) => groupKeyOf(r, keys) !== null).length >= rows.length / 2;

const numeric = (v) => (typeof v === 'boolean' ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null);
const MASKED_STOPS = new Set(['agent_timeout', 'error']);

/** Group rows by key. Returns {groups (keyed, un-summarised), modal size}. */
export function groupRows(rows, keys) {
  const byKey = new Map();
  for (const row of rows) {
    const key = groupKeyOf(row, keys);
    if (key === null) continue;
    (byKey.get(key) ?? byKey.set(key, []).get(key)).push(row);
  }
  const groups = [];
  for (const [key, members] of byKey) {
    // One slot per repetition; the highest attempt counts.
    const slots = new Map();
    for (const row of members) {
      const rep = row.meta?.repetition_id ?? row.id;
      (slots.get(rep) ?? slots.set(rep, []).get(rep)).push(row);
    }
    const counting = [];
    const superseded = [];
    for (const [rep, attempts] of slots) {
      attempts.sort((a, b) => (Number(b.meta?.attempt) || 0) - (Number(a.meta?.attempt) || 0) || (b.created_ts ?? 0) - (a.created_ts ?? 0));
      counting.push({ row: attempts[0], rep });
      for (const row of attempts.slice(1)) superseded.push({ row, rep, by: attempts[0].id });
    }
    const repOrder = (a, b) => (typeof a.rep === 'number' && typeof b.rep === 'number' ? a.rep - b.rep : String(a.rep).localeCompare(String(b.rep)));
    counting.sort(repOrder);
    groups.push({ key, values: Object.fromEntries(keys.map((k) => [k, valueOf(members[0], k)])), counting, superseded });
  }
  const sizes = new Map();
  for (const g of groups) sizes.set(g.counting.length, (sizes.get(g.counting.length) ?? 0) + 1);
  let modal = 0;
  let best = -1;
  for (const [size, count] of sizes) if (count > best || (count === best && size > modal)) [modal, best] = [size, count];
  return { groups, modal };
}

/** One group's listing row: what the group table shows, and its group-level flags. */
export function summariseGroup(group, modal) {
  const rows = group.counting.map((c) => c.row);
  const rewards = rows.map((r) => numeric(r.annotations?.reward));
  const binary = rewards.length > 0 && rewards.every((v) => v === 0 || v === 1);
  const flags = [];
  const known = rewards.filter((v) => v !== null);
  if (known.length === rows.length && known.length > 0 && known.every((v) => v === known[0])) flags.push('no-signal');
  if (rows.some((r) => MASKED_STOPS.has(r.annotations?.stop_reason))) flags.push('masked');
  if (rows.length < modal) flags.push('short');
  if (group.superseded.length) flags.push('retried');
  // Rollout flags, rolled up: how many rollouts carry each.
  const rollup = {};
  for (const r of rows) for (const f of r.summary?.flags ?? []) rollup[f] = (rollup[f] ?? 0) + 1;
  const turns = rows.map((r) => r.capture?.exchange_count ?? 0);
  const tokens = rows.map((r) => r.summary?.tokens ?? 0);
  const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);
  const task = rows.find((r) => r.task_id)?.task_id ?? null;
  const step = rows.find((r) => r.step !== null && r.step !== undefined)?.step ?? null;
  return {
    key: group.key,
    values: group.values,
    step,
    task_id: task,
    n: rows.length,
    modal_n: modal,
    rewards: group.counting.map(({ row, rep }) => ({ id: row.id, repetition_id: rep, attempt: row.meta?.attempt ?? null, reward: row.annotations?.reward ?? null, stop_reason: row.annotations?.stop_reason ?? null })),
    binary,
    pass: binary ? rewards.filter((v) => v === 1).length : null,
    turns: range(turns),
    tokens: range(tokens),
    superseded_count: group.superseded.length,
    flags,
    rollup,
    created_ts: Math.min(...rows.map((r) => r.created_ts ?? Infinity)),
  };
}

export const GROUP_FLAGS = ['no-signal', 'masked', 'short', 'retried'];

/** Counts for the band: groups with each group flag, and groups with any rollout carrying each rollout flag. */
export function groupHealth(summaries, order) {
  const counts = {};
  for (const g of summaries) {
    for (const f of g.flags) counts[f] = (counts[f] ?? 0) + 1;
    for (const f of Object.keys(g.rollup)) counts[f] = (counts[f] ?? 0) + 1;
  }
  const rank = (f) => {
    const i = order.indexOf(f);
    return i < 0 ? 999 : i;
  };
  return { scanned: summaries.length, total: summaries.length, unit: 'groups', counts: Object.entries(counts).sort((a, b) => rank(a[0]) - rank(b[0]) || (flagLevel(a[0]) < flagLevel(b[0]) ? -1 : 1)) };
}
