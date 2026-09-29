/** The shell: routing, loading, and the run page.
 *
 * Ported from inference-capture's viewer. The route lives in the hash so a
 * link is a link anyone can paste. A run is one skycap record directory.
 *
 * What changed from the reference: rows arrive with their flags and mask
 * strip already computed. The reference derived both in the browser, one
 * `/paths` call per row of the page, because its server was a proxy; this
 * server reads the record files itself, so it computes them once per record
 * when it indexes the run -- which also means the health band and the flag
 * filter cover the whole filtered run rather than the page on screen.
 *
 * Groups: a GRPO group is the rollouts of one prompt at one step (keyed by
 * `step` + `instance_id` by default). A run whose records carry the key opens
 * on its groups; the toggle switches to the flat rollout list. A group row
 * expands in place, and several can be open at once.
 *
 *   #/run/<run>[/groups|/rollouts][/<trajectory>][?sort=&order=&open=<key>,<key>]
 *   #/run/<run>/group/<key>[/<trajectory>]      that group, expanded and scrolled to
 *
 * `sort`/`order` are the table's column sort (server-side, since the lists
 * are paged); `open` is the expanded groups.
 */

import { h, mount } from './lib/dom.mjs';
import { api } from './lib/api.mjs';
import { num, stamp } from './lib/format.mjs';
import { renderSidebar } from './components/sidebar.mjs';
import { renderHealth, renderTable } from './components/table.mjs';
import { renderGroups } from './components/groups.mjs';
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
  // 'groups' or 'rollouts'.
  view: 'rollouts',
  // The column sort, or null for the list's default; part of the route.
  sort: null,
  // Expanded groups, by key, and what each one's rollouts are.
  open: new Set(),
  details: new Map(),
  // Where to scroll once drawn (a /group/<key> link).
  scrollTo: null,
  // The run-wide reward range the listing reports, for the colour scale.
  range: null,
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

function currentRun() {
  return state.runs.find((candidate) => candidate.id === state.runId);
}

const defaultView = () => (currentRun()?.groupable ? 'groups' : 'rollouts');

/** The route of what is on the page, optionally with a trajectory open. */
function pageRoute(trajectoryId = null) {
  let path = `#/run/${encodeURIComponent(state.runId)}`;
  if (state.view !== defaultView() || trajectoryId) path += `/${state.view}`;
  if (trajectoryId) path += `/${encodeURIComponent(trajectoryId)}`;
  const query = new URLSearchParams();
  if (state.sort) {
    query.set('sort', state.sort.key);
    query.set('order', state.sort.order);
  }
  if (state.view === 'groups' && state.open.size) query.set('open', [...state.open].join(','));
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

drawer.onClose = () => {
  if (state.runId) setRoute(pageRoute(), true);
};

function setRoute(hash, replace = false) {
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const at = raw.indexOf('?');
  const path = at < 0 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at < 0 ? '' : raw.slice(at + 1));
  const parts = path.split('/').map((part) => decodeURIComponent(part));
  if (parts[0] !== 'run' || !parts[1]) return {};
  const runId = parts[1];
  const sort = query.get('sort') ? { key: query.get('sort'), order: query.get('order') === 'asc' ? 'asc' : 'desc' } : null;
  const open = (query.get('open') || '').split(',').filter(Boolean);
  if (parts[2] === 'group' && parts[3]) {
    return { runId, view: 'groups', sort, open: [...new Set([...open, parts[3]])], scrollTo: parts[3], trajectoryId: parts[4] || null };
  }
  if (parts[2] === 'groups' || parts[2] === 'rollouts') return { runId, view: parts[2], sort, open, trajectoryId: parts[3] || null };
  return { runId, view: null, sort, open, trajectoryId: parts[2] || null };
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

/** The step filter: one entry per step, with its count, and "all". */
function stepSelect(run, steps) {
  return h(
    'label',
    { class: 'filter' },
    h('span', { class: 'label' }, 'step'),
    h(
      'select',
      { 'aria-label': 'step', onchange: (event) => refilter({ step: event.target.value === '' ? null : Number(event.target.value) }) },
      h('option', { value: '' }, `all steps (${num(run?.trajectory_count ?? 0)})`),
      steps.map((step) => h('option', { value: String(step), selected: state.step === step }, `step ${step} (${num(run?.step_counts?.[String(step)] ?? 0)})`))
    )
  );
}

/** Task, status, annotation and a text search: the other dimensions of a run.
 *
 * `task` is one dimension among whatever a harness annotates, not an axis
 * (design/run-dimensions.md), so it is a filter like the rest. */
function filterBar(run, first = null) {
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
    first,
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

/** Groups | Rollouts, when the run's records carry the group key. */
function viewToggle(run) {
  if (!run?.groupable) return null;
  const go = (view) => {
    if (view === state.view) return;
    routeWith({ view, sort: null, open: new Set() });
  };
  return h(
    'div',
    { class: 'view-toggle', role: 'tablist' },
    h('button', { class: `chip${state.view === 'groups' ? ' on' : ''}`, onclick: () => go('groups'), title: `the rollouts of one prompt at one step, keyed by ${(run.group_by || []).join(' + ')}` }, `groups ${num(run.group_count)}`),
    h('button', { class: `chip${state.view === 'rollouts' ? ' on' : ''}`, onclick: () => go('rollouts') }, `rollouts ${num(run.trajectory_count)}`)
  );
}

const hasFilters = () => state.step !== null || state.task || state.status || state.annotation || state.query;

function drawRun() {
  drawn.rows = rowsSignature(state.rows, state);
  const run = currentRun();
  const steps = run?.steps || [];
  const healthEl = h('div');
  const tableEl = h('div');
  const unit = state.view === 'groups' ? 'groups' : 'trajectories';
  // Redrawing replaces #main's children, which would put the reader back at
  // the top -- expanding a group far down the list must not move the list.
  const keep = mainEl.scrollTop || 0;

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
          ? `${num(run.trajectory_count)} trajectories · ${run.groupable ? `${num(run.group_count)} groups of ${num(run.modal_group_size)} · ` : ''}${num(run.task_count)} tasks · ` +
            `steps ${run.steps?.length ? `${run.steps[0]}..${run.steps[run.steps.length - 1]}` : '-'} · ` +
            `${stamp(run.created_at)}${run.upstream?.model ? ` · ${run.upstream.model}` : ''}` +
            `${run.unreadable ? ` · ${num(run.unreadable)} unreadable` : ''}`
          : ''
      ),
      h('div', { class: 'page-sub mono dim', title: 'the record directory' }, run?.path || ''),
      viewToggle(run),
      // The band counts the whole filtered run, before the flag filter, so a
      // flag's count is how many rows clicking it will list.
      h('h2', { class: 'section' }, `record health · ${unit} · ${scopeText()}`),
      healthEl,
      filterBar(run, steps.length > 1 ? stepSelect(run, steps) : null),
      h(
        'h2',
        { class: 'section' },
        [`${unit} · ${scopeText()}`, state.flag ? ` · flagged ${state.flag}` : '', state.view === 'groups' && (hasFilters() || state.flag) ? ' · matching rollouts emphasised when expanded' : ''].join('')
      ),
      pager(),
      tableEl
    )
  );

  renderHealth(healthEl, {
    health: state.health,
    active: state.flag,
    onToggle: (flag) => refilter({ flag: state.flag === flag ? null : flag }),
  });
  const onSort = (sort) => routeWith({ sort });
  if (state.view === 'groups') {
    renderGroups(tableEl, {
      groups: state.rows,
      open: state.open,
      details: state.details,
      range: state.range,
      sort: state.sort,
      onSort,
      onToggle: toggleGroup,
      onOpenRollout: openTrajectory,
      selected: drawer.id,
    });
    // A /group/<key> link: bring that group into view once its rollouts are
    // drawn (drawing them earlier would be undone by the redraw that adds them).
    const detail = state.scrollTo ? state.details.get(state.scrollTo) : null;
    if (state.scrollTo && detail && !detail.loading && typeof tableEl.querySelectorAll === 'function') {
      const target = [...tableEl.querySelectorAll('tr.group-row')].find((tr) => tr.dataset.key === state.scrollTo);
      state.scrollTo = null;
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
    }
  } else {
    renderTable(tableEl, { rows: state.rows, selected: drawer.id, onOpen: openTrajectory, sort: state.sort, onSort, range: state.range });
  }
  if (keep) mainEl.scrollTop = keep;
}

/** Change a filter and re-query from the first page. */
function refilter(patch) {
  const changed = Object.entries(patch).some(([key, value]) => state[key] !== value);
  if (!changed) return;
  Object.assign(state, patch);
  // A flag is only meaningful within the filter it was counted under.
  if (!('flag' in patch)) state.flag = null;
  state.cursors = [null];
  // Expanded groups stay open, re-read under the new filters.
  state.details = new Map();
  loadPage(0);
}

function openTrajectory(trajectoryId) {
  setRoute(pageRoute(trajectoryId));
}

/** Go to the page as it would be with `patch` applied. Only the route changes
 * here: `route` compares it with the state and does the work, so state set
 * before routing would look like nothing changed. */
function routeWith(patch, trajectoryId = null) {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, state[key]]));
  Object.assign(state, patch);
  const hash = pageRoute(trajectoryId);
  Object.assign(state, saved);
  setRoute(hash);
}

/** Expand or collapse a group. */
function toggleGroup(key) {
  const next = new Set(state.open);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  routeWith({ open: next }, drawer.id);
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
    sort: state.sort?.key,
    order: state.sort?.order,
    limit: PAGE_SIZE,
    ...extra,
  };
}

/** Read the rollouts of every open group not yet read, under the current filters and sort. */
async function loadOpenGroups() {
  const runId = state.runId;
  const wanted = [...state.open].filter((key) => !state.details.has(key));
  if (!wanted.length) return;
  for (const key of wanted) state.details.set(key, { loading: true });
  drawRun();
  await Promise.all(
    wanted.map(async (key) => {
      try {
        const detail = await api.group(key, listingParams({ limit: null, cursor: null }));
        if (state.runId === runId) state.details.set(key, detail);
      } catch (error) {
        if (state.runId === runId) state.details.set(key, { error: error.message || String(error) });
      }
    })
  );
  if (state.runId === runId) drawRun();
}

/** Fetch one page of the current run and filters. The cursor is opaque. */
async function loadPage(index, { refresh = false } = {}) {
  const runId = state.runId;
  const view = state.view;
  const cursor = state.cursors[index] ?? null;
  state.loading = true;
  drawRun();
  try {
    const call = view === 'groups' ? api.groups : api.trajectories;
    const listing = await call(listingParams({ cursor, refresh: refresh ? 'true' : null }));
    if (state.runId !== runId || state.view !== view) return;
    state.rows = listing.data;
    state.page = index;
    state.hasMore = Boolean(listing.has_more);
    state.indexing = Boolean(listing.indexing);
    state.total = listing.total ?? null;
    state.health = listing.health || { scanned: 0, total: 0, counts: [] };
    state.range = listing.reward_range ?? null;
    if (listing.next_cursor) state.cursors[index + 1] = listing.next_cursor;
    state.loading = false;
    drawRun();
    if (view === 'groups') await loadOpenGroups();
  } catch (error) {
    state.loading = false;
    mount(mainEl, h('div', { class: 'page' }, h('div', { class: 'err' }, String(error.message || error))));
  }
}

function resetFilters() {
  Object.assign(state, {
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
    open: new Set(),
    details: new Map(),
    range: null,
    health: { scanned: 0, total: 0, counts: [] },
  });
}

const sameSort = (a, b) => (a?.key ?? null) === (b?.key ?? null) && (a?.order ?? null) === (b?.order ?? null);

async function route() {
  let { runId, view, sort = null, open = [], scrollTo = null, trajectoryId } = parseRoute();
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
  if (runId !== state.runId) {
    state.runId = runId;
    resetFilters();
    // Whether a run has groups is known once it is indexed; a listing indexes it.
    if (currentRun()?.indexing && !view) {
      mount(mainEl, h('div', { class: 'page' }, h('div', { class: 'spin' }, 'indexing run...')));
      try {
        await api.trajectories({ run_id: runId, limit: 1 });
        state.runs = await api.runs({});
      } catch {
        /* the listing below reports it */
      }
    }
    state.view = view || defaultView();
    state.sort = sort;
    state.open = new Set(open);
    state.scrollTo = scrollTo;
    drawSidebar();
    await loadPage(0);
  } else {
    const nextView = view || defaultView();
    if (nextView !== state.view || !sameSort(sort, state.sort)) {
      if (nextView !== state.view) state.flag = null;
      state.view = nextView;
      state.sort = sort;
      state.page = 0;
      state.cursors = [null];
      state.rows = [];
      // A new sort re-orders the open groups' rollouts too.
      state.details = new Map();
      state.open = new Set(open);
      state.scrollTo = scrollTo;
      await loadPage(0);
    } else {
      const next = new Set(open);
      const changed = next.size !== state.open.size || [...next].some((key) => !state.open.has(key));
      state.open = next;
      if (scrollTo) state.scrollTo = scrollTo;
      if (changed || scrollTo) {
        drawRun();
        await loadOpenGroups();
      }
    }
  }
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
      const call = state.view === 'groups' ? api.groups : api.trajectories;
      const listing = await call(listingParams({ refresh: 'true' }));
      const known = new Set(state.rows.map((row) => row.id ?? row.key));
      const fresh = listing.data.some((row) => !known.has(row.id ?? row.key));
      state.rows = listing.data;
      state.indexing = Boolean(listing.indexing);
      state.total = listing.total ?? null;
      state.hasMore = Boolean(listing.has_more);
      state.health = listing.health || state.health;
      state.range = listing.reward_range ?? state.range;
      if (fresh) state.cursors = [null];
      if (rowsSignature(state.rows, state) !== drawn.rows) drawRun();
    }
    if (drawer.id) await drawer.reload();
  } catch {
    /* keep what we have; the next tick tries again */
  }
}

// Exported for tests.
export { state, parseRoute, pageRoute, toggleGroup };

boot();
