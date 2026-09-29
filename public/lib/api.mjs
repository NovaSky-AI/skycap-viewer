/** The read API, on the viewer's own origin.
 *
 * Every path here is a `/v1` route the viewer's server answers from skycap
 * record files (also served without the `/api` prefix). The viewer has no
 * private API: anything on screen can be fetched with curl.
 */

const base = '/api/v1';

async function get(path, params) {
  const query = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
  ).toString();
  const response = await fetch(`${base}${path}${query ? `?${query}` : ''}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `${response.status} on ${path}`);
  return body;
}

export const api = {
  health: () => fetch('/api/healthz').then((r) => r.json()),
  viewer: () => fetch('/__viewer').then((r) => r.json()),
  // `refresh` asks the indexer to rescan the record directory before
  // answering. Both listings take it, because a trajectory that finished
  // moved between two directories and a refresh of one would show it twice.
  runs: (params) => get('/runs', params).then((b) => b.data),
  trajectories: (params) => get('/trajectories', params),
  // `run_id` pins which record directory to read; ids are unique within one.
  trajectory: (id, runId) => get(`/trajectories/${id}`, { run_id: runId }),
  paths: (id, params) => get(`/trajectories/${id}/paths`, params),
  graph: (id, runId) => get(`/trajectories/${id}/graph`, { run_id: runId }),
  exchanges: (id, runId) => get(`/trajectories/${id}/exchanges`, { run_id: runId }),
};

/** Fetch many, a few at a time.
 *
 * The table wants a mask strip per row, and a strip costs one `/paths` call.
 * Firing five hundred at a capture process that is also serving a training run
 * would make the viewer the problem it is meant to diagnose.
 */
export async function pooled(items, worker, limit = 6) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
