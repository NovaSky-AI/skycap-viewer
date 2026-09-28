# skycap-viewer

A small viewer for [skycap](https://github.com/NovaSky-AI/SkyRL/tree/main/skycap) trajectory records.
It reads the record format directly and needs no Python and no tokenizer.

It supports **`format_version` 1**, as specified in `skycap/docs/format.md`, and refuses any other version.

## Run

It needs Node >= 22.15 (built-in `node:zlib` zstd) and has no npm dependencies.

```sh
npx skycap-viewer <record-dir> [--port 8765] [--host 127.0.0.1]   # the page at http://127.0.0.1:8765/
npx skycap-viewer summary <record-dir>... [--json]                 # per-directory stats, no browser
npx skycap-viewer check <record-dir>... [--sidecars]               # check records against format.md
npm test                                                           # node --test
```

`summary` prints:
- counts by status and capture mode
- the paths-per-trajectory histogram, and forked trajectories (paths > 1)
- calls by `bridged` (`true` / `false` / `null` / absent)
- trajectories with an unbridged call
- re-render signs, for records written before `bridged` existed
- unclosed `<think>` turns
- failures and retries
- the reward distribution from `annotations.reward`

## What it shows

- **List:** the trajectory list, filtered by status and by text over id, meta and annotations. It can also be filtered to trajectories with unbridged calls, forked ones, ones with re-render signs, ones with an unclosed `<think>`, ones with failures, or non-empty ones, and sorted by time, paths, unbridged calls, tokens or reward.
- **Tree:** the fork tree. A linear chain stays at one indent, and each fork gets its own branch. Branch points are highlighted. Calls with `bridged: false` are highlighted in red. Clicking a node opens its message and calls: timing, model, finish reason, `bridged`, usage, sampling and tools.
- **Paths:** one entry per root-to-leaf path, in the writer's order (leaf creation order). Each shows where it forks from the earlier paths and marks the nodes it trains. Each model node is trained on the first path that contains it.
- **Tokens:** a per-path token strip and text, built from the sidecar's text and byte offsets. Tokens are coloured by kind:
  - trained on this path
  - sampled but trained on another path
  - template scaffold
  - prompt

  Hovering a token shows its id, logprob and text. The colour can also be set by logprob.
- **Failures,** and the raw document.

The list, tree and paths views read only `{id}.json.zst`. The directory index is cached by mtime and size. The tokens sidecar is opened only when the tokens view needs it. For `experts` and `sampling_mask`, only their shapes are shown, taken from the manifest.

### Records without `bridged`

Records written before `bridged` existed have no such field on their calls. The viewer reports these calls as *absent* (unknown), not `null`. For such records it flags two inferred signs of re-rendering:
- a client node shadowed by a model sibling, meaning the same message was tokenized differently;
- model calls whose prompt runs through such a copy.

## API

```
GET /api/trajectories                      summaries, newest first (documents only)
GET /api/stats                             what `summary` prints, as JSON
GET /api/trajectories/{id}                 document, summary, paths, branch_points, sidecar_shapes
GET /api/trajectories/{id}/tokens?path=N   path N: per node token_ids, logprobs, pieces, kinds
```

## Library

`src/record.js` works on its own:
- `readDocument` and `readSidecar`
- `viewSidecar`, which gives typed-array views
- `graphOf`, which gives paths, targets and branch points
- `nodeTokens` and `pathTokens`
- `nodeExperts` and `nodeSamplingMask`
- `summarize`
- `check`

## Tests

`test/fixtures/real` holds four records from Harbor runs: a 21-path fork, a 3-path fork, a linear record and an empty record. `test/fixtures/spec` holds records the Python writer produced for edge cases:
- a fork with `bridged: false` calls, experts and a sampling mask
- multi-byte text split across tokens
- text mode
- a node with no text
- an empty sampling mask
- an empty trajectory

`test/fixtures/expected.json` is what skycap's own Python reader says about each record. To regenerate it, run this from `SkyRL/skycap`:

```sh
PYTHONPATH=. uv run --extra tokens python <viewer>/test/gen_fixtures.py /tmp/out
PYTHONPATH=. uv run --extra tokens python <viewer>/test/expect.py <viewer>/test/fixtures/expected.json <viewer>/test/fixtures/real <viewer>/test/fixtures/spec
```
