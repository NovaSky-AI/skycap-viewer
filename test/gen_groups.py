"""A small record directory of GRPO groups, written by skycap's Python writer.

    step 1 / a   4 reps, rep 2 retried: attempt 0 errored, attempt 1 counts   -> retried
    step 1 / b   4 reps, all reward 1                                          -> no-signal
    step 2 / a   3 reps                                                        -> short (modal 4)
    step 2 / b   4 reps, one agent_timeout                                     -> masked
    step 2 / c   4 reps, non-binary rewards                                    -> dots only, no pass count

Run from SkyRL/skycap: PYTHONPATH=. uv run --extra tokens python <viewer>/test/gen_groups.py <out>
"""
import sys
from pathlib import Path

from skycap import record
from skycap.graph import CallInfo
from skycap.trajectory import Trajectory

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
t0 = 1_790_000_000.0
n = 0


def rollout(step, instance, rep, reward, *, attempt=0, stop="complete"):
    global n
    n += 1
    t = Trajectory(
        id=f"tr_g{step}{instance}{rep}a{attempt}",
        meta={"task": f"/tasks/task-{instance}", "instance_id": instance, "repetition_id": rep, "step": step, "attempt": attempt},
        created_at=t0 + n,
    )
    t.graph.commit_text(
        [{"role": "user", "content": f"solve {instance}"}],
        {"role": "assistant", "content": f"answer {rep}"},
        tools=None,
        model="policy",
        call=CallInfo(t_start=t0 + n, t_end=t0 + n + 1, model="policy", finish_reason="stop"),
    )
    t.ended = True
    t.seal("finished", {"reward": reward, "stop_reason": stop})
    record.write(out, t)


for rep, reward in enumerate([1, 0, 1, 1]):
    if rep == 2:
        rollout(1, "a", rep, 0, attempt=0, stop="error")
        rollout(1, "a", rep, reward, attempt=1)
    else:
        rollout(1, "a", rep, reward)
for rep in range(4):
    rollout(1, "b", rep, 1)
for rep, reward in enumerate([0, 1, 0]):
    rollout(2, "a", rep, reward)
for rep, (reward, stop) in enumerate([(1, "complete"), (0, "agent_timeout"), (0, "complete"), (0, "complete")]):
    rollout(2, "b", rep, reward, stop=stop)
for rep, reward in enumerate([0.2, 0.5, 0.9, 0.5]):
    rollout(2, "c", rep, reward)
