#!/usr/bin/env node
// skycap-viewer <dir>... [--port N] [--host H]       serve the viewer; each dir is a record
//                                                    directory or a parent of several (runs)
// skycap-viewer summary <record-dir>... [--json]     per-directory statistics
// skycap-viewer check <record-dir>... [--sidecars]   check documents (and tokens sidecars) against format.md

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RecordDirectory } from '../src/directory.js';
import { directoryStats, formatStats } from '../src/stats.js';
import { check, documentPath, listIds, readDocument, readSidecar, zstdFrames } from '../src/record.js';
import { createViewer } from '../src/server.js';

const USAGE = `usage:
  skycap-viewer <dir>... [--port N] [--host H] [--group-by k1,k2] [--quiet]
      a dir is a record dir, or a parent of record dirs; --group-by names the meta or
      annotation keys that make a GRPO group (default step,instance_id)
  skycap-viewer summary <record-dir>... [--json]
  skycap-viewer check <record-dir>... [--sidecars] [--limit N]`;

function dirs(list) {
  if (!list.length) fail(USAGE);
  for (const d of list) if (!existsSync(d) || !statSync(d).isDirectory()) fail(`not a directory: ${d}`);
  return list;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const argv = process.argv.slice(2);
const command = ['summary', 'check'].includes(argv[0]) ? argv.shift() : 'serve';
let parsed;
try {
  parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '8765' },
      host: { type: 'string', default: '127.0.0.1' },
      json: { type: 'boolean', default: false },
      sidecars: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
      quiet: { type: 'boolean', default: false },
      'group-by': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  fail(`${e.message}\n${USAGE}`);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (command === 'summary') {
  const out = [];
  for (const dir of dirs(positionals)) {
    const t0 = Date.now();
    const { rows, errors } = await new RecordDirectory(dir).summaries();
    const stats = directoryStats(rows, errors);
    if (values.json) out.push({ dir, stats, errors });
    else {
      console.log(formatStats(dir, stats));
      for (const e of errors) console.log(`  unreadable: ${e.id}: ${e.error}`);
      console.log(`  (${Date.now() - t0} ms)\n`);
    }
  }
  if (values.json) console.log(JSON.stringify(out, null, 1));
} else if (command === 'check') {
  let failed = 0;
  for (const dir of dirs(positionals)) {
    let docs = 0;
    let bad = 0;
    for (const id of listIds(dir)) {
      docs++;
      let problems;
      try {
        const doc = readDocument(dir, id);
        problems = check(doc, values.sidecars ? { tokens: readSidecar(dir, doc, 'tokens') } : {});
        const files = [documentPath(dir, id)];
        for (const [kind, entry] of Object.entries(doc.sidecars ?? {})) {
          const path = join(dir, entry.file);
          if (!existsSync(path)) problems.push(`${kind} sidecar ${entry.file} is missing`);
          else if (values.sidecars) files.push(path);
        }
        for (const path of files) {
          const frames = zstdFrames(readFileSync(path)).length;
          if (frames !== 1) problems.push(`${path} has ${frames} zstd frames (format.md: one)`);
        }
      } catch (e) {
        problems = [String(e.message ?? e)];
      }
      if (problems.length) {
        bad++;
        if (bad <= Number(values.limit)) console.log(`${id}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5})` : ''}`);
      }
    }
    console.log(`${dir}: ${docs} documents, ${bad} with problems${values.sidecars ? ' (tokens sidecars checked)' : ''}`);
    failed += bad;
  }
  process.exit(failed ? 1 : 0);
} else {
  const roots = dirs(positionals);
  const port = Number(values.port);
  const groupBy = values['group-by'] ? values['group-by'].split(',').map((k) => k.trim()).filter(Boolean) : undefined;
  const { server, runs } = createViewer(roots, { groupBy, log: values.quiet ? () => {} : (line) => console.log(line) });
  if (!runs.runs.size) console.log(`no skycap records under ${roots.join(', ')} yet; they appear on refresh`);
  server.listen(port, values.host, async () => {
    const { port: bound } = server.address();
    console.log(`skycap-viewer: ${runs.runs.size} run(s) under ${roots.join(', ')} at http://${values.host}:${bound}/`);
    const t0 = Date.now();
    await runs.warm();
    const docs = [...runs.runs.values()].reduce((s, r) => s + r.index.cache.size, 0);
    console.log(`indexed ${docs} documents in ${Date.now() - t0} ms`);
  });
}
