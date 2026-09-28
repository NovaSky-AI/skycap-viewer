"""What skycap's Python reader says about each record: paths, targets, token counts, bridged."""
import json, sys
from pathlib import Path
from skycap import record
from skycap.samples import build_samples
out = {}
for d in sys.argv[2:]:
    d = Path(d)
    for tid in record.list_ids(d):
        tr = record.load(d, tid)
        g = tr.graph
        samples = build_samples(g)
        out[tid] = {
            "nodes": len(g), "calls": sum(len(n.calls) for n in g),
            "paths": [{"leaf": s.leaf, "path": s.path, "targets": s.targets,
                       "tokens": None if s.input_ids is None else len(s.input_ids),
                       "trained_tokens": None if s.loss_mask is None else sum(s.loss_mask)} for s in samples],
            "branch_points": sorted(g.branch_points()),
            "unbridged": g.unbridged_calls(),
            "bridged": [c.bridged for n in g for c in n.calls],
            "node_text": {str(n.id): n.tokens.text for n in g if n.tokens is not None and n.tokens.text is not None},
        }
Path(sys.argv[1]).write_text(json.dumps(out, indent=1, ensure_ascii=False))
