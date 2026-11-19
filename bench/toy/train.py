"""A toy training run for the experiment-lifecycle benchmark and the end-to-end test: logistic
regression by SGD on synthetic 2-D points, standard library only, the same numbers for the same
seed. Writes metrics.json (accuracy on held-out points, the loss of each epoch) to --out, or to
$RFT_OUT when the queue gives one.

    python3 train.py --seed 0 [--out runs/E08/seed0] [--epochs 30]
"""
import argparse
import json
import math
import os
import random
from pathlib import Path


def points(rng: random.Random, n: int) -> list[tuple[float, float, int]]:
    out = []
    for _ in range(n):
        x, y = rng.gauss(0, 1), rng.gauss(0, 1)
        out.append((x, y, int(x + 0.5 * y + rng.gauss(0, 0.4) > 0)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=os.environ.get("RFT_OUT"))
    ap.add_argument("--epochs", type=int, default=30)
    a = ap.parse_args()
    if not a.out:
        ap.error("--out is needed when $RFT_OUT is not set")
    rng = random.Random(a.seed)
    train, test = points(rng, 200), points(rng, 100)
    w = [0.0, 0.0, 0.0]
    losses = []
    for epoch in range(a.epochs):
        rng.shuffle(train)
        total = 0.0
        for x, y, t in train:
            p = 1 / (1 + math.exp(-(w[0] * x + w[1] * y + w[2])))
            total -= math.log(p if t else 1 - p)
            g = p - t
            w = [w[0] - 0.05 * g * x, w[1] - 0.05 * g * y, w[2] - 0.05 * g]
        losses.append(round(total / len(train), 5))
        print(f"epoch {epoch + 1}/{a.epochs} loss {losses[-1]:.4f}", flush=True)
    acc = sum((w[0] * x + w[1] * y + w[2] > 0) == bool(t) for x, y, t in test) / len(test)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "metrics.json").write_text(json.dumps({"seed": a.seed, "acc": round(acc, 4), "loss": losses}))
    print(f"seed {a.seed}: accuracy {acc:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
