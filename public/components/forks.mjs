/** Two paths, compared from the last node they agree on.
 *
 * The tree says *that* there was a branch; this says *where* the histories
 * stopped matching, which is the harness's behaviour and regularly a surprise
 * to whoever wrote it. Pick two paths: everything they share is dimmed and
 * folded, the last shared node is named, and what each has after it sits side
 * by side.
 *
 * It also runs the train-once check over every path, which only a view
 * holding the paths in the plural can: each model node must be in the loss on
 * exactly one path. skycap builds its rows so that it is, and this is where
 * that is verified rather than assumed.
 *
 * The tree also reads a fork, at the node; this reads two whole rows against
 * each other.
 */

import { h, mount } from '../lib/dom.mjs';
import { num } from '../lib/format.mjs';
import { divergence, trainOnce } from '../lib/diagnose.mjs';
import { blockRow } from './path.mjs';
import { strip } from './strip.mjs';

function picker(paths, value, onPick, label) {
  return h(
    'label',
    {},
    `${label} `,
    h(
      'select',
      { onchange: (event) => onPick(Number(event.target.value)), 'aria-label': label },
      paths.map((path, index) =>
        h('option', { value: String(index), selected: index === value }, `path ${index} → ${path.leaf_node_id}`)
      )
    )
  );
}

/** The train-once statement, said either way. */
export function trainOnceNote(paths, graph) {
  const { through, violations } = trainOnce(paths);
  if (violations.length) {
    return h(
      'div',
      { class: 'split', style: { borderColor: 'var(--error)', color: 'var(--error)' } },
      `Train-once violated: ${violations.map(([id, entry]) => `${id} is trained in ${entry.trains.length} paths`).join('; ')}.`
    );
  }
  const model = (graph?.nodes || []).filter((node) => node.author === 'model' && node.token_count !== 0);
  const untrained = model.filter((node) => !(through.get(node.node_id)?.trains.length));
  if (untrained.length && paths.some((path) => path.blocks?.some((b) => b.token_count !== undefined))) {
    return h(
      'div',
      { class: 'split' },
      `Train-once holds, but ${untrained.map((node) => node.node_id).join(', ')} ${untrained.length === 1 ? 'is' : 'are'} trained in no path.`
    );
  }
  return h('div', { class: 'note' }, `Train-once holds: each of the ${num(model.length)} model nodes is in the loss on exactly one of the ${num(paths.length)} paths.`);
}

export function renderForks(container, { paths: data, graph, state, onState }) {
  const paths = data?.paths || [];
  if (paths.length < 2) {
    mount(container, h('div', { class: 'empty-state' }, 'One path: this trajectory never forked, so there is nothing to compare.'), paths.length ? trainOnceNote(paths, graph) : null);
    return;
  }
  const left = Math.min(state.forkLeft ?? 0, paths.length - 1);
  const right = Math.min(state.forkRight ?? 1, paths.length - 1);
  const a = paths[left];
  const b = paths[right];
  const split = divergence(a, b);
  const shared = new Set(split.shared_node_ids);
  const nodes = new Map((graph?.nodes || []).map((node) => [node.node_id, node]));
  const last = split.last_common ? nodes.get(split.last_common) : null;
  const sharedBlocks = (a.blocks || []).filter((block) => shared.has(block.node_id));
  const sharedTokens = sharedBlocks.reduce((sum, block) => sum + (block.token_count || block.char_count || 0), 0);
  const unit = data.mode === 'tokens' ? 'tokens' : 'chars';
  const column = (path, index) => {
    const rest = (path.blocks || []).filter((block) => !shared.has(block.node_id));
    return h(
      'div',
      { class: 'continuation' },
      h('div', { class: 'panel-head' }, h('span', { class: 'badge kind-sampled' }, `path ${index}`), h('span', { class: 'range' }, `${num(rest.length)} blocks after the split`)),
      strip(rest),
      rest.length
        ? rest.map((block) => blockRow(block, { path, showLogprobs: false, showControls: false }))
        : h('div', { class: 'note' }, 'Nothing after the shared prefix: this path is a prefix of the other.')
    );
  };

  mount(
    container,
    h(
      'div',
      { class: 'toolbar' },
      picker(paths, left, (index) => onState({ forkLeft: index }), 'left'),
      picker(paths, right, (index) => onState({ forkRight: index }), 'right')
    ),
    left === right
      ? h('div', { class: 'note' }, 'The same path on both sides. Pick two different ones.')
      : h(
          'div',
          { class: 'split' },
          split.shared_nodes
            ? `They agree on ${num(split.shared_nodes)} nodes (${num(sharedTokens)} ${unit}), up to ${split.last_common}` +
                `${last ? ` (${last.role || '?'}, ${last.author})` : ''}. Then path ${left} has ${num(split.left_only.length)} nodes ` +
                `from ${split.left_only[0] ?? '-'} and path ${right} has ${num(split.right_only.length)} from ${split.right_only[0] ?? '-'}.`
            : `They share nothing: path ${left} and path ${right} start at different roots.`
        ),
    trainOnceNote(paths, graph),
    // Everything before the last common node is folded; the node itself is
    // shown, dimmed, because it is what both continuations answer.
    sharedBlocks.length
      ? h(
          'div',
          { class: 'shared-prefix agreed' },
          h('div', { class: 'note' }, `shared prefix: ${num(sharedBlocks.length)} blocks, ${num(sharedTokens)} ${unit}; the last common node:`),
          sharedBlocks.filter((block) => block.node_id === split.last_common).map((block) => blockRow(block, { path: a, showLogprobs: false, showControls: false }))
        )
      : null,
    left === right ? null : h('div', { class: 'forks side-by-side' }, column(a, left), column(b, right))
  );
}
