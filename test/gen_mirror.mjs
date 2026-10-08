// Writes test/fixtures-mirror: copies of records the Python writer produced
// (test/fixtures/spec) as a record mirror with `exclude` makes them (format.md
// "A mirror"): the document unchanged, some listed sidecar files not copied.
//
//   tr_mirror_training   experts and sampling_mask files left out -> absent, no flag, no note
//   tr_mirror_text       no sidecar files at all -> message text, tokens-missing (warn)
//   tr_unlisted_experts  nodes slice experts, the manifest doesn't list it -> malformed-record
//
// Run: node test/gen_mirror.mjs --write   (deterministic; rewrites the directory). Without
// --write it does nothing, so `node --test`, which loads every module under test/, leaves it be.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { readDocument } from '../src/record.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SPEC = join(HERE, 'fixtures/spec');
const OUT = join(HERE, 'fixtures-mirror');

/** A copy of `SPEC/<id>` as `newId`, its sidecars renamed; `keep` picks which sidecar files are copied. */
function copyRecord(id, newId, { edit = () => {}, keep = () => true } = {}) {
  const doc = structuredClone(readDocument(SPEC, id));
  doc.id = newId;
  for (const [kind, entry] of Object.entries(doc.sidecars ?? {})) {
    const file = entry.file.replace(id, newId);
    if (keep(kind)) copyFileSync(join(SPEC, entry.file), join(OUT, file));
    entry.file = file;
  }
  edit(doc);
  writeFileSync(join(OUT, `${doc.id}.json.zst`), zlib.zstdCompressSync(Buffer.from(JSON.stringify(doc))));
}

if (process.argv.includes('--write')) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  copyRecord('tr_tokens', 'tr_mirror_training', { keep: (k) => k === 'tokens' });
  copyRecord('tr_forked_unbridged', 'tr_mirror_text', { keep: () => false });
  copyRecord('tr_tokens', 'tr_unlisted_experts', { keep: (k) => k !== 'experts', edit: (d) => { delete d.sidecars.experts; } });
  console.log(`wrote ${OUT}`);
}
