// The viewer's server: the page's static files, and a small read API over
// skycap record directories, in the shapes of inference-capture's /v1 so the
// front end ports without a second vocabulary. It only reads files; anything
// on screen can be fetched with curl.
//
//   GET /healthz                                  {status, source: "record", record}
//   GET /v1/runs[?refresh=true]                    record directories, with steps, tasks, statuses, annotation values
//   GET /v1/trajectories?run_id=&step=&task_id=&status=&flag=&annotation=k=v&q=&limit=&cursor=&refresh=
//                                                 the run's flat, filtered list; `health` counts flags over the filtered run
//   GET /v1/trajectories/{id}[?run_id=]            one trajectory's header
//   GET /v1/trajectories/{id}/paths[?text=false]    root-to-leaf paths as blocks (text=false: no decoding, no sidecar)
//   GET /v1/trajectories/{id}/graph                one entry per node, leaves, branch points
//   GET /v1/trajectories/{id}/exchanges            the model calls behind it, and its failures
//
// Every /v1 route is also served under /api/v1, the prefix the page uses.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runs } from './runs.js';
import { documentPath, readDocumentAsync, readSidecar } from './record.js';
import { exchangesOf, graphPayload, pathsOf, trajectoryOf } from './view.js';
import { FLAG_NAMES, runHealth } from '../public/lib/diagnose.mjs';
import { comparator, groupSortValue, rewardRange, rowSortValue, sortOf } from './sorting.js';
import { DEFAULT_GROUP_BY, GROUP_FLAGS, groupHealth, groupRows, summariseGroup } from './groups.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const ID = /^[A-Za-z0-9_.~-]+$/;

class Lru {
  constructor(size) {
    this.size = size;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    this.map.set(key, value);
    if (this.map.size > this.size) this.map.delete(this.map.keys().next().value);
  }
}

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

export function createViewer(roots, { log = () => {}, groupBy = DEFAULT_GROUP_BY } = {}) {
  const runs = new Runs(Array.isArray(roots) ? roots : [roots], { groupBy });
  const docs = new Lru(16);
  const sidecars = new Lru(6);

  /** The run holding trajectory `id`: the one named, else the first whose directory has it. */
  async function locate(id, runId) {
    if (!ID.test(id)) throw new HttpError(400, 'bad trajectory id');
    const candidates = runId ? [runs.get(runId)].filter(Boolean) : [...runs.runs.values()];
    if (runId && !candidates.length) throw new HttpError(404, `unknown run ${runId}`);
    for (const run of candidates) {
      if (run.index.cache.has(id)) return run;
    }
    for (const run of candidates) {
      try {
        await stat(documentPath(run.dir, id));
        return run;
      } catch { /* not here */ }
    }
    throw new HttpError(404, `unknown trajectory ${id}`);
  }

  async function load(id, runId) {
    const run = await locate(id, runId);
    const st = await stat(documentPath(run.dir, id));
    const key = `${run.dir}/${id}:${st.mtimeMs}:${st.size}`;
    let doc = docs.get(key);
    if (!doc) {
      doc = await readDocumentAsync(run.dir, id);
      docs.set(key, doc);
    }
    return { run, doc, key, mtimeMs: st.mtimeMs };
  }

  function tokensOf(run, doc, key) {
    if (!doc.sidecars?.tokens) return null;
    let tokens = sidecars.get(key);
    if (!tokens) {
      tokens = readSidecar(run.dir, doc, 'tokens');
      sidecars.set(key, tokens);
    }
    return tokens;
  }

  async function runList(refresh) {
    if (refresh) runs.discover();
    const data = [...runs.runs.values()].map((run) => runs.entry(run));
    data.sort((a, b) => (b.created_at ?? b.updated_at ?? '').localeCompare(a.created_at ?? a.updated_at ?? '') || a.id.localeCompare(b.id));
    return { data };
  }

  async function runRows(params) {
    const runId = params.get('run_id');
    const selected = runId ? [runs.get(runId)] : [...runs.runs.values()];
    if (runId && !selected[0]) throw new HttpError(404, `unknown run ${runId}`);
    let rows = [];
    for (const run of selected) {
      // A cached index answers at once; `refresh` (the page's poll) rescans, which
      // reads only documents whose mtime or size changed.
      if (!run.index.indexed || params.get('refresh') === 'true') await run.index.refresh();
      const { rows: part } = await run.index.summaries();
      rows = rows.concat(part);
    }
    return { rows, selected };
  }

  /** The rollout filters (everything but `flag`). */
  function filterRows(rows, params) {
    const step = params.get('step');
    const task = params.get('task_id');
    const status = params.get('status');
    const q = params.get('q')?.toLowerCase();
    const annotations = params.getAll('annotation').map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, null] : [pair.slice(0, at), pair.slice(at + 1)];
    });
    return rows.filter((r) =>
      (step == null || step === '' || String(r.step) === step) &&
      (!task || r.task_id === task) &&
      (!status || r.status === status) &&
      annotations.every(([k, v]) => (v === null ? k in (r.annotations ?? {}) : String(r.annotations?.[k]) === v)) &&
      (!q || JSON.stringify([r.id, r.meta, r.annotations]).toLowerCase().includes(q)));
  }

  const hasFilter = (params) => ['step', 'task_id', 'status', 'q', 'annotation'].some((k) => params.get(k));

  async function listing(params) {
    const { rows: all, selected } = await runRows(params);
    let rows = filterRows(all, params);
    const health = runHealth(rows);
    const flag = params.get('flag');
    if (flag) rows = rows.filter((r) => r.summary?.flags.includes(flag));
    const limit = Math.max(1, Math.min(1000, Number(params.get('limit') ?? 100) || 100));
    const offset = Math.max(0, Number(params.get('cursor') ?? 0) || 0);
    const sort = sortOf(params);
    // The index is newest first already; an asked-for sort breaks ties that way too.
    if (sort) rows = [...rows].sort(comparator(rowSortValue, sort, (a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0) || (a.id < b.id ? -1 : 1)));
    const page = rows.slice(offset, offset + limit);
    return {
      data: page,
      next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
      has_more: offset + limit < rows.length,
      total: rows.length,
      indexing: false,
      indexed_trajectories: selected.reduce((s, run) => s + run.index.cache.size, 0),
      health,
      sort: sort ?? { key: 'created', order: 'desc' },
      // Over every rollout the filters list, so a colour means the same on every page.
      reward_range: rewardRange(rows),
    };
  }

  const groupKeys = (params) => (params.get('group_by') ? params.get('group_by').split(',').map((k) => k.trim()).filter(Boolean) : runs.groupBy);

  /** Every group of the selected run(s), summarised, and which rollouts the filters match. */
  async function grouped(params) {
    const { rows: all } = await runRows(params);
    const keys = groupKeys(params);
    const { groups, modal } = groupRows(all, keys);
    const matching = new Set(filterRows(all, params).map((r) => r.id));
    const flag = params.get('flag');
    const flagged = flag && !GROUP_FLAGS.includes(flag) ? new Set(all.filter((r) => r.summary?.flags.includes(flag)).map((r) => r.id)) : null;
    return { keys, modal, groups, matching, flag, flagged, filtered: hasFilter(params) };
  }

  const members = (g) => [...g.counting.map((c) => c.row), ...g.superseded.map((s) => s.row)];

  async function groupListing(params) {
    const { keys, modal, groups, matching, flag, flagged } = await grouped(params);
    // A group matches the rollout filters if any of its rollouts does.
    let list = groups.filter((g) => members(g).some((r) => matching.has(r.id))).map((g) => ({ g, s: summariseGroup(g, modal) }));
    const health = groupHealth(list.map((x) => x.s), FLAG_NAMES);
    if (flag) {
      list = GROUP_FLAGS.includes(flag)
        ? list.filter((x) => x.s.flags.includes(flag))
        : list.filter((x) => members(x.g).some((r) => flagged.has(r.id) && matching.has(r.id)));
    }
    const byDefault = (a, b) => (b.s.step ?? -Infinity) - (a.s.step ?? -Infinity) || String(a.s.task_id).localeCompare(String(b.s.task_id)) || a.s.key.localeCompare(b.s.key);
    const sort = sortOf(params);
    list.sort(sort ? comparator((x, key) => groupSortValue(x.s, key), sort, byDefault) : byDefault);
    const limit = Math.max(1, Math.min(1000, Number(params.get('limit') ?? 100) || 100));
    const offset = Math.max(0, Number(params.get('cursor') ?? 0) || 0);
    const page = list.slice(offset, offset + limit).map(({ g, s }) => ({
      ...s,
      matching: members(g).filter((r) => matching.has(r.id) && (!flagged || flagged.has(r.id))).length,
    }));
    return {
      data: page,
      group_by: keys,
      modal_n: modal,
      sort: sort ?? { key: 'step', order: 'desc' },
      // Over the counting rollouts of every listed group: the colour scale for every page and every expanded group.
      reward_range: rewardRange(list.flatMap((x) => x.g.counting.map((c) => c.row))),
      next_cursor: offset + limit < list.length ? String(offset + limit) : null,
      has_more: offset + limit < list.length,
      total: list.length,
      indexing: false,
      health,
    };
  }

  async function groupDetail(key, params) {
    const { keys, modal, groups, matching, flagged, filtered, flag } = await grouped(params);
    const group = groups.find((g) => g.key === key);
    if (!group) throw new HttpError(404, `no group ${key} for ${keys.join(',')}`);
    const byRep = (a, b) => (typeof a.rep === 'number' && typeof b.rep === 'number' ? a.rep - b.rep : String(a.rep).localeCompare(String(b.rep)));
    // Ranked by reward unless another sort is asked for: the expanded group follows the table's column.
    const sort = sortOf(params) ?? { key: 'reward', order: 'desc' };
    const ranked = [...group.counting].sort(comparator((c, key) => rowSortValue(c.row, key), sort, byRep));
    const isMatch = (r) => matching.has(r.id) && (!flagged || flagged.has(r.id));
    const emphasise = filtered || Boolean(flag && !GROUP_FLAGS.includes(flag));
    return {
      group: summariseGroup(group, modal),
      sort,
      reward_range: rewardRange(group.counting.map((c) => c.row)),
      group_by: keys,
      // Ranked by reward; each counting rollout carries the attempts it superseded.
      rollouts: ranked.map(({ row, rep }) => ({
        ...row,
        repetition_id: rep,
        match: emphasise ? isMatch(row) : null,
        superseded: group.superseded.filter((s) => s.by === row.id).map((s) => ({ ...s.row, repetition_id: rep, superseded_by: row.id, match: emphasise ? isMatch(s.row) : null })),
      })),
    };
  }

  async function api(parts, params) {
    if (parts[0] === 'groups' && parts.length === 1) return groupListing(params);
    if (parts[0] === 'groups' && parts.length === 2) return groupDetail(parts[1], params);
    // parts: after /v1
    if (parts[0] === 'runs' && parts.length === 1) return runList(params.get('refresh') === 'true');
    if (parts[0] !== 'trajectories') throw new HttpError(404, 'not found');
    if (parts.length === 1) return listing(params);
    const id = parts[1];
    const { run, doc, key, mtimeMs } = await load(id, params.get('run_id'));
    if (parts.length === 2) return trajectoryOf(doc, { run: run.id, project: run.project, revision: mtimeMs });
    if (parts.length === 3 && parts[2] === 'paths') {
      const text = params.get('text') !== 'false';
      return pathsOf(doc, text ? tokensOf(run, doc, key) : null, { text });
    }
    if (parts.length === 3 && parts[2] === 'graph') return graphPayload(doc);
    if (parts.length === 3 && parts[2] === 'exchanges') return exchangesOf(doc);
    throw new HttpError(404, 'not found');
  }

  async function serveStatic(pathname, res) {
    const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, relative);
    if (!file.startsWith(PUBLIC)) return send(res, 403, { detail: 'forbidden' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      // Unknown paths fall back to the shell so deep links survive a reload.
      if (extname(relative)) send(res, 404, { detail: 'not found' });
      else serveStatic('/index.html', res);
    }
  }

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const t0 = Date.now();
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { detail: 'read-only' });
      let path = url.pathname;
      if (path === '/__viewer') return send(res, 200, { api: 'records', roots: runs.roots });
      if (path === '/healthz' || path === '/api/healthz') return send(res, 200, { status: 'ok', source: 'record', record: runs.roots.join(' ') });
      if (path.startsWith('/api/')) path = path.slice(4);
      if (path.startsWith('/v1/')) {
        const parts = path.slice(4).split('/').filter(Boolean).map(decodeURIComponent);
        return send(res, 200, await api(parts, url.searchParams));
      }
      return await serveStatic(url.pathname, res);
    } catch (e) {
      const status = e.status ?? (e.code === 'ENOENT' ? 404 : 500);
      return send(res, status, { detail: String(e.message ?? e) });
    } finally {
      log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });
  return { server, runs };
}
