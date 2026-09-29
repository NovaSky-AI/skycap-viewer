/** GRPO groups: the rollouts of one prompt at one step, expanded in place.
 *
 * One table, one column set, two levels. A group row and each rollout row
 * under it share the same six columns, and each cell means something at both:
 *
 *   step · task / rollout · rewards · turns · tokens · health
 *
 * A group's `rewards` are one dot per rollout (repetition order); a rollout's
 * is its own dot and value. Colours are a continuous red -> green scale over
 * the run-wide reward range the server sends with the listing, so a colour
 * means one reward in every group. No mean, no advantage, no pass rate --
 * the viewer's job stops at *is this record right*.
 *
 * Clicking a group row expands its rollouts beneath it (several can be open);
 * clicking again collapses it. Clicking a rollout opens the drawer.
 */

import { h, mount } from '../lib/dom.mjs';
import { num, short, rewardColor, formatReward, rangeText } from '../lib/format.mjs';
import { FLAG_NAMES, flagLevel, flagWhy } from '../lib/diagnose.mjs';
import { sortHeader } from './sort.mjs';

/** Flags true of every rollout of a run carry nothing per row (see table.mjs). */
const QUIET = new Set(['bridged-unknown']);
const order = (a, b) => FLAG_NAMES.indexOf(a) - FLAG_NAMES.indexOf(b);

/** The column set both levels share, and which sort key each header sets. */
export const GROUP_COLUMNS = [
  { id: 'step', label: 'step', sort: 'step', numeric: true },
  { id: 'item', label: 'task / rollout', sort: 'task' },
  { id: 'rewards', label: 'rewards', sort: 'reward', title: 'groups order by their rollouts\' mean reward; the mean itself is not shown' },
  { id: 'turns', label: 'turns', sort: 'turns', numeric: true },
  { id: 'tokens', label: 'tokens', sort: 'tokens', numeric: true },
  { id: 'health', label: 'health', sort: 'health' },
];

function dot(reward, range, title) {
  const { css } = rewardColor(reward, range);
  return h('span', { class: `dot${css ? '' : ' none'}`, style: css ? { background: css } : null, title });
}

/** One dot per rollout, in repetition order, coloured by reward. */
export function rewardDots(group, range) {
  return h(
    'span',
    { class: 'dots', title: `one dot per rollout, in repetition order. ${rangeText(range)}` },
    group.rewards.map((r) =>
      dot(r.reward, range, `rep ${r.repetition_id}${r.attempt ? ` · attempt ${r.attempt}` : ''} · reward ${formatReward(r.reward)}${r.stop_reason ? ` · ${r.stop_reason}` : ''}`)
    )
  );
}

/** A rollout's reward: its dot and its value, the value in the same colour. */
export function rewardCell(reward, range) {
  const { css } = rewardColor(reward, range);
  return h(
    'span',
    { class: 'reward', title: rangeText(range) },
    dot(reward, range, `reward ${formatReward(reward)}`),
    h('span', { class: 'mono value', style: css ? { color: css } : null }, formatReward(reward))
  );
}

/** A group's health, rolled up: its group flags, then "2 forked, 1 truncated". */
export function healthSummary(group) {
  const flags = [...group.flags].sort(order);
  const rolled = Object.entries(group.rollup || {})
    .filter(([flag]) => !QUIET.has(flag))
    .sort((a, b) => order(a[0], b[0]))
    .map(([flag, count]) => `${num(count)} ${flag}`);
  if (!flags.length && !rolled.length) return h('span', { class: 'dim' }, '-');
  return h(
    'span',
    { class: 'badges' },
    flags.map((flag) => h('span', { class: `badge ${flagLevel(flag)}`, title: flagWhy(flag) }, flag)),
    rolled.length ? h('span', { class: 'dim mono rollup', title: 'rollouts in this group carrying each flag' }, rolled.join(', ')) : null
  );
}

function rolloutFlags(row) {
  const flags = (row.summary?.flags || []).filter((flag) => !QUIET.has(flag));
  if (!flags.length) return h('span', { class: 'dim' }, '-');
  return h('span', { class: 'badges' }, flags.map((flag) => h('span', { class: `badge ${flagLevel(flag)}`, title: flagWhy(flag) }, flag)));
}

const range2 = (pair) => (!pair ? '-' : pair[0] === pair[1] ? num(pair[0]) : `${num(pair[0])}–${num(pair[1])}`);

function groupRow(group, { open, range, onToggle }) {
  return h(
    'tr',
    {
      class: `group-row${open ? ' open' : ''}`,
      dataset: { key: group.key },
      onclick: () => onToggle(group.key),
      title: `group ${group.key} · ${num(group.n)} rollouts${group.superseded_count ? `, ${num(group.superseded_count)} superseded attempts` : ''} · click to ${open ? 'collapse' : 'expand'}`,
    },
    h('td', { class: 'n mono' }, group.step ?? '-'),
    h(
      'td',
      { class: 'mono item' },
      h('span', { class: 'caret' }, open ? '▾' : '▸'),
      group.task_id || '-',
      group.flags.includes('short') ? h('span', { class: 'dim warn-text', title: `the run's usual group has ${group.modal_n}` }, ` · ${num(group.n)} of ${num(group.modal_n)}`) : null
    ),
    h('td', { class: 'dots-cell' }, rewardDots(group, range)),
    h('td', { class: 'n mono dim' }, range2(group.turns)),
    h('td', { class: 'n mono dim' }, range2(group.tokens)),
    h('td', {}, healthSummary(group))
  );
}

function rolloutRow(row, { range, selected, onOpenRollout }) {
  const classes = ['rollout-row', row.id === selected ? 'active' : '', row.match === false ? 'unmatched' : '', row.match === true ? 'matched' : '', row.superseded_by ? 'superseded' : ''];
  return h(
    'tr',
    {
      class: classes.filter(Boolean).join(' '),
      dataset: { id: row.id },
      onclick: (event) => {
        event.stopPropagation?.();
        onOpenRollout(row.id);
      },
      title: row.superseded_by ? `superseded by ${row.superseded_by}: a later attempt of this repetition counts` : `${row.id} · click to open`,
    },
    h('td', { class: 'n mono dim' }, row.step ?? '-'),
    h(
      'td',
      { class: 'mono item nested' },
      h('span', { class: 'dim' }, `${row.superseded_by ? '↳ ' : ''}rep ${row.repetition_id ?? '-'}${row.meta?.attempt ? ` · a${row.meta.attempt}` : ''} · `),
      short(row.id, 10)
    ),
    h('td', {}, rewardCell(row.annotations?.reward, range)),
    h('td', { class: 'n mono dim' }, num(row.capture?.exchange_count ?? 0)),
    h('td', { class: 'n mono dim' }, num(row.summary?.tokens ?? 0)),
    h('td', {}, rolloutFlags(row))
  );
}

/** The groups table, with any open groups' rollouts beneath their rows. */
export function renderGroups(container, { groups, open = new Set(), details = new Map(), range = null, sort = null, onSort = () => {}, onToggle = () => {}, onOpenRollout = () => {}, selected = null }) {
  if (!groups.length) {
    mount(container, h('div', { class: 'empty-state' }, 'No groups match.'));
    return;
  }
  const body = [];
  for (const group of groups) {
    const isOpen = open.has(group.key);
    body.push(groupRow(group, { open: isOpen, range, onToggle }));
    if (!isOpen) continue;
    const detail = details.get(group.key);
    if (!detail || detail.loading) {
      body.push(h('tr', { class: 'rollout-row note-row' }, h('td', { colspan: String(GROUP_COLUMNS.length), class: 'spin' }, 'loading rollouts...')));
      continue;
    }
    if (detail.error) {
      body.push(h('tr', { class: 'rollout-row note-row' }, h('td', { colspan: String(GROUP_COLUMNS.length), class: 'err' }, String(detail.error))));
      continue;
    }
    // Each counting rollout, then the attempts it superseded, greyed.
    for (const row of detail.rollouts) {
      body.push(rolloutRow(row, { range, selected, onOpenRollout }));
      for (const old of row.superseded || []) body.push(rolloutRow(old, { range, selected, onOpenRollout }));
    }
  }
  mount(
    container,
    h('div', { class: 'legend reward-legend' }, h('span', { class: 'ramp' }), rangeText(range)),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'rows groups' },
        h('colgroup', {}, GROUP_COLUMNS.map((column) => h('col', { class: `col-${column.id}` }))),
        h('thead', {}, sortHeader(GROUP_COLUMNS, sort, onSort)),
        h('tbody', {}, body)
      )
    )
  );
}
