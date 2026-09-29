// Directory statistics over trajectory summaries (see record.summarize).

const inc = (obj, key, by = 1) => {
  obj[key] = (obj[key] ?? 0) + by;
};

export function directoryStats(rows, errors = []) {
  const s = {
    trajectories: rows.length,
    unreadable: errors.length,
    status: {},
    not_ended: 0,
    modes: {},
    empty: 0,
    nodes: 0,
    calls: 0,
    tokens: 0,
    paths: { total: 0, histogram: {}, max: null },
    forked: 0,
    branch_points: 0,
    bridged: { true: 0, false: 0, null: 0, absent: 0 },
    with_unbridged: 0,
    with_bridged_absent: 0,
    shadowed_nodes: 0,
    retokenized_copies: 0,
    with_retokenized: 0,
    inferred_unbridged: 0,
    with_inferred_unbridged: 0,
    failures: 0,
    with_failures: 0,
    retries: { replayed: 0, coalesced: 0 },
    sidecars: {},
    reward: null,
  };
  const rewards = [];
  for (const r of rows) {
    inc(s.status, r.status);
    if (r.ended === false) s.not_ended++;
    inc(s.modes, r.mode ?? 'unknown');
    if (r.nodes === 0) s.empty++;
    s.nodes += r.nodes;
    s.calls += r.calls;
    s.tokens += r.tokens ?? 0;
    s.paths.total += r.paths;
    inc(s.paths.histogram, r.paths);
    if (!s.paths.max || r.paths > s.paths.max.paths) s.paths.max = { paths: r.paths, id: r.id };
    if (r.paths > 1) s.forked++;
    s.branch_points += r.branch_points;
    for (const [k, v] of Object.entries(r.bridged)) inc(s.bridged, k, v);
    if (r.bridged.false > 0) s.with_unbridged++;
    if (r.bridged.absent > 0) s.with_bridged_absent++;
    s.shadowed_nodes += r.shadowed;
    s.retokenized_copies += r.retokenized.length;
    if (r.retokenized.length) s.with_retokenized++;
    s.inferred_unbridged += r.inferred_unbridged.length;
    if (r.inferred_unbridged.length) s.with_inferred_unbridged++;
    s.failures += r.failures;
    if (r.failures) s.with_failures++;
    s.retries.replayed += r.retries?.replayed ?? 0;
    s.retries.coalesced += r.retries?.coalesced ?? 0;
    for (const kind of r.sidecars) inc(s.sidecars, kind);
    const reward = r.annotations?.reward;
    if (typeof reward === 'number' && Number.isFinite(reward)) rewards.push(reward);
  }
  if (rewards.length) s.reward = rewardStats(rewards, rows.length);
  return s;
}

function rewardStats(values, of) {
  values.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  const distinct = new Map();
  for (const v of values) distinct.set(v, (distinct.get(v) ?? 0) + 1);
  const out = { count: values.length, missing: of - values.length, mean, min: values[0], p50: q(0.5), max: values.at(-1) };
  if (distinct.size <= 12) out.values = Object.fromEntries([...distinct].map(([v, n]) => [String(v), n]));
  else {
    const lo = values[0];
    const width = (values.at(-1) - lo) / 10 || 1;
    const buckets = new Array(10).fill(0);
    for (const v of values) buckets[Math.min(9, Math.floor((v - lo) / width))]++;
    out.histogram = buckets.map((n, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, n }));
  }
  return out;
}

const pct = (n, of) => (of ? ` (${((100 * n) / of).toFixed(1)}%)` : '');
const kv = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ');

export function formatStats(dir, s) {
  const lines = [`${dir}`];
  const add = (label, value) => lines.push(`  ${label.padEnd(22)} ${value}`);
  add('trajectories', `${s.trajectories}${s.unreadable ? `  (+${s.unreadable} unreadable)` : ''}`);
  add('status', kv(s.status) + (s.not_ended ? `  (not ended: ${s.not_ended})` : ''));
  add('capture mode', kv(s.modes));
  add('sidecars', kv(s.sidecars) || 'none');
  add('nodes / calls / tokens', `${s.nodes} / ${s.calls} / ${s.tokens}`);
  add('empty (0 nodes)', `${s.empty}${pct(s.empty, s.trajectories)}`);
  const hist = Object.entries(s.paths.histogram).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ');
  add('paths per trajectory', `${hist}  (total ${s.paths.total}${s.paths.max ? `, max ${s.paths.max.paths} in ${s.paths.max.id}` : ''})`);
  add('forked (paths > 1)', `${s.forked}${pct(s.forked, s.trajectories)}, ${s.branch_points} branch points`);
  add('calls by bridged', `true=${s.bridged.true} false=${s.bridged.false} null=${s.bridged.null} absent=${s.bridged.absent}`);
  add('with unbridged calls', `${s.with_unbridged}${pct(s.with_unbridged, s.trajectories)}`);
  if (s.with_bridged_absent) add('bridged field absent', `${s.with_bridged_absent} trajectories (written before the field existed: unknown)`);
  add('shadowed nodes', s.shadowed_nodes);
  add('re-render signs', `${s.retokenized_copies} re-tokenized copies of a model node (in ${s.with_retokenized}); ${s.inferred_unbridged} model calls inferred unbridged (in ${s.with_inferred_unbridged})`);
  add('failures', `${s.failures} in ${s.with_failures} trajectories`);
  add('retries', `replayed=${s.retries.replayed} coalesced=${s.retries.coalesced}`);
  if (s.reward) {
    const r = s.reward;
    add('reward', `n=${r.count}${r.missing ? ` (missing ${r.missing})` : ''} mean=${r.mean.toFixed(4)} min=${r.min} p50=${r.p50} max=${r.max}`);
    if (r.values) add('', Object.entries(r.values).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join('  '));
    else add('', r.histogram.map((b) => `[${b.from.toFixed(2)},${b.to.toFixed(2)}):${b.n}`).join(' '));
  } else add('reward', 'none in annotations');
  return lines.join('\n');
}
