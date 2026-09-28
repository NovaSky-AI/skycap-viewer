"""Generate small skycap records with the Python writer, plus what the Python side says about them."""
import asyncio, json, math, sys, shutil
from pathlib import Path
import numpy as np
from skycap import record
from skycap.graph import CallInfo, NodeTokens
from skycap.trajectory import Trajectory
from skycap.samples import build_samples
from tests.test_record import _token_trajectory
from tests.test_tokens import token_stack, client, user
from tests.fake_renderer import END, encode

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)

# 1. every array kind, multi-byte text, a failure
record.write(out, _token_trajectory())

# 2. text mode
t = Trajectory(id="tr_text", meta={"task": "t"})
t.graph.commit_text([{"role": "user", "content": "q"}], {"role": "assistant", "content": "a"},
                    tools=None, model="policy", call=CallInfo(t_start=0.0, t_end=1.0, model="policy"))
t.seal("failed", {"reward": 0.0})
record.write(out, t)

# 3. a token node with no text recorded, and a model node without logprobs
t = Trajectory(id="tr_notext")
n0, _ = t.graph.add(None, role="user", author="client", message={"role": "user", "content": "x"}, match_hash="a",
                    delta_hash="a", created_at=0.0, tokens=NodeTokens(token_ids=[1, 2]))
n1, _ = t.graph.add(n0.id, role="assistant", author="model", message={"role": "assistant", "content": "y"},
                    match_hash="b", delta_hash="b", created_at=1.0, tokens=NodeTokens(token_ids=[3, 4, 5], sampled_start=1,
                    text="<a>yz", text_offsets=[0, 3, 4]))
n1.calls.append(CallInfo(t_start=0.5, t_end=1.0))
t.seal("abandoned")
record.write(out, t)

# 4. empty sampling mask
t = Trajectory(id="tr_empty_mask")
n, _ = t.graph.add(None, role="assistant", author="model", message={"role": "assistant", "content": ""}, match_hash="m",
                   delta_hash="d", created_at=0.0, tokens=NodeTokens(token_ids=[1], sampled_start=1, sampling_mask=[]))
record.write(out, t)

# 5. an empty trajectory (no nodes, no sidecars), like the 780 in the 8B run
record.write(out, Trajectory(id="tr_empty"))

# 6. a real token-stack fork whose second call was re-rendered (bridged=false), with experts and masks
async def forked():
    thinking = [*encode("THINK:hmm|answer"), END]
    async with token_stack(completion=lambda p, s: thinking, sampling_mask=True, record_dir=out) as stack:
        created = await stack.create()
        llm = client(created["base_url"])
        await llm.chat.completions.create(model="policy", messages=[user("q")])
        await llm.chat.completions.create(model="policy", messages=[user("q"), {"role": "assistant", "content": "answer"}, user("more")])
        await llm.chat.completions.create(model="policy", messages=[user("q"), {"role": "assistant", "content": "answer"}, user("more"),
                                                                       {"role": "assistant", "content": "answer"}, user("again")])
        await stack.finish(created["id"], {"reward": 0.5})
        for p in out.glob(f"{created['id']}.*"):
            p.rename(out / p.name.replace(created["id"], "tr_forked_unbridged"))
        doc = record.read_document(out, "tr_forked_unbridged")
        doc["id"] = "tr_forked_unbridged"
        for kind in doc["sidecars"].values():
            kind["file"] = kind["file"].replace(created["id"], "tr_forked_unbridged")
        import orjson, zstandard
        (out / "tr_forked_unbridged.json.zst").write_bytes(zstandard.ZstdCompressor(level=3).compress(orjson.dumps(doc)))
asyncio.run(forked())
