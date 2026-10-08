# skycap-viewer

A viewer for [skycap](https://github.com/NovaSky-AI/SkyRL/tree/main/skycap) trajectory records. It reads the record files directly and needs no Python and no tokenizer.

It supports **`format_version` 1**, as specified in `skycap/docs/format.md`, and refuses any other version.

The page is a port of inference-capture's viewer (`inference-capture/viewer`, at 9f7bc77) and keeps its design (`docs/viewer.md`):
- runs down the left, the run's flat filtered trajectory list in the middle, and one trajectory in a drawer on the right;
- routes in the hash: `#/run/<run>/<trajectory>`.

On top of the port, a run can be read as **GRPO groups** (see [Groups](#groups)).

## Run

It needs Node >= 22.15 (built-in `node:zlib` zstd) and has no dependencies and no build step. Modules are served as they sit. There is no `node_modules` and no lockfile.

```sh
node bin/skycap-viewer.js <dir>... [--port 8765] [--host 127.0.0.1] [--group-by step,instance_id]   # the page at http://127.0.0.1:8765/
node bin/skycap-viewer.js summary <record-dir>... [--json]             # per-directory stats, no browser
node bin/skycap-viewer.js check <record-dir>... [--sidecars]           # check records against format.md
node --test                                                            # the tests
```

Once `npm link` has been run, the same commands work as `skycap-viewer ...`.

A `<dir>` is either a record directory (it holds `*.json.zst`), or a parent whose children or grandchildren are record directories. Each record directory is a **run**. For example, `skycap-viewer /tmp/harbor/runs` lists every `harbor-skycap-*/skycap` as a run. A run is named after its directory, or after the directory's parent when the directory itself is named `skycap`. A parent is rescanned on refresh, so a run that starts writing later shows up.

A record is a top-level `*.json.zst` in a record directory, with its sidecars beside it. Anything else in the directory, such as the `index/` folder of a pulled run, is ignored.

Each trajectory's step and task come from its `meta`:
- step is `meta.step`;
- task is `meta.task_id`, else the basename of `meta.task`, else `meta.instance_id`.

## Groups

A group is the rollouts of one prompt at one step. Its key comes from each trajectory's `meta` (or `annotations`): `step` + `instance_id` by default. Harbor records carry `meta` `{task, instance_id, repetition_id, step, attempt}` and `annotations` `{reward, stop_reason}`. `--group-by key1,key2` (or `?group_by=` on the API) picks other keys. A group is labelled with its task, derived the same way as the task column.

**The toggle.** The run page switches between Groups and Rollouts. Groups is the default when most of the run's records carry the group key; otherwise it is Rollouts. The view, the column sort and the expanded groups all live in the hash route, so a reload or a pasted link keeps them:

| Route | Shows |
| --- | --- |
| `#/run/<run>` | the default view |
| `#/run/<run>/groups`, `#/run/<run>/rollouts` | one view or the other |
| `…[/<trajectory>]` | the same, with a rollout open in the drawer |
| `…?sort=<column>&order=asc\|desc` | the table sorted by a column |
| `…?open=<key>,<key>` | the groups that are expanded |
| `#/run/<run>/group/<key>[/<trajectory>]` | the groups view with that group expanded and scrolled to |

**One table, two levels.** Clicking a group row expands its rollouts in place, beneath the row; clicking it again collapses it. Several groups can be open at once. Clicking a rollout opens the drawer. Group rows and rollout rows share one column grid, and each cell means something at both levels:

| Column | Group row | Rollout row |
| --- | --- | --- |
| step | the group's step | the rollout's step |
| task / rollout | the task (and `n of N` when short) | repetition, attempt and trajectory id |
| rewards | one dot per rollout, in repetition order | its dot and its value |
| turns | the range over its rollouts | its call count |
| tokens | the range over its rollouts | its first path's tokens |
| health | group flags, and rollout flags rolled up ("15 forked, 1 truncated") | its flags |

Expanded rollouts are sorted by the table's column (by reward, highest first, by default). The attempts a retry superseded are shown greyed under the attempt that counts.

**Reward colour.** Rewards are not assumed binary. Colour is a continuous red → green scale: fully red at the minimum, fully green at the maximum. The range is run-wide, taken over every rollout the current filters list (the server sends it with each listing as `reward_range`). So one colour means one reward in every group, on every page and in the rollout list's reward column. The legend above each table says so. When every reward shown is the same, there is no scale, and the colour sits in the middle.

**Sorting.** Click a column header to sort by it, and again to flip it; the header shows ▲ or ▼. The sortable columns are step, task, reward, turns, tokens and health (the flag count). Sorting is server-side (`sort=` / `order=`), because the lists are paged. A group sorts by reward using its rollouts' mean reward; that mean is an ordering key only and is never shown. Groups sort by turns and tokens using their largest rollout.

**Filters.** Step (a select: all steps, or one step with its count), task, status, annotation, search and flags apply to groups too: a group matches if any of its rollouts does. In an expanded group, the rollouts that match are emphasised and the rest dimmed.

**Retries.** A repetition is one `repetition_id`. When the harness retried it, the highest `attempt` counts, and the earlier attempts are shown greyed under it. N counts repetitions, not attempts.

**Group flags.** These sit in the band, are click-to-filter and are computed server-side like the others:

| Flag | Level | Meaning |
| --- | --- | --- |
| `no-signal` | warn | every rollout got the same reward, so the group trains nothing |
| `masked` | warn | a counting rollout stopped on `agent_timeout` or `error`; the Harbor composer masks the whole instance |
| `short` | warn | fewer rollouts than the run's modal group size |
| `retried` | info | some repetition has more than one attempt |

A retried attempt that errored does not mask its group; only the attempt that counts does.

**No training metrics.** There is no mean reward, no advantage, no reward − mean and no pass rate on screen. viewer.md's rule, that the viewer's job stops at *is this record right*, stands. The dots and values describe the record; what a trainer makes of them is the trainer's business. The one mean computed, for sorting groups by reward, orders rows and is never displayed.

**Why this doesn't contradict run-dimensions.md.** inference-capture's `design/run-dimensions.md` removed the `task × step` grid, because sessions don't recur across steps and a cross-step matrix is a dense view of sparse data. A group is different on both counts:
- it sits within one step;
- it is dense by construction: all N rollouts of one prompt, sampled together;
- it is the unit GRPO trains on.

Nothing here lines groups up across steps. Cross-step stays a filter (the step slider), and a group is just a row.

## Mirrored records

A record mirror can leave sidecar kinds out (format.md "A mirror"). It copies the document unchanged, so a copy may lack sidecar files its manifest lists. As format.md says, the viewer reads a listed sidecar whose file is missing as absent, and doesn't tell "left out on purpose" from "lost":
- **Missing `tokens`:** message text only. The path view draws the messages, counts them in characters, and warns "tokens sidecar missing: showing message text only". The row gets `tokens-missing` (warn).
- **Missing `experts` or `sampling_mask`:** ignored, since the viewer shows nothing from them. No flag and no note. The trajectory's `missing_sidecars` (in the drawer's JSON tab) lists them.
- **`malformed-record` (error):** a node slice into a kind the manifest doesn't list at all. The drawer names the node.

`check` counts listed sidecar files that aren't there ("read as absent") per directory, without calling them problems. It reports `malformed-record`'s case, and offsets that are wrong, as problems.

## The page

### The run page
- **Record health band:** one chip per flag, counted over the whole filtered run. Clicking a chip filters the list to it.
- **Filters:** a step select, and task, status, annotation (`key = value`) and search filters. There is no grid.
- **Table:** one row per trajectory, with its mask strip, tokens, trainable tokens, turns, paths, reward (coloured on the run-wide range), flags and status. Headers sort, server-side. Paging is 100 rows at a time.

The page polls every 5 s. The server rescans the directory and rereads only documents whose mtime or size changed.

### The drawer
- **Path:** each root-to-leaf path is one export row, cut into blocks on the mask and on node (turn) boundaries. Every block carries its `[start:end]` token range. The mask is drawn as a proportional strip above the text. Special tokens are shown. Each token is one span, and hovering it shows its id, logprob and text. Tokens that share a character keep a sliver of their own. The logprob ribbon is off by default.
- **Tree:** one row per node, with forks marked. Opening a node shows it and what follows it; a branch point lays its branches side by side, with the text they share dimmed. The tree also shows skycap's signs on each node:
  - `unbridged`
  - `unbridged (inferred)`
  - `re-tokenized copy of nX`
  - `shadowed by nX`
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
| `abandoned` | info | `status: abandoned` (idle past the TTL) |
| `forked` | info | more than one path |
| `malformed-record` | error | a node slices into a sidecar kind the manifest doesn't list; see [Mirrored records](#mirrored-records) |
| `tokens-missing` | warn | the manifest lists a tokens sidecar whose file isn't here: message text only; see [Mirrored records](#mirrored-records) |
| `no-signal`, `masked`, `short`, `retried` | | group flags; see [Groups](#groups) |
| `bridged-unknown` | info | calls with no `bridged` field (records written before it existed). It is left off the table's rows, where it would be true of every row, and stays in the band and the drawer. |

## API

The API reads only files, and everything on screen can be fetched with `curl`. Every route is also served under `/api/v1`.

```
GET /healthz
GET /v1/runs[?refresh=true]
GET /v1/trajectories?run_id=&step=&task_id=&status=&flag=&annotation=key=value&q=&sort=&order=&limit=&cursor=&refresh=
GET /v1/trajectories/{id}[?run_id=]
GET /v1/trajectories/{id}/paths[?text=false]     text=false: no sidecar is opened
GET /v1/trajectories/{id}/graph
GET /v1/trajectories/{id}/exchanges
GET /v1/groups?run_id=&group_by=&<the trajectory filters>&flag=&sort=&order=&limit=&cursor=
                                                 GRPO groups; `health` counts groups per flag
GET /v1/groups/{key}?run_id=&<filters>&sort=&order=   one group: rollouts sorted (reward, highest first, by default), each with the
                                                 attempts it superseded, and `match` under the filters
```

`sort` is one of step, task, reward, turns, tokens, health or created, and `order` is asc or desc. Each listing also returns `sort` and `reward_range` (`{min, max}` over the listed rollouts).

`/paths` carries `text_only` (`tokens-missing`, `tokens-unlisted` or null), and a trajectory carries `missing_sidecars` (listed kinds whose files aren't here) and `record_problems`.

Listing, filtering, flags and the table's strips read only `{id}.json.zst`, and check that its listed sidecar files exist. The index is cached by mtime and size. The tokens sidecar is opened only for `/paths` with text. For `experts` and `sampling_mask`, only their shapes are shown, taken from the manifest.

## Layout

```
bin/skycap-viewer.js     serve | summary | check
src/record.js            the format.md parser (usable on its own), graph, paths, check
src/directory.js         a record directory's cached index
src/runs.js              runs: discovery, per-run index, run summaries
src/groups.js            GRPO groups: keys, repetitions and attempts, group flags
src/sorting.js           server-side column sorts, and the run-wide reward range
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

`test/fixtures/groups` holds 20 rollouts in 5 groups, written by `test/gen_groups.py`. It covers a retry, a no-signal group, a short group, an agent_timeout, and non-binary rewards.

`test/fixtures-mirror` holds copies as a mirror with `exclude` makes them, with the document unchanged, written by `node test/gen_mirror.mjs --write`: one without its experts and sampling_mask files, one with no sidecar files at all, and one whose nodes slice into experts that its manifest doesn't list.

The view tests render the real components through the dom-shim against payloads this server returns for those records. The app test boots `app.mjs` against the in-process server.

## Roadmap

Deferred, not built:
- comparing two runs group by group;
- a pass-vs-fail compare of two rollouts in one group.

## License

Apache License 2.0, the same license as [SkyRL](https://github.com/NovaSky-AI/SkyRL). See [LICENSE](LICENSE).
