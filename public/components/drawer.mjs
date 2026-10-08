/** The right-hand drawer: one trajectory, in depth.
 *
 * A drawer rather than a page because the question being asked is nearly
 * always comparative -- *this* attempt against the others in its run -- and
 * navigating away to answer it loses the place you were looking from.
 */

import { h, mount, copy } from '../lib/dom.mjs';
import { api } from '../lib/api.mjs';
import { num, pct, stamp } from '../lib/format.mjs';
import { flagLevel, flagWhy, summarise } from '../lib/diagnose.mjs';
import { renderPath } from './path.mjs';
import { renderTree } from './tree.mjs';
import { renderCalls } from './calls.mjs';
import { renderForks } from './forks.mjs';
import { trajectorySignature } from '../lib/changed.mjs';

/** What the drawer says about the record's completeness, above the tabs.
 *  A missing tokens sidecar is a warning (message text only); missing experts or
 *  sampling_mask are not mentioned here: they are listed in the JSON tab's missing_sidecars. */
export function recordNotes(trajectory) {
  if (!trajectory) return [];
  const notes = [];
  if ((trajectory.missing_sidecars || []).includes('tokens')) {
    notes.push(h('div', { class: 'note warn-text', title: 'format.md: a listed sidecar whose file is missing is read as absent' }, 'tokens sidecar missing: showing message text only.'));
  }
  for (const problem of trajectory.record_problems || []) {
    notes.push(h('div', { class: 'err' }, `Malformed record: ${problem}.`));
  }
  return notes;
}

const TABS = [
  ['path', 'Path'],
  ['tree', 'Tree'],
  ['forks', 'Forks'],
  ['calls', 'Calls'],
  ['json', 'JSON'],
];

export class Drawer {
  constructor(root, scrim) {
    this.root = root;
    this.scrim = scrim;
    this.state = {
      tab: 'path',
      pathIndex: 0,
      showGiven: true,
      showControls: false,
      showLogprobs: false,
      // Which node is open in the tree, by id.
      openNode: null,
      // The two paths the Forks tab compares.
      forkLeft: 0,
      forkRight: 1,
    };
    // Which run (record directory) the open trajectory is read from.
    this.runId = null;
    this.cache = new Map();
    this.id = null;

    scrim.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
    this.installResize();
  }

  installResize() {
    const grip = h('div', { class: 'grip', title: 'drag to resize' });
    this.root.appendChild(grip);
    let dragging = false;
    grip.addEventListener('mousedown', (event) => {
      dragging = true;
      event.preventDefault();
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const width = Math.min(window.innerWidth - 200, Math.max(420, window.innerWidth - event.clientX));
      this.root.style.width = `${width}px`;
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      document.body.style.userSelect = '';
    });
  }

  close() {
    this.id = null;
    this.root.classList.remove('open');
    this.scrim.classList.remove('open');
    if (this.onClose) this.onClose();
  }

  async open(trajectoryId) {
    this.id = trajectoryId;
    this.state.pathIndex = 0;
    this.state.openNode = null;
    this.state.forkLeft = 0;
    this.state.forkRight = 1;
    this.root.classList.add('open');
    this.scrim.classList.add('open');
    this.render({ loading: true });
    try {
      const bundle = await this.load(trajectoryId);
      if (this.id !== trajectoryId) return;
      this.render(bundle);
    } catch (error) {
      if (this.id !== trajectoryId) return;
      this.render({ error });
    }
  }

  /** Re-read the open trajectory.
   *
   * A trajectory being watched is usually one still running, so the drawer is
   * the first place a new turn should appear. The cache is what makes tab
   * switching instant; a refresh is the one thing that must go past it.
   */
  async reload() {
    if (!this.id) return;
    const trajectoryId = this.id;
    this.cache.delete(trajectoryId);
    try {
      const bundle = await this.load(trajectoryId);
      if (this.id !== trajectoryId) return;
      // Only re-render when the trajectory actually changed. A finished one
      // never will, and somebody reading it is the common case -- rebuilding
      // the drawer under them every poll threw away where they were on the
      // page and, in the tree, which node they had open.
      if (trajectorySignature(bundle) === this.signature) return;
      this.render(bundle);
    } catch {
      /* keep what is on screen; the next tick tries again */
    }
  }

  async load(trajectoryId) {
    if (this.cache.has(trajectoryId)) return this.cache.get(trajectoryId);
    const runId = this.runId;
    const [trajectory, paths, graph, exchanges] = await Promise.all([
      api.trajectory(trajectoryId, runId),
      api.paths(trajectoryId, { run_id: runId }),
      api.graph(trajectoryId, runId),
      api.exchanges(trajectoryId, runId),
    ]);
    const bundle = { trajectory, paths, graph, exchanges };
    this.cache.set(trajectoryId, bundle);
    // A bundle holds every path's decoded text; a long browsing session should not keep them all.
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return bundle;
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.render(this.cache.get(this.id) || {});
  }

  render(bundle) {
    const { trajectory, paths, graph, exchanges, loading, error } = bundle;
    // A new turn landing on a trajectory being watched is a real reason to
    // rebuild this. Losing the reader's place in a long path is not, so the
    // scroll offset is carried across -- but only when it is the same tab of
    // the same trajectory, since anything else should start at the top.
    const same = this.renderedTab === this.state.tab && this.renderedId === this.id;
    const keep = same && this.bodyEl ? this.bodyEl.scrollTop || 0 : 0;
    this.renderedTab = this.state.tab;
    this.renderedId = this.id;
    this.signature = trajectorySignature(bundle);
    const summary = paths && trajectory ? summarise(paths, trajectory) : null;
    const body = h('div', { class: 'drawer-body' });
    this.bodyEl = body;

    mount(
      this.root,
      h('div', { class: 'grip', title: 'drag to resize' }),
      h(
        'div',
        { class: 'drawer-head' },
        h(
          'div',
          { class: 'drawer-title' },
          h('span', { class: 'id' }, this.id || ''),
          h(
            'button',
            {
              class: 'icon-btn',
              onclick: (event) => copy(this.id, event.currentTarget),
            },
            'copy id'
          ),
          h('span', { class: 'spacer' }),
          h('button', { class: 'icon-btn', onclick: () => this.close() }, 'close  esc')
        ),
        trajectory
          ? h(
              'div',
              { class: 'drawer-meta' },
              h('span', {}, 'mode ', h('b', {}, trajectory.mode)),
              h('span', {}, 'status ', h('b', {}, trajectory.status)),
              trajectory.task_id ? h('span', {}, 'task ', h('b', {}, trajectory.task_id)) : null,
              trajectory.step !== null && trajectory.step !== undefined
                ? h('span', {}, 'step ', h('b', {}, trajectory.step))
                : null,
              summary
                ? h(
                    'span',
                    {},
                    'trainable ',
                    h('b', {}, `${num(summary.trainable)}/${num(summary.tokens)}`),
                    ` ${pct(summary.trainable, summary.tokens)}`
                  )
                : null,
              paths?.tokenizer ? h('span', {}, 'tokenizer ', h('b', {}, paths.tokenizer)) : null,
              trajectory.capture?.engine ? h('span', {}, 'engine ', h('b', {}, trajectory.capture.engine)) : null,
              trajectory.capture?.logprobs_mode ? h('span', {}, 'logprobs ', h('b', {}, trajectory.capture.logprobs_mode)) : null,
              h('span', {}, 'calls ', h('b', {}, num(trajectory.capture?.exchange_count ?? 0)),
                trajectory.skycap ? ` · bridged ${['true', 'false', 'null', 'absent'].filter((k) => trajectory.skycap.bridged[k]).map((k) => `${k}=${trajectory.skycap.bridged[k]}`).join(' ') || '-'}` : ''),
              typeof trajectory.annotations?.reward === 'number' ? h('span', {}, 'reward ', h('b', {}, trajectory.annotations.reward)) : null,
              h('span', {}, stamp(trajectory.created_at))
            )
          : null,
        recordNotes(trajectory),
        summary && summary.flags.length
          ? h(
              'div',
              { class: 'badges', style: { marginBottom: '10px' } },
              summary.flags.map((flag) =>
                h('span', { class: `badge ${flagLevel(flag)}`, title: flagWhy(flag) }, flag)
              )
            )
          : null,
        h(
          'div',
          { class: 'tabs' },
          TABS.map(([key, label]) =>
            h(
              'button',
              {
                class: this.state.tab === key ? 'on' : '',
                onclick: () => this.setState({ tab: key }),
              },
              label,
              (key === 'tree' || key === 'forks') && paths?.paths?.length > 1
                ? h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, paths.paths.length)
                : null
            )
          )
        )
      ),
      body
    );

    if (loading) {
      mount(body, h('div', { class: 'spin', style: { padding: '30px 0' } }, 'loading...'));
      return;
    }
    if (error) {
      mount(body, h('div', { class: 'err' }, String(error.message || error)));
      return;
    }
    if (!trajectory) return;
    // Restored once the tab below has filled `body`, so there is something to
    // scroll. Clamped by the browser if the content got shorter.
    if (keep) queueMicrotask(() => { body.scrollTop = keep; });

    const onState = (patch) => this.setState(patch);
    if (this.state.tab === 'path') renderPath(body, { data: paths, state: this.state, onState });
    else if (this.state.tab === 'tree') renderTree(body, { graph, paths, state: this.state, onState });
    else if (this.state.tab === 'forks') renderForks(body, { paths, graph, state: this.state, onState });
    else if (this.state.tab === 'calls') renderCalls(body, { exchanges });
    else {
      mount(
        body,
        h(
          'div',
          { class: 'toolbar' },
          h(
            'button',
            {
              class: 'icon-btn',
              onclick: (event) =>
                copy(JSON.stringify({ trajectory, paths, graph }, null, 2), event.currentTarget),
            },
            'copy all'
          )
        ),
        h('pre', { class: 'json' }, JSON.stringify({ trajectory, paths, graph }, null, 2))
      );
    }
  }
}
