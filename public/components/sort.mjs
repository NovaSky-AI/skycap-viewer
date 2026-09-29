/** Clickable column headers: click to sort by a column, again to flip it.
 *
 * Sorting is the server's (`sort=` / `order=` on the listing), because the
 * lists are paged and a sort over one page is a sort of nothing. The sort
 * lives in the hash, so a link or a reload keeps it. */

import { h } from '../lib/dom.mjs';

/** The first order a column sorts in: text ascending, numbers largest first. */
export const firstOrder = (key) => (key === 'task' ? 'asc' : 'desc');

/** The sort a click on `key` gives, from the current one. */
export function nextSort(current, key) {
  if (current && current.key === key) return { key, order: current.order === 'asc' ? 'desc' : 'asc' };
  return { key, order: firstOrder(key) };
}

/** `columns`: [{label, sort?, numeric?, title?}] -- a column without `sort` is not clickable. */
export function sortHeader(columns, sort, onSort) {
  return h(
    'tr',
    {},
    columns.map((column) => {
      if (!column.sort) return h('th', { class: column.numeric ? 'n' : '' }, column.label);
      const on = sort && sort.key === column.sort;
      return h(
        'th',
        {
          class: `sortable${on ? ' sorted' : ''}${column.numeric ? ' n' : ''}`,
          'aria-sort': on ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none',
          title: `${column.title ? `${column.title}. ` : ''}Click to sort${on ? `; again to flip` : ''}.`,
          onclick: (event) => {
            event.stopPropagation?.();
            onSort(nextSort(sort, column.sort));
          },
        },
        column.label,
        h('span', { class: 'sort-mark' }, on ? (sort.order === 'asc' ? ' ▲' : ' ▼') : ' ↕')
      );
    })
  );
}
