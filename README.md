# skycap-viewer

A viewer for [skycap](https://github.com/NovaSky-AI/SkyRL/tree/main/skycap) trajectory records. It reads the record files directly and needs no Python and no tokenizer.

It supports **`format_version` 1**, as specified in `skycap/docs/format.md`, and refuses any other version.

The page is a port of inference-capture's viewer (`inference-capture/viewer`, at 9f7bc77) and keeps its design (`docs/viewer.md`):
- runs down the left, the run's flat filtered trajectory list in the middle, and one trajectory in a drawer on the right;
- routes in the hash: `#/run/<run>/<trajectory>`.

## Run

It needs Node >= 22.15 (built-in `node:zlib` zstd) and has no dependencies and no build step. Modules are served as they sit. There is no `node_modules` and no lockfile.

```sh
node bin/skycap-viewer.js <dir>... [--port 8765] [--host 127.0.0.1]   # the page at http://127.0.0.1:8765/
node bin/skycap-viewer.js summary <record-dir>... [--json]             # per-directory stats, no browser
node bin/skycap-viewer.js check <record-dir>... [--sidecars]           # check records against format.md
node --test                                                            # the tests
```

Once `npm link` has been run, the same commands work as `skycap-viewer ...`.

A `<dir>` is either a record directory (it holds `*.json.zst`), or a parent whose children or grandchildren are record directories. Each record directory is a **run**. For example, `skycap-viewer /tmp/harbor/runs` lists every `harbor-skycap-*/skycap` as a run. A run is named after its directory, or after the directory's parent when the directory itself is named `skycap`. A parent is rescanned on refresh, so a run that starts writing later shows up.

Each trajectory's step and task come from its `meta`:
- step is `meta.step`;
- task is `meta.task_id`, else the basename of `meta.task`, else `meta.instance_id`.

## The page

### The run page
- **Record health band:** one chip per flag, counted over the whole filtered run. Clicking a chip filters the list to it.
- **Filters:** a step slider, and task, status, annotation (`key = value`) and search filters. There is no grid.
- **Table:** one row per trajectory, with its mask strip, tokens, trainable tokens, paths, reward, flags and status. Paging is 100 rows at a time.

The page polls every 5 s. The server rescans the directory and rereads only documents whose mtime or size changed.

### The drawer
- **Path:** each root-to-leaf path is one export row, cut into blocks on the mask and on node (turn) boundaries. Every block carries its `[start:end]` token range. The mask is drawn as a proportional strip above the text. Special tokens are shown. Each token is one span, and hovering it shows its id, logprob and text. Tokens that share a character keep a sliver of their own. The logprob ribbon is off by default.
- **Tree:** one row per node, with forks marked. Opening a node shows it and what follows it; a branch point lays its branches side by side, with the text they share dimmed. The tree also shows skycap's signs on each node:
  - `unbridged`
  - `unbridged (inferred)`
  - `re-tokenized copy of nX`
  - `shadowed by nX`
  - `unclosed think`
  - the calls, with `bridged`, on an opened node
- **Forks:** pick two paths. It names the last node they agree on, folds everything before it, and puts the rest side by side. It also runs the train-once check.
- **Calls:** every call behind every model node, and the record's failures.
- **JSON:** the raw payloads.

### Block kinds

| Kind | In a skycap record |
| --- | --- |
| `sampled` | a model node's tokens from `sampled_start` on, on the path that trains it |
| `replayed` | a client-authored assistant node: text the model did not sample here, such as a harness edit, stripped reasoning, or a re-tokenized copy |
| `scaffold` | a model node's tokens before `sampled_start` |
| `given` | any other client node: system, user or tool |
| `sampled-elsewhere` | a model node's sampled tokens on any later path. skycap trains each model node once, on the first path that contains it, so on later paths these tokens are masked context. The block carries `trained_in`. |

The fifth kind exists because both alternatives are wrong. Calling these tokens `sampled` would claim a second training. Calling them `replayed` would deny that the model wrote them.

### Flags

| Flag | Level | Derived from |
| --- | --- | --- |
| `failed-calls` | error | the document's `failures` |
| `incomplete` | error | `ended: false` or `status: open` (written at shutdown) |
| `no-logprobs` | error | a trained model node recorded without logprobs |
| `unbridged` | warn | a call with `bridged: false` |
| `unbridged-inferred` | warn | no `bridged` field, but a model node's prompt runs through a re-tokenized copy of a model turn |
| `replayed` | warn | a client-authored assistant node on a path |
| `no-train` | warn | a token-mode path with no trained tokens |
| `empty` | warn | no nodes (no successful call) |
| `truncated` | warn | a call with `finish_reason: length` |
| `unclosed-think` | warn | a model turn that opens `<think>` and never closes it |
| `abandoned` | info | `status: abandoned` (idle past the TTL) |
| `forked` | info | more than one path |
| `bridged-unknown` | info | calls with no `bridged` field (records written before it existed). It is left off the table's rows, where it would be true of every row, and stays in the band and the drawer. |

## API

The API reads only files, and everything on screen can be fetched with `curl`. Every route is also served under `/api/v1`.

```
GET /healthz
GET /v1/runs[?refresh=true]
GET /v1/trajectories?run_id=&step=&task_id=&status=&flag=&annotation=key=value&q=&limit=&cursor=&refresh=
GET /v1/trajectories/{id}[?run_id=]
GET /v1/trajectories/{id}/paths[?text=false]     text=false: no sidecar is opened
GET /v1/trajectories/{id}/graph
GET /v1/trajectories/{id}/exchanges
```

Listing, filtering, flags and the table's strips read only `{id}.json.zst`. The index is cached by mtime and size. The tokens sidecar is opened only for `/paths` with text. For `experts` and `sampling_mask`, only their shapes are shown, taken from the manifest.

## Layout

```
bin/skycap-viewer.js     serve | summary | check
src/record.js            the format.md parser (usable on its own), graph, paths, check
src/directory.js         a record directory's cached index
src/runs.js              runs: discovery, per-run index, run summaries
src/view.js              records -> the /v1 payloads (paths as blocks, graph, exchanges)
src/server.js            node:http: static files + the read API
src/stats.js             `summary`
public/                  the page: app.mjs, lib/, components/, style.css (ported)
test/                    node --test: parser, API, views rendered through test/dom-shim.mjs, the booted app
```

## Tests

`test/fixtures/real` holds four records from Harbor runs: a 21-path fork, a 3-path fork, a linear record and an empty record.

`test/fixtures/spec` holds records the Python writer produced:
- a fork with `bridged: false` calls, experts and a sampling mask
- a fork after a model turn (`sampled-elsewhere`)
- multi-byte text
- text mode
- a node with no text
- an empty sampling mask
- an empty trajectory

`expected.json` is what skycap's Python reader says about each record. To regenerate it, run this from `SkyRL/skycap`:

```sh
PYTHONPATH=. uv run --extra tokens python <viewer>/test/gen_fixtures.py /tmp/out
PYTHONPATH=. uv run --extra tokens python <viewer>/test/expect.py <viewer>/test/fixtures/expected.json <viewer>/test/fixtures/real <viewer>/test/fixtures/spec
```

The view tests render the real components through the dom-shim against payloads this server returns for those records. The app test boots `app.mjs` against the in-process server.
