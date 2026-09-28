// The viewer's HTTP server: a read-only API over a record directory, and one static page.
//
//   GET /                                   the page
//   GET /api/trajectories                   every document's summary, newest first (sidecars never opened)
//   GET /api/stats                          directory statistics (same as `skycap-viewer summary`)
//   GET /api/trajectories/{id}              the document, its summary, paths, branch points, sidecar shapes
//   GET /api/trajectories/{id}/tokens?path=N  path N's tokens: ids, logprobs, text pieces, kinds (opens the tokens sidecar)

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RecordDirectory } from './directory.js';
import { directoryStats } from './stats.js';
import { graphOf, pathTokens, readDocumentAsync, readSidecar, sidecarShapes, summarize } from './record.js';

const PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url));

export function createViewer(dir, { log = () => {} } = {}) {
  const index = new RecordDirectory(dir);
  // Decoded tokens sidecars for the few most recently viewed trajectories.
  const tokenCache = new Map();
  const TOKEN_CACHE = 8;

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  };

  async function detail(id) {
    const doc = await readDocumentAsync(dir, id);
    const g = graphOf(doc);
    return { document: doc, summary: summarize(doc), paths: g.paths, branch_points: g.branchPoints, sidecar_shapes: sidecarShapes(doc) };
  }

  async function tokens(id, pathIndex) {
    const doc = await readDocumentAsync(dir, id);
    const g = graphOf(doc);
    if (pathIndex >= Math.max(1, g.paths.length)) return null;
    if (!doc.sidecars?.tokens) return { mode: doc.capture?.mode ?? 'text', paths: g.paths.length, path: null };
    let entry = tokenCache.get(id);
    if (!entry) {
      entry = readSidecar(dir, doc, 'tokens');
      tokenCache.set(id, entry);
      if (tokenCache.size > TOKEN_CACHE) tokenCache.delete(tokenCache.keys().next().value);
    }
    return { mode: doc.capture?.mode, paths: g.paths.length, path: pathTokens(doc, entry, g, pathIndex) };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const t0 = Date.now();
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'read-only' });
      if (parts.length === 0) return send(res, 200, readFileSync(PAGE), 'text/html; charset=utf-8');
      if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
      if (parts[1] === 'stats' && parts.length === 2) {
        const { rows, errors } = await index.summaries();
        return send(res, 200, { dir, stats: directoryStats(rows, errors) });
      }
      if (parts[1] !== 'trajectories') return send(res, 404, { error: 'not found' });
      if (parts.length === 2) {
        const { rows, errors } = await index.summaries();
        return send(res, 200, { dir, data: rows, errors });
      }
      const id = parts[2];
      if (!index.has(id)) return send(res, 400, { error: 'bad trajectory id' });
      try {
        if (parts.length === 3) return send(res, 200, await detail(id));
        if (parts.length === 4 && parts[3] === 'tokens') {
          const pathIndex = Number(url.searchParams.get('path') ?? 0);
          if (!Number.isInteger(pathIndex) || pathIndex < 0) return send(res, 400, { error: 'path must be a non-negative integer' });
          const body = await tokens(id, pathIndex);
          return body ? send(res, 200, body) : send(res, 404, { error: `no path ${pathIndex}` });
        }
      } catch (e) {
        if (e.code === 'ENOENT') return send(res, 404, { error: `unknown trajectory ${id}` });
        throw e;
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String(e.message ?? e) });
    } finally {
      log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });
  return { server, index };
}
