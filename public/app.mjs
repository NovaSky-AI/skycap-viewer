/** The shell: routing, loading, and the run page.
 *
 * Ported from inference-capture's viewer. The route lives in the hash so a
 * link to an attempt is a link anyone can paste. `#/run/<run_id>` and
 * `#/run/<run_id>/<trajectory_id>` are the whole routing table. A run is one
 * skycap record directory.
 *
 * What changed from the reference: rows arrive with their flags and mask
 * strip already computed. The reference derived both in the browser, one
 * `/paths` call per row of the page, because its server was a proxy; this
 * server reads the record files itself, so it computes them once per record
 * when it indexes the run -- which also means the health band and the flag
 * filter cover the whole filtered run rather than the page on screen.
 */

import { h, mount } from './lib/dom.mjs';
import { api } from './lib/api.mjs';
import { num, stamp } from './lib/format.mjs';
import { renderSidebar } from './components/sidebar.mjs';
import { renderHealth, renderTable } from './components/table.mjs';
import { Drawer } from './components/drawer.mjs';
import { rowsSignature, runsSignature } from './lib/changed.mjs';

const sidebarEl = document.getElementById('sidebar');
const mainEl = document.getElementById('main');
const drawer = new Drawer(document.getElementById('drawer'), document.getElementById('scrim'));

/** Rows per page. */
const PAGE_SIZE = 100;

const state = {
  runs: [],
  runId: null,
  filter: '',
  rows: [],
  // The run's filters. Each is a query to the server, never a filter over
  // whatever page happened to load.
  step: null,
  task: null,
  status: null,
  annotation: null,
  query: '',
  flag: null,
  health: { scanned: 0, total: 0, counts: [] },
  page: 0,
  cursors: [null],
  total: 0,
  indexing: false,
  hasMore: false,
  loading: false,
  source: { kind: 'down', label: 'connecting', api: '' },
  error: null,
};

drawer.onClose = () => {
  if (state.runId) setRoute(`#/run/${encodeURIComponent(state.runId)}`, true);
};

function setRoute(hash, replace = false) {
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map((part) => decodeURIComponent(part));
  if (parts[0] !== 'run' || !parts[1]) return {};
  return { runId: parts[1], trajectoryId: parts[2] || null };
}

/** Where the records are read from, said plainly. */
async function identify() {
  const viewer = await api.viewer().catch(() => ({ roots: [] }));
  const where = (viewer.roots || []).join(' ');
  try {
    const health = await api.health();
    state.source = { kind: 'record', label: 'skycap records', api: health.record || where };
  } catch {
    state.source = { kind: 'down', label: 'cannot reach the viewer server', api: where };
  }
}

/** What was last drawn, so a poll that changed nothing draws nothing. */
const drawn = { runs: null, rows: null };

function toggleTheme() {
  const root = document.documentElement;
  const current =
    root.dataset.theme ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = current === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {
    /* a private window is not a reason to fail */
  }
}

function drawSidebar() {
  drawn.runs = runsSignature(state.runs);
  renderSidebar(sidebarEl, {
    runs: state.runs,
    active: state.runId,
    source: state.source,
    filter: state.filter,
    onFilter: (value) => {
      state.filter = value;
      drawSidebar();
    },
    onPick: (runId) => setRoute(`#/run/${encodeURIComponent(runId)}`),
    onTheme: toggleTheme,
  });
}

/** How many trajectories sit at a step, from the run summary. */
function stepCount(run, step) {
  if (step === null) return run?.trajectory_count ?? 0;
  return run?.step_counts?.[String(step)] ?? 0;
}

/** The step picker: a slider, because a run has as many steps as it has
 * training steps and a row of two hundred chips is not a control. The leftmost
 * position is "all". Dragging only re-labels; the fetch waits for the release. */
function stepSlider(run, steps) {
  const index = state.step === null ? -1 : steps.indexOf(state.step);
  const describe = (at) => {
    const value = at < 0 ? null : steps[at];
    return value === null
      ? `all steps · ${num(run?.trajectory_count ?? 0)} trajectories`
      : `step ${value} · ${num(stepCount(run, value))} trajectories`;
  };
  const readout = h('span', { class: 'step-readout mono' }, describe(index));
  const slider = h('input', {
    type: 'range',
    id: 'step-slider',
    min: '-1',
    max: String(steps.length - 1),
    step: '1',
    value: String(index),
    'aria-label': 'step',
    oninput: (event) => {
      readout.textContent = describe(Number(event.target.value));
    },
    onchange: (event) => {
      const at = Number(event.target.value);
      refilter({ step: at < 0 ? null : steps[at] });
    },
  });
  return h(
    'div',
    { class: 'steps' },
    h('span', { class: 'label' }, 'step'),
    h('button', { class: `chip${state.step === null ? ' on' : ''}`, onclick: () => refilter({ step: null }) }, h('span', { class: 'n' }, 'all')),
    slider,
    readout
  );
}

/** Task, status, annotation and a text search: the other dimensions of a run.
 *
 * `task` is one dimension among whatever a harness annotates, not an axis
 * (design/run-dimensions.md), so it is a filter like the rest. */
function filterBar(run) {
  const select = (label, value, options, onPick) =>
    h(
      'label',
      { class: 'filter' },
      h('span', { class: 'label' }, label),
      h(
        'select',
        { 'aria-label': label, onchange: (event) => onPick(event.target.value || null) },
        h('option', { value: '' }, 'any'),
        options.map(([key, text]) => h('option', { value: key, selected: key === value }, text))
      )
    );
  const annotationOptions = [];
  for (const [key, values] of Object.entries(run?.annotations || {})) {
    for (const [value, count] of Object.entries(values)) annotationOptions.push([`${key}=${value}`, `${key} = ${value} (${num(count)})`]);
  }
  return h(
    'div',
    { class: 'filters' },
    select('task', state.task, (run?.tasks || []).map((task) => [task.id, `${task.id} (${num(task.count)})`]), (task) => refilter({ task })),
    select('status', state.status, Object.entries(run?.statuses || {}).map(([status, count]) => [status, `${status} (${num(count)})`]), (status) => refilter({ status })),
    select('annotation', state.annotation, annotationOptions, (annotation) => refilter({ annotation })),
    h(
      'label',
      { class: 'filter grow' },
      h('span', { class: 'label' }, 'search'),
      h('input', {
        type: 'search',
        placeholder: 'id, meta, annotations',
        value: state.query,
        onchange: (event) => refilter({ query: event.target.value.trim() }),
      })
    )
  );
}

/** Which page of which filter, and the two buttons that move it. */
function pager() {
  const first = state.rows.length ? state.page * PAGE_SIZE + 1 : 0;
  const last = state.page * PAGE_SIZE + state.rows.length;
  const canPrev = state.page > 0 && !state.loading;
  const canNext = state.hasMore && !state.loading;
  const counted =
    state.total === null || state.total === undefined
      ? `${num(first)}-${num(last)} (indexing...)`
      : `${num(first)}-${num(last)} of ${num(state.total)}`;
  return h(
    'div',
    { class: 'pager' },
    h('button', { class: 'chip', disabled: !canPrev, onclick: () => canPrev && loadPage(state.page - 1) }, '‹ prev'),
    h('span', { class: 'mono' }, state.loading ? 'loading...' : counted),
    h('button', { class: 'chip', disabled: !canNext, onclick: () => canNext && loadPage(state.page + 1) }, 'next ›')
  );
}

/** On a narrow screen the sidebar is hidden, so the run is picked here. */
function runPicker() {
  return h(
    'select',
    { class: 'run-select', 'aria-label': 'run', onchange: (event) => setRoute(`#/run/${encodeURIComponent(event.target.value)}`) },
    state.runs.map((run) => h('option', { value: run.id, selected: run.id === state.runId }, `${run.id} (${num(run.trajectory_count)})`))
  );
}

function scopeText() {
  const parts = [];
  if (state.step !== null) parts.push(`step ${state.step}`);
  if (state.task) parts.push(`task ${state.task}`);
  if (state.status) parts.push(state.status);
  if (state.annotation) parts.push(state.annotation);
  if (state.query) parts.push(`"${state.query}"`);
  return parts.length ? parts.join(' · ') : 'across the run';
}

function drawRun() {
  drawn.rows = rowsSignature(state.rows, state);
  const run = state.runs.find((candidate) => candidate.id === state.runId);
  const steps = run?.steps || [];
  const healthEl = h('div');
  const tableEl = h('div');

  mount(
    mainEl,
    h(
      'div',
      { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', {}, state.runId), h('span', { class: 'crumb' }, run?.project || ''), runPicker()),
      h(
        'div',
        { class: 'page-sub' },
        run
          ? `${num(run.trajectory_count)} trajectories · ${num(run.task_count)} tasks · ` +
            `steps ${run.steps?.length ? `${run.steps[0]}..${run.steps[run.steps.length - 1]}` : '-'} · ` +
            `${stamp(run.created_at)}${run.upstream?.model ? ` · ${run.upstream.model}` : ''}` +
            `${run.unreadable ? ` · ${num(run.unreadable)} unreadable` : ''}`
          : ''
      ),
      h('div', { class: 'page-sub mono dim', title: 'the record directory' }, run?.path || ''),
      // The band counts the whole filtered run, before the flag filter, so a
      // flag's count is how many rows clicking it will list.
      h('h2', { class: 'section' }, `record health · ${scopeText()}`),
      healthEl,
      steps.length > 1 ? stepSlider(run, steps) : null,
      filterBar(run),
      h('h2', { class: 'section' }, [`trajectories · ${scopeText()}`, state.flag ? ` · flagged ${state.flag}` : ''].join('')),
      pager(),
      tableEl
    )
  );

  renderHealth(healthEl, {
    health: state.health,
    active: state.flag,
    onToggle: (flag) => refilter({ flag: state.flag === flag ? null : flag }),
  });
  renderTable(tableEl, { rows: state.rows, selected: drawer.id, onOpen: openTrajectory });
}

/** Change a filter and re-query from the first page. */
function refilter(patch) {
  const changed = Object.entries(patch).some(([key, value]) => state[key] !== value);
  if (!changed) return;
  Object.assign(state, patch);
  // A flag is only meaningful within the filter it was counted under.
  if (!('flag' in patch)) state.flag = null;
  state.cursors = [null];
  loadPage(0);
}

function openTrajectory(trajectoryId) {
  setRoute(`#/run/${encodeURIComponent(state.runId)}/${encodeURIComponent(trajectoryId)}`);
}

function listingParams(extra = {}) {
  return {
    run_id: state.runId,
    step: state.step,
    task_id: state.task,
    status: state.status,
    annotation: state.annotation,
    q: state.query,
    flag: state.flag,
    limit: PAGE_SIZE,
    ...extra,
  };
}

/** Fetch one page of the current run and filters. The cursor is opaque. */
async function loadPage(index, { refresh = false } = {}) {
  const runId = state.runId;
  const cursor = state.cursors[index] ?? null;
  state.loading = true;
  drawRun();
  try {
    const listing = await api.trajectories(listingParams({ cursor, refresh: refresh ? 'true' : null }));
    if (state.runId !== runId) return;
    state.rows = listing.data;
    state.page = index;
    state.hasMore = Boolean(listing.has_more);
    state.indexing = Boolean(listing.indexing);
    state.total = listing.total ?? null;
    state.health = listing.health || { scanned: 0, total: 0, counts: [] };
    if (listing.next_cursor) state.cursors[index + 1] = listing.next_cursor;
    state.loading = false;
    drawRun();
  } catch (error) {
    state.loading = false;
    mount(mainEl, h('div', { class: 'page' }, h('div', { class: 'err' }, String(error.message || error))));
  }
}

async function loadRun(runId) {
  Object.assign(state, {
    runId,
    rows: [],
    step: null,
    task: null,
    status: null,
    annotation: null,
    query: '',
    flag: null,
    page: 0,
    cursors: [null],
    total: 0,
    hasMore: false,
    health: { scanned: 0, total: 0, counts: [] },
  });
  drawSidebar();
  mount(mainEl, h('div', { class: 'page' }, h('div', { class: 'spin' }, 'loading run...')));
  await loadPage(0);
}

async function route() {
  let { runId, trajectoryId } = parseRoute();
  if (!runId) {
    if (!state.runs.length) {
      mount(mainEl, h('div', { class: 'page' }, h('div', { class: 'empty-state' }, 'No skycap records found yet. A run appears here once its directory holds a record.')));
      return;
    }
    // Land on the newest run. `replaceState` fires no `hashchange`, so this
    // falls through to load it.
    runId = state.runs[0].id;
    setRoute(`#/run/${encodeURIComponent(runId)}`, true);
  }
  if (runId !== state.runId) await loadRun(runId);
  if (trajectoryId && drawer.id !== trajectoryId) {
    drawer.runId = runId;
    drawer.open(trajectoryId);
  } else if (!trajectoryId && drawer.id) drawer.close();
  drawSidebar();
}

async function boot() {
  try {
    document.documentElement.dataset.theme = localStorage.getItem('theme') || '';
  } catch {
    /* ignore */
  }
  await identify();
  try {
    state.runs = await api.runs({});
  } catch (error) {
    state.error = error;
  }
  drawSidebar();
  await route();
  window.addEventListener('hashchange', route);
  // A record directory is written while it is read (a trajectory is written
  // when it ends, and a run can still be going), so this polls.
  setInterval(refreshNow, 5000);
}

/** Pick up what has changed: new runs, new trajectories, rewritten records.
 *
 * `refresh` makes the server rescan before answering; it rereads only the
 * documents whose mtime or size changed. Only the first page is refetched --
 * new trajectories sort to the front. */
async function refreshNow() {
  try {
    state.runs = await api.runs({ refresh: 'true' });
    // Redraw only what changed: every draw replaces its container's children,
    // which resets the scroll of whoever is reading it.
    if (runsSignature(state.runs) !== drawn.runs) drawSidebar();
    if (state.runId && state.page === 0) {
      const listing = await api.trajectories(listingParams({ refresh: 'true' }));
      const known = new Set(state.rows.map((row) => row.id));
      const fresh = listing.data.some((row) => !known.has(row.id));
      state.rows = listing.data;
      state.indexing = Boolean(listing.indexing);
      state.total = listing.total ?? null;
      state.hasMore = Boolean(listing.has_more);
      state.health = listing.health || state.health;
      if (fresh) state.cursors = [null];
      if (rowsSignature(state.rows, state) !== drawn.rows) drawRun();
    }
    if (drawer.id) await drawer.reload();
  } catch {
    /* keep what we have; the next tick tries again */
  }
}

// Exported for tests.
export { state };

boot();
