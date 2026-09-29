/** What would make a view render differently.
 *
 * The viewer polls its source every few seconds, because a record directory is
 * written to while it is being read. Every draw replaces its container's
 * children, and replacing the children of a scrolling element puts the reader
 * back at the top of it -- so a poll that redraws unconditionally takes away
 * someone's place in a long trajectory every five seconds.
 *
 * Most polls change nothing. These reduce a response to the fields a view
 * actually shows, so an unchanged one can be recognised and not drawn.
 * Deliberately shallow: comparing every token array of every path on every
 * poll would cost more than the render it saves, and nothing in these views
 * can change without one of these fields changing too.
 */

/** The run list in the sidebar. */
export const runsSignature = (runs) =>
  (runs || []).map((run) => `${run.id}:${run.project}:${run.trajectory_count}`).join('|');

/** The trajectory table. `indexing` and `total` are here because the pager
 * prints them, and `summary` because a scanned row gains its flags late. */
export const rowsSignature = (rows, view) =>
  [
    view.indexing,
    view.total,
    JSON.stringify(view.health?.counts ?? null),
    ...(rows || []).map(
      // A rollout row, or a group row (which has a key, not an id).
      (row) =>
        row.key !== undefined && row.id === undefined
          ? `${row.key}:${row.n}:${row.flags?.join(',')}:${(row.rewards || []).map((r) => `${r.id}=${r.reward}`).join(',')}`
          : `${row.id}:${row.status}:${row.revision}:${row.summary ? 1 : 0}`
    ),
  ].join('|');

/** One open trajectory, in the drawer.
 *
 * These are the fields that move when a turn lands, a trajectory finishes, a
 * reward arrives or a capture gap appears. A finished trajectory moves none of
 * them, which is the common case for somebody reading one.
 */
export const trajectorySignature = (bundle) => {
  const trajectory = bundle && bundle.trajectory;
  if (!trajectory) return null;
  const capture = trajectory.capture || {};
  return [
    trajectory.status,
    trajectory.revision,
    capture.exchange_count,
    capture.node_count,
    capture.calls_after_close,
    capture.calls_missing,
    bundle.paths && bundle.paths.paths ? bundle.paths.paths.length : 0,
    bundle.exchanges && bundle.exchanges.data ? bundle.exchanges.data.length : 0,
  ].join('|');
};
