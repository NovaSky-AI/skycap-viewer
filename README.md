# skycap-viewer

A browser viewer for [skycap](https://github.com/NovaSky-AI/SkyRL/tree/main/skycap) trajectory records: every model call of an RL rollout, as the trainer saw it, token by token.

Point it at a directory of records and you can:

- **Browse a run** as a list of rollouts, or grouped the way GRPO trains them (all samples of one prompt at one step), filtered by step, task, status or any annotation.
- **Spot the odd ones out.** A health band flags rollouts that are worth a look: truncated, failed calls, histories that forked, groups with no learning signal.
- **Read a rollout token by token**, with what was trained, what was context and what the model sampled marked on the text, and logprobs on hover.
- **Follow forks** (summarization, retries, edited histories) in a tree, and compare two branches from the point where they diverge.

It is read-only and local: it reads record files from disk, makes no network calls, and needs no tokenizer, no Python and no credentials.

## Quick start

You need Node.js 22.15 or newer. There are no dependencies to install and no build step.

```sh
git clone https://github.com/NovaSky-AI/skycap-viewer && cd skycap-viewer
node bin/skycap-viewer.js /path/to/records
```

Then open http://127.0.0.1:8765. (`npm link` makes the same command available as `skycap-viewer`.)

The path can be a single record directory, or a folder that contains several; each record directory shows up as its own run.

## Where records come from

skycap writes one record per trajectory into its `--record-dir`. Point the viewer at that directory, even while the run is going; new records appear as they are written.

## What you see

**Runs** are listed on the left. Each run opens as a table:

- **Groups** (the default for training runs): one row per prompt per step, with a dot per rollout coloured by reward on a red-to-green scale. Click a group to expand its rollouts in place.
- **Rollouts:** one row per trajectory, with a strip showing where its tokens were trained.

Columns sort on click, and the view, filters and sort live in the URL, so a link shows exactly what you see.

**A rollout** opens in a side drawer:

- **Path:** the conversation as the model saw it, cut into blocks: what the model sampled and trained on, the chat template's scaffolding, the inputs it was given, and replayed text it didn't produce. Hover a token for its id and logprob.
- **Tree:** every message as a node. Forks are marked, the first node of each branch says why the history forked there, and opening a branch point shows its branches side by side.
- **Forks:** pick two paths and compare them from the last message they share.
- **Calls:** each model call behind the rollout, with timing, token counts and how it ended.

A fork's cause is one of `resample` (the model replied again to a history it had already answered), `edited reply` (the harness sent back a model reply with fields changed, such as stripped reasoning), `re-rendered` (token mode: the same message, but its render didn't reproduce the sampled tokens), `different message` (a compaction, a subagent, a rewritten turn) or `tools or model` (the same message sent with another tool set or model, which starts a new root). It is read by comparing the branch's first node with the earlier sibling it should have matched.

**Health flags** sit in a band above the table; click one to filter to it. Among them:

| Flag | What it means |
| --- | --- |
| `truncated` | a model call stopped on its token limit |
| `failed-calls` | calls that never produced a reply |
| `forked` | the history diverged, so the rollout trains as more than one row |
| `unbridged` | a prompt had to be re-rendered instead of extending the previous call token for token |
| `no-train` | nothing in a path is trainable |
| `tokens-missing` | the record's tokens aren't available (e.g. a mirror that left them out); only message text is shown |
| `no-signal` | every rollout in a group got the same reward, so the group teaches nothing |
| `masked` | a rollout in the group timed out or errored, so the whole group was masked |

The viewer shows records, not training curves: rewards appear as they were recorded, and there are no averages, advantages or pass rates.

## Command line

```sh
skycap-viewer <dir>... [--port 8765] [--host 127.0.0.1]   # serve the viewer
skycap-viewer summary <dir>... [--json]                   # a quick text summary of each run, with the cause of each fork
skycap-viewer check <dir>...                              # validate records against skycap's format
```

`summary --json` is for scripts: a harness whose history should stay on one path can be gated on `stats.forked == 0`, and `stats.fork_kinds` says what kind of fork it made when it didn't.

## Record format

The viewer reads skycap records, `format_version` 1, as specified in [skycap's `docs/format.md`](https://github.com/NovaSky-AI/SkyRL/blob/main/skycap/docs/format.md), and refuses other versions.

## Development

```sh
node --test
```

The tests run the real views against real and generated records in `test/fixtures*`.

## License

Apache License 2.0, the same license as [SkyRL](https://github.com/NovaSky-AI/SkyRL). See [LICENSE](LICENSE).
