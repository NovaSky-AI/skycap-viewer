// Runs are record directories. The viewer is given one or more paths; each is
// either a record directory (it holds `*.json.zst`) or a parent whose children,
// or grandchildren, are (e.g. /tmp/harbor/runs -> harbor-skycap-*/skycap). A
// parent is rescanned on refresh, so a run that starts writing later appears.

import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { RecordDirectory } from './directory.js';
import { DOC_SUFFIX } from './record.js';
import { pathsOf, trajectoryOf } from './view.js';
import { summarise } from '../public/lib/diagnose.mjs';
import { DEFAULT_GROUP_BY, groupable, groupRows } from './groups.js';

const isRecordDir = (dir) => {
  try {
    return readdirSync(dir).some((name) => name.endsWith(DOC_SUFFIX) && !name.startsWith('.'));
  } catch {
    return false;
  }
};
const subdirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name)).sort();
  } catch {
    return [];
  }
};

/** Record directories under `root`: itself, else children, else grandchildren (two levels). */
export function discover(root) {
  const abs = resolve(root);
  if (isRecordDir(abs)) return [abs];
  const found = [];
  for (const child of subdirs(abs)) {
    if (isRecordDir(child)) found.push(child);
    else for (const grandchild of subdirs(child)) if (isRecordDir(grandchild)) found.push(grandchild);
  }
  return found;
}

/** A run's name: the directory's, or its parent's when the directory is the conventional `skycap/`. */
export const runName = (dir) => (basename(dir) === 'skycap' ? basename(dirname(dir)) : basename(dir));

/** One indexed row: the trajectory, and its summary (flags, sizes, first path's strip) from the document alone. */
export function rowOf(doc, { run, project, mtimeMs }) {
  const trajectory = trajectoryOf(doc, { run, project, revision: mtimeMs });
  const paths = pathsOf(doc, null, { text: false });
  const summary = summarise(paths, trajectory);
  summary.strip = (paths.paths[0]?.blocks ?? []).map(({ kind, token_count, char_count, start, end }) => ({ kind, token_count, char_count, start, end }));
  trajectory.created_ts = doc.created_at ?? 0;
  trajectory.summary = summary;
  return trajectory;
}

export class Runs {
  constructor(roots, { groupBy = DEFAULT_GROUP_BY } = {}) {
    this.roots = roots.map((r) => resolve(r));
    this.groupBy = groupBy;
    /** id -> {id, dir, project, index} */
    this.runs = new Map();
    this.discover();
  }

  discover() {
    const seen = new Set();
    for (const root of this.roots) {
      const project = isRecordDir(root) ? basename(dirname(root)) || root : basename(root) || root;
      for (const dir of discover(root)) {
        let run = [...this.runs.values()].find((r) => r.dir === dir);
        if (!run) {
          let id = runName(dir);
          for (let n = 2; this.runs.has(id); n++) id = `${runName(dir)}~${n}`;
          run = { id, dir, project, index: null };
          run.index = new RecordDirectory(dir, { summarize: (doc, st) => rowOf(doc, { run: run.id, project, mtimeMs: st.mtimeMs }) });
          this.runs.set(id, run);
        }
        seen.add(run.id);
      }
    }
    for (const id of [...this.runs.keys()]) if (!seen.has(id)) this.runs.delete(id);
  }

  get(id) {
    return this.runs.get(id) ?? null;
  }

  /** Index every run in the background, smallest first so the sidebar fills quickly. */
  async warm() {
    const order = [...this.runs.values()].sort((a, b) => fileCount(a.dir) - fileCount(b.dir));
    for (const run of order) await run.index.refresh().catch(() => {});
  }

  /** The `/runs` listing entry. Counts come from the index when it has been read, else from the directory. */
  entry(run) {
    const rows = run.index.indexed ? [...run.index.cache.values()].map((e) => e.summary).filter(Boolean) : null;
    let mtime = 0;
    try {
      mtime = statSync(run.dir).mtimeMs;
    } catch { /* gone */ }
    const out = { id: run.id, project: run.project, path: run.dir, indexing: !run.index.indexed, updated_at: new Date(mtime).toISOString() };
    if (!rows) return { ...out, trajectory_count: fileCount(run.dir), task_count: null, steps: [], step_counts: {} };
    const steps = new Map();
    const tasks = new Map();
    const statuses = {};
    const annotations = {};
    let created = Infinity;
    let tokenizer = null;
    for (const r of rows) {
      if (r.step != null) steps.set(r.step, (steps.get(r.step) ?? 0) + 1);
      if (r.task_id != null) tasks.set(r.task_id, (tasks.get(r.task_id) ?? 0) + 1);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      for (const [key, value] of Object.entries(r.annotations ?? {})) {
        if (value !== null && typeof value === 'object') continue;
        const values = (annotations[key] ??= {});
        const text = String(value);
        if (Object.keys(values).length < 50 || text in values) values[text] = (values[text] ?? 0) + 1;
      }
      if (r.created_ts && r.created_ts < created) created = r.created_ts;
      tokenizer ??= r.tokenizer;
    }
    const stepList = [...steps.keys()].sort((a, b) => a - b);
    const canGroup = groupable(rows, this.groupBy);
    const grouping = canGroup ? groupRows(rows, this.groupBy) : null;
    return {
      ...out,
      created_at: Number.isFinite(created) ? new Date(created * 1000).toISOString() : null,
      trajectory_count: rows.length,
      task_count: tasks.size,
      tasks: [...tasks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, count]) => ({ id, count })),
      steps: stepList,
      step_counts: Object.fromEntries(stepList.map((s) => [String(s), steps.get(s)])),
      statuses,
      annotations,
      upstream: tokenizer ? { model: tokenizer } : null,
      unreadable: [...run.index.cache.values()].filter((e) => e.error).length,
      group_by: this.groupBy,
      groupable: canGroup,
      group_count: grouping ? grouping.groups.length : 0,
      modal_group_size: grouping ? grouping.modal : null,
    };
  }
}

function fileCount(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(DOC_SUFFIX)).length;
  } catch {
    return 0;
  }
}
