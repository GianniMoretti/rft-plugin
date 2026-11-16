import marimo

app = marimo.App(app_title="D04 · Mix-based augmentation")


@app.cell(hide_code=True)
def _():
    # the concept's experiments with a recorded result: their RESULTS by id, from the vault's results/
    import json as _json
    import pathlib as _pathlib
    EXPERIMENTS = {_r["exp"]: _r["results"] for _r in (_json.loads(_p.read_text()) for _p in sorted(_pathlib.Path("../../vault/results").glob("E*.json"))) if "D04" in (_r.get("concepts") or []) and isinstance(_r.get("results"), dict)}
    return


@app.cell
def _():
    cols = sorted({k for r in EXPERIMENTS.values() for k, v in r.items() if isinstance(v, (int, float))})
    TABLES = {"Results by experiment": [{"experiment": e, **{c: r.get(c) for c in cols}} for e, r in sorted(EXPERIMENTS.items())]}
    return


@app.cell
def _():
    def bars():
        # only the experiments that report the same measure: held-out accuracy
        vals = [(e, r["acc_mean"]) for e, r in sorted(EXPERIMENTS.items()) if "acc_mean" in r]
        rects = "".join(f'<rect x="{20 + 50 * i}" y="{100 - 90 * v:.1f}" width="30" height="{90 * v:.1f}" fill="#4D4875"/>'
                        f'<text x="{35 + 50 * i}" y="115" font-size="9" text-anchor="middle">{e}</text>' for i, (e, v) in enumerate(vals))
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {40 + 50 * len(vals)} 120">{rects}</svg>'
    FIGURES = {"Accuracy by experiment": bars()}
    return


if __name__ == "__main__":
    app.run()
