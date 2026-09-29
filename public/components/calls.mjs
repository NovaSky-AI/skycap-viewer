/** The model calls behind the trajectory.
 *
 * Not training data -- this is where you look when the record is fine and the
 * *run* was not: a call that took eight seconds, a generation cut on the token
 * budget, a prompt that was re-rendered instead of extended, a failure the
 * harness swallowed.
 *
 * Ported from inference-capture. A skycap record keeps, per model node, every
 * call that produced it ({t_start, t_end, model, sampling, usage,
 * finish_reason, tools, bridged}) and a list of failures. It has no HTTP
 * status, streaming, TTFT or retry attempt per call, so those columns are gone;
 * `bridged` and the node the call produced are added.
 */

import { h, mount } from '../lib/dom.mjs';
import { num, short } from '../lib/format.mjs';

const ms = (value) => (value === null || value === undefined ? '-' : `${Math.round(value)}`);

export function renderCalls(container, { exchanges }) {
  const rows = exchanges.data || [];
  if (!rows.length) {
    mount(container, h('div', { class: 'empty-state' }, 'No model calls were captured.'));
    return;
  }

  const head = h(
    'tr',
    {},
    h('th', { class: 'n' }, 'seq'),
    h('th', {}, 'kind'),
    h('th', {}, 'node'),
    h('th', {}, 'model'),
    h('th', { class: 'n' }, 'dur ms'),
    h('th', { class: 'n' }, 'prompt'),
    h('th', { class: 'n' }, 'completion'),
    h('th', {}, 'stop'),
    h('th', {}, 'bridged'),
    h('th', {}, 'flags')
  );

  const body = rows.map((row) => {
    const flags = [];
    if (row.kind === 'failure') flags.push(['error', `failed${row.http_status ? ` ${row.http_status}` : ''}: ${row.error}`]);
    if (row.bridged === false) flags.push(['warn', 'unbridged: prompt re-rendered']);
    if (row.bridged === 'absent') flags.push(['info', 'bridged unknown']);
    if (row.completion_reason === 'length') flags.push(['warn', 'truncated']);
    return h(
      'tr',
      { title: row.sampling ? `sampling ${JSON.stringify(row.sampling)}` : row.error || '' },
      h('td', { class: 'n mono' }, row.sequence),
      h('td', { class: 'mono dim' }, row.kind),
      h('td', { class: 'mono dim' }, row.node_id ?? '-'),
      h('td', { class: 'mono dim' }, short(row.model || '-', 22)),
      h('td', { class: 'n mono' }, ms(row.duration_ms)),
      h('td', { class: 'n mono' }, row.usage ? num(row.usage.prompt_tokens) : '-'),
      h('td', { class: 'n mono' }, row.usage ? num(row.usage.completion_tokens) : '-'),
      h('td', { class: 'mono dim' }, row.completion_reason || '-'),
      h('td', { class: `mono ${row.bridged === false ? 'bad' : 'dim'}` }, row.kind === 'call' ? String(row.bridged) : '-'),
      h(
        'td',
        {},
        flags.length
          ? h('span', { class: 'badges' }, flags.map(([level, text]) => h('span', { class: `badge ${level}` }, text)))
          : h('span', { class: 'dim' }, '-')
      )
    );
  });

  mount(container, h('div', { class: 'table-scroll' }, h('table', { class: 'rows' }, h('thead', {}, head), h('tbody', {}, body))));
}
