import marimo

app = marimo.App(app_title="E08 · Toy schedule-free run, seeds 0 to 2")


@app.cell
def _():
    import json
    import pathlib
    import statistics
    m = sorted((json.loads(p.read_text()) for p in pathlib.Path("runs/E08").glob("*/metrics.json")), key=lambda r: r["seed"])
    return


@app.cell
def _():
    accs = [r["acc"] for r in m]
    RESULTS = {"acc_mean": round(statistics.mean(accs), 4), "acc_std": round(statistics.stdev(accs), 4), "seeds": len(accs)}
    TABLES = {"Accuracy by seed": [{"seed": r["seed"], "accuracy": r["acc"]} for r in m]}
    return


@app.cell
def _():
    def curve(r, i):
        pts = " ".join(f"{20 + 8 * k:.0f},{180 - 200 * v:.1f}" for k, v in enumerate(r["loss"]))
        return f'<polyline fill="none" stroke="{["#4D4875", "#7A72CC", "#AFAAE0"][i % 3]}" stroke-width="2" points="{pts}"/>'
    FIGURES = {"Training loss": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 200" width="280" height="200">'
               + "".join(curve(r, i) for i, r in enumerate(m)) + "</svg>"}
    return


if __name__ == "__main__":
    app.run()
