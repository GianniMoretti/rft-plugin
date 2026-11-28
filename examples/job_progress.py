"""A job the experiment queue's monitor reads well (the manual, and the guide's "Writing a job the
monitor can read": https://alex-pv01.github.io/rft-guide/using/queue/#writing-a-job-the-monitor-can-read). It shows, from what it writes:

    Stage 2/3: train
    train  ███████░░░  7/10 · 70% · 00:12 left · loss=0.1429
    2026-11-16 12:00:05 epoch 7: val acc 0.912

Run it through the queue, or by hand (RFT_PROGRESS unset: the stages go to the log only).
EXAMPLE_SECONDS shortens or stretches it (default 0.02 s a batch).
"""
import json
import os
import time
from datetime import datetime

from tqdm import tqdm

PAUSE = float(os.environ.get("EXAMPLE_SECONDS", "0.02"))


def log(msg: str) -> None:
    """One line per event, with the time, written at once (the monitor shows the last one)."""
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def stage(i: int, n: int, name: str) -> None:
    """Where a job of several steps is: one line in $RFT_PROGRESS (and in the log)."""
    if os.environ.get("RFT_PROGRESS"):
        with open(os.environ["RFT_PROGRESS"], "a") as f:
            f.write(json.dumps({"stage": name, "i": i, "n": n}) + "\n")
    log(f"stage {i}/{n}: {name}")


STEPS = ["prepare", "train", "evaluate"]
for i, name in enumerate(STEPS, 1):
    stage(i, len(STEPS), name)
    epochs = tqdm(range(10), desc=name)              # a fixed label and a total
    for epoch in epochs:
        for _ in tqdm(range(20), desc="batch", leave=False):   # an inner loop: leave=False
            time.sleep(PAUSE)
        loss = 1 / (epoch + 1)
        epochs.set_postfix(loss=f"{loss:.4f}")          # numbers that change: the postfix, not the label
        if epoch % 3 == 2:
            log(f"epoch {epoch + 1}: val acc {0.9 + epoch / 1000:.3f}")
out = os.environ.get("RFT_OUT", ".")
with open(os.path.join(out, "metrics.json"), "w") as f:     # results to $RFT_OUT, not into the log
    json.dump({"loss": loss}, f)
log(f"done: metrics in {out}")
