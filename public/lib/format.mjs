/** Formatting, and the vocabulary the whole viewer shares. */

/** The four kinds, in the order a path presents them, and skycap's one
 *  qualifier. `trainable` is a boolean and the useful classification is not.
 *
 *  `sampled-elsewhere` is skycap's train-once rule made visible: the model did
 *  sample these tokens, but skycap trains each model node on exactly one path
 *  (the first that contains it), so on every later path they are loss-masked
 *  context. Calling them `sampled` would claim a second training; calling them
 *  `replayed` would deny the model wrote them. */
export const KINDS = ['sampled', 'sampled-elsewhere', 'replayed', 'scaffold', 'given'];

export const KIND_TITLE = {
  sampled: 'the model produced it and it is in the loss',
  replayed: 'assistant text the model did not produce -- looks like output, is not',
  scaffold: "the template's generation prefix inside an assistant turn",
  given: 'user messages, tool results, system prompt',
  'sampled-elsewhere': 'the model produced it, but it is trained on another path (skycap trains each model node once): masked here',
};

export const num = (value) =>
  value === null || value === undefined ? '-' : value.toLocaleString('en-US');

export function pct(part, whole) {
  if (!whole) return '-';
  return `${Math.round((100 * part) / whole)}%`;
}

export function ago(iso) {
  if (!iso) return '-';
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return '-';
  const steps = [[60, 's'], [60, 'm'], [24, 'h'], [365, 'd']];
  let value = Math.max(0, seconds);
  let unit = 's';
  for (const [size, name] of steps) {
    if (value < size) { unit = name; break; }
    value /= size;
    unit = name;
  }
  return `${Math.round(value)}${unit} ago`;
}

export const stamp = (iso) => (iso ? new Date(iso).toLocaleString() : '-');

/** Render control characters so a boundary bug is visible rather than
 *  invisible. Special tokens stay literal; this keeps `\n` literal too,
 *  because a missing newline is the same class of bug and reads as nothing. */
export function visible(text) {
  return text.replace(/\n/g, '↵\n').replace(/\t/g, '→\t');
}

export const short = (id, keep = 8) =>
  !id ? '-' : id.length <= keep + 4 ? id : `${id.slice(0, keep)}…${id.slice(-4)}`;
