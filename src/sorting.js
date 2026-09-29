// Server-side sorting for the paged lists (rollouts and groups), so a sort is
// over the whole filtered run and not over the page that happened to load.
//
//   sort=step|task|reward|turns|tokens|health|created   order=asc|desc
//
// For a group, `reward` orders by the mean of its counting rollouts' rewards.
// That mean is an ordering key only and is never sent to the page: the viewer
// shows no training metrics. `turns` and `tokens` order a group by its
// largest rollout; `health` by how many flags it carries (its own, plus one
// per flagged rollout).

export const SORT_KEYS = ['step', 'task', 'reward', 'turns', 'tokens', 'health', 'created'];

/** Flags true of every record of a run carry nothing to sort by. */
const QUIET = new Set(['bridged-unknown']);

const numeric = (v) => (typeof v === 'boolean' ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null);

export function rowSortValue(row, key) {
  switch (key) {
    case 'step': return row.step ?? null;
    case 'task': return row.task_id ?? null;
    case 'reward': return numeric(row.annotations?.reward);
    case 'turns': return row.capture?.exchange_count ?? null;
    case 'tokens': return row.summary?.tokens ?? null;
    case 'health': return (row.summary?.flags ?? []).filter((f) => !QUIET.has(f)).length;
    case 'created': return row.created_ts ?? null;
    default: return null;
  }
}

export function groupSortValue(group, key) {
  switch (key) {
    case 'step': return group.step ?? null;
    case 'task': return group.task_id ?? null;
    case 'reward': {
      const values = group.rewards.map((r) => numeric(r.reward)).filter((v) => v !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    }
    case 'turns': return group.turns ? group.turns[1] : null;
    case 'tokens': return group.tokens ? group.tokens[1] : null;
    case 'health': return group.flags.length + Object.entries(group.rollup ?? {}).filter(([f]) => !QUIET.has(f)).reduce((s, [, n]) => s + n, 0);
    case 'created': return Number.isFinite(group.created_ts) ? group.created_ts : null;
    default: return null;
  }
}

/** The sort a request asked for, or null for the list's default. */
export function sortOf(params) {
  const key = params.get('sort');
  if (!key) return null;
  if (!SORT_KEYS.includes(key)) {
    const error = new Error(`sort must be one of ${SORT_KEYS.join(', ')}`);
    error.status = 400;
    throw error;
  }
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';
  return { key, order };
}

/** Compare by one key; nulls last in either order. */
export function comparator(valueOf, { key, order }, tiebreak) {
  const sign = order === 'asc' ? 1 : -1;
  return (a, b) => {
    const x = valueOf(a, key);
    const y = valueOf(b, key);
    if (x === null && y === null) return tiebreak(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
    return c ? sign * c : tiebreak(a, b);
  };
}

/** The min and max reward over rows, so colours compare across groups. */
export function rewardRange(rows) {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const v = numeric(row.annotations?.reward ?? row.reward);
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : null;
}
