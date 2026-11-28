"""The project's figure style (rft, docs/design/figures.md): matplotlib's settings and a few helpers
from the project's tokens, so every figure of its notebooks reads as one family.

rft copies this file into the repo's notebooks/ folder, with the project's tokens (.rft/config.json
"style") in PROJECT below: change the style there, not here, and rft writes the file again. It
needs matplotlib only once a function draws, so a notebook that draws nothing runs without it.

    import rft_style as rs
    rs.use()                         # 'paper' (the default), 'screen' or 'slide'
    fig, ax = rs.figure()            # a paper's column; 'wide', 'square'; ncols=3 for small multiples
    rs.band(ax, x, mean, sd, label="CutMix")   # a line with its spread as a pale band
    rs.baseline(ax, x, y, label="SAE")         # near-black, dotted
    rs.reference(ax, 0.42, "ceiling")          # a thin dashed line across
    rs.highlight(ax, "CutMix")       # the accent for the series the figure is about, the others grey
    rs.label_lines(ax)               # each series named at its line's end, in its colour
    rs.title(ax, "Vanilla", "BSF")   # one word in bold
    rs.legend_below(fig)             # one frameless row under small multiples
    colors = rs.ramp(4)              # an ordered parameter, light to dark
"""
from __future__ import annotations

import re

# the reference's look (Tailwind's colours, as Thomas Fel's figures use them): slate text, faint
# grids, one indigo-to-fuchsia family for an ordered parameter, a near-black dotted baseline
DEFAULT: dict = {
    "text": "#0F172B", "muted": "#62748E", "axis": "#90A1B9", "grid": "#E2E8F0", "neutral": "#A3ADBD", "fill": "#F1F5F9",
    "accent": "#8B5CF6", "contrast": "#EC003F", "baseline": "#020617",
    "categorical": ["#8E51FF", "#2B7FFF", "#F0B100", "#3F8F4E", "#EC003F", "#00B8DB"],
    "ramp": ["#A5B4FC", "#6366F1", "#8B5CF6", "#A855F7", "#C026D3"],
    "font": "Inter", "headingFont": "Inter", "background": "transparent",
}
PROJECT: dict = {}  # rft: the project's tokens

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
_LISTS = ("categorical", "ramp")
_FONTS = ("font", "headingFont")


def _valid(key: str, value) -> bool:
    if key in _LISTS:
        return isinstance(value, list) and len(value) >= 2 and all(isinstance(c, str) and _HEX.match(c) for c in value)
    if key in _FONTS:
        return isinstance(value, str) and bool(value.strip())
    if key == "background":
        return isinstance(value, str) and (value == "transparent" or bool(_HEX.match(value)))
    return isinstance(value, str) and bool(_HEX.match(value))


def resolve(project: dict) -> dict:
    """The tokens in use: the project's where they are valid, else the default's."""
    project = project if isinstance(project, dict) else {}
    return {k: (project[k] if k in project and _valid(k, project[k]) else v) for k, v in DEFAULT.items()}


#: the tokens in use
TOKENS: dict = resolve(PROJECT)

#: each medium's text, lines and figure sizes (inches): a paper's column is 3.25 in wide, a slide
#: 13.3 in at 1080p; the text keeps the same share of the figure wherever it is scaled to fit
MEDIA: dict = {
    "paper": {"size": 8, "small": 7, "title": 9, "line": 1.1, "marker": 2.8, "axis": 0.6, "grid": 0.4,
              "single": (3.25, 2.3), "wide": (6.75, 2.5), "square": (3.25, 3.0)},
    "screen": {"size": 10, "small": 9, "title": 11.5, "line": 1.6, "marker": 4.2, "axis": 0.8, "grid": 0.5,
               "single": (5.0, 3.4), "wide": (10.0, 3.6), "square": (4.6, 4.2)},
    "slide": {"size": 16, "small": 14, "title": 19, "line": 2.6, "marker": 7.0, "axis": 1.1, "grid": 0.8,
              "single": (8.0, 5.4), "wide": (13.3, 5.4), "square": (7.0, 6.6)},
}
_medium = "paper"
_FALLBACK_FONTS = ["Inter", "Helvetica Neue", "Helvetica", "Arial", "Liberation Sans", "DejaVu Sans"]


def _m(medium: str | None = None) -> dict:
    return MEDIA[medium or _medium]


def _fonts(first: str) -> list:
    """`first`, then the fallbacks, as far as matplotlib has them (one it lacks would be named in a
    warning at each figure): DejaVu Sans, which it ships, when it has none of them."""
    from matplotlib import font_manager
    have = {f.name for f in font_manager.fontManager.ttflist}
    out = [f for f in [first] + [f for f in _FALLBACK_FONTS if f != first] if f in have]
    return out or ["DejaVu Sans"]


def use(medium: str = "paper") -> bool:
    """Sets matplotlib's settings from the tokens for `medium` (paper, screen, slide). False, and
    nothing set, when matplotlib is not installed."""
    global _medium
    if medium not in MEDIA:
        raise ValueError(f"medium {medium!r}: one of {', '.join(MEDIA)}")
    try:
        import matplotlib as mpl
        from cycler import cycler
    except ImportError:
        return False
    _medium = medium
    t, m = TOKENS, MEDIA[medium]
    clear = t["background"] == "transparent"
    bg = "none" if clear else t["background"]
    fonts = _fonts(t["font"])
    settings = {
        "font.family": "sans-serif", "font.sans-serif": fonts, "font.size": m["size"],
        "text.color": t["text"], "axes.labelcolor": t["text"], "axes.titlecolor": t["text"],
        "axes.titlesize": m["title"], "axes.titleweight": "normal", "axes.titlepad": m["size"] * 0.8,
        "axes.labelsize": m["size"], "axes.labelpad": m["size"] * 0.4,
        "axes.edgecolor": t["axis"], "axes.linewidth": m["axis"],
        "axes.spines.top": False, "axes.spines.right": False,
        "axes.grid": True, "axes.axisbelow": True, "grid.color": t["grid"], "grid.linewidth": m["grid"], "grid.alpha": 1.0,
        "axes.prop_cycle": cycler(color=t["categorical"]),
        "axes.xmargin": 0.03, "axes.ymargin": 0.06,
        "xtick.color": t["axis"], "ytick.color": t["axis"], "xtick.labelcolor": t["muted"], "ytick.labelcolor": t["muted"],
        "xtick.labelsize": m["small"], "ytick.labelsize": m["small"],
        "xtick.major.width": m["axis"], "ytick.major.width": m["axis"], "xtick.major.size": m["size"] * 0.35, "ytick.major.size": m["size"] * 0.35,
        "lines.linewidth": m["line"], "lines.markersize": m["marker"], "lines.solid_capstyle": "round", "lines.dash_capstyle": "round",
        "patch.linewidth": 0, "patch.edgecolor": "none",
        "legend.frameon": False, "legend.fontsize": m["small"], "legend.labelcolor": t["text"], "legend.handlelength": 1.6,
        "figure.facecolor": bg, "axes.facecolor": bg, "savefig.facecolor": bg, "savefig.transparent": clear,
        "savefig.bbox": "tight", "savefig.pad_inches": 0.04, "figure.dpi": 150, "savefig.dpi": 300,
        "pdf.fonttype": 42, "ps.fonttype": 42, "mathtext.fontset": "dejavusans",
        "image.cmap": "rft_seq",
    }
    _register_cmaps()
    mpl.rcParams.update({k: v for k, v in settings.items() if k in mpl.rcParams})
    return True


def _register_cmaps() -> None:
    import matplotlib as mpl
    from matplotlib.colors import LinearSegmentedColormap
    t = TOKENS
    maps = {
        "rft_ramp": LinearSegmentedColormap.from_list("rft_ramp", t["ramp"]),
        "rft_seq": LinearSegmentedColormap.from_list("rft_seq", [t["fill"], t["accent"], t["text"]]),
        "rft_div": LinearSegmentedColormap.from_list("rft_div", [t["contrast"], t["fill"], t["accent"]]),
    }
    import warnings
    for name, cmap in maps.items():
        with warnings.catch_warnings():  # registered again on each use(): not worth a warning
            warnings.simplefilter("ignore")
            try:
                mpl.colormaps.register(cmap, name=name, force=True)
            except AttributeError:  # matplotlib before 3.5
                import matplotlib.cm as cm
                cm.register_cmap(name=name, cmap=cmap)


def figure(kind: str = "single", nrows: int = 1, ncols: int = 1, medium: str | None = None, **kw):
    """A figure of the medium's size (`single`: a paper's column; `wide`; `square`), its axes laid
    out to fit: `fig, ax`, or `fig, axes` for several. Small multiples (ncols > 1) are wide."""
    import matplotlib.pyplot as plt
    m = _m(medium)
    if kind not in ("single", "wide", "square"):
        raise ValueError(f"kind {kind!r}: single, wide or square")
    if ncols > 1 and kind == "single":
        kind = "wide"
    w, h = m[kind]
    if nrows > 1:
        h = h * (0.85 * nrows)
    kw.setdefault("figsize", (w, h))
    try:
        return plt.subplots(nrows, ncols, layout="constrained", **kw)
    except TypeError:  # matplotlib before 3.5
        return plt.subplots(nrows, ncols, constrained_layout=True, **kw)


def colors(n: int) -> list:
    """The first `n` categorical colours, in order (again from the first after the last)."""
    c = TOKENS["categorical"]
    return [c[i % len(c)] for i in range(n)]


def ramp(n: int) -> list:
    """`n` colours of the ramp, light to dark, for the levels of an ordered parameter (K = 2, 4, 8…)."""
    r = TOKENS["ramp"]
    if n <= 0:
        return []
    if n == 1:
        return [r[len(r) // 2]]
    if n == len(r):
        return list(r)
    from matplotlib.colors import LinearSegmentedColormap, to_hex
    cmap = LinearSegmentedColormap.from_list("rft_ramp", r)
    return [to_hex(cmap(i / (n - 1))).upper() for i in range(n)]


def band(ax, x, y, spread=None, *, color=None, label=None, marker="o", alpha=0.16, **kw):
    """A line with markers, and its spread as a pale band of its colour: `spread` is ± one value (an
    sd) or a pair (low, high). Its line."""
    import numpy as np
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    line, = ax.plot(x, y, marker=marker, color=color, label=label, zorder=2.5, **kw)
    line._rft_role = "series"
    if spread is not None:
        if isinstance(spread, (tuple, list)) and len(spread) == 2 and np.ndim(spread[0]) > 0:
            lo, hi = np.asarray(spread[0], dtype=float), np.asarray(spread[1], dtype=float)
        else:
            s = np.asarray(spread, dtype=float)
            lo, hi = y - s, y + s
        poly = ax.fill_between(x, lo, hi, color=line.get_color(), alpha=alpha, linewidth=0, zorder=2, label="_band")
        line._rft_band = poly
    return line


def baseline(ax, x, y, label="baseline", **kw):
    """A baseline: near-black, dotted, small markers. Its line."""
    m = _m()
    kw.setdefault("marker", "o")
    kw.setdefault("markersize", m["marker"] * 0.7)
    line, = ax.plot(x, y, color=TOKENS["baseline"], linestyle=(0, (1, 1.6)), linewidth=m["line"] * 0.9, label=label, zorder=2.2, **kw)
    line._rft_role = "baseline"
    return line


def reference(ax, value, label=None, *, axis="y", annotate=False):
    """A ceiling, a floor or a target: a thin dashed line across the axes, named in the legend (or,
    with `annotate`, at its end, where nothing else is). Its line."""
    m, t = _m(), TOKENS
    style = dict(color=t["muted"], linestyle=(0, (4, 3)), linewidth=m["axis"] * 1.3, zorder=1.5, label=label or "_reference")
    line = ax.axhline(value, **style) if axis == "y" else ax.axvline(value, **style)
    line._rft_role = "reference"
    if label and annotate:
        line.set_label(f"_{label}")
        if axis == "y":
            ax.annotate(label, xy=(1, value), xycoords=("axes fraction", "data"), xytext=(0, 2), textcoords="offset points",
                        ha="right", va="bottom", color=t["muted"], fontsize=m["small"])
        else:
            ax.annotate(label, xy=(value, 1), xycoords=("data", "axes fraction"), xytext=(3, 0), textcoords="offset points",
                        ha="left", va="top", color=t["muted"], fontsize=m["small"], rotation=90)
    return line


def highlight(ax, *labels, color=None):
    """The series named `labels` stand out (one in the accent, or `color`; several keep theirs), every
    other series turns grey behind them. Baselines and references keep their look."""
    t = TOKENS
    keep = set(labels)
    for line in ax.get_lines():
        role = getattr(line, "_rft_role", "series")
        if role in ("baseline", "reference") or line.get_label().startswith("_"):
            continue
        band_ = getattr(line, "_rft_band", None)
        if line.get_label() in keep:
            c = color or (t["accent"] if len(keep) == 1 else line.get_color())
            line.set_color(c)
            line.set_zorder(3)
            if band_ is not None:
                band_.set_color(c)
                band_.set_zorder(2.4)
        else:
            line.set_color(t["neutral"])
            line.set_zorder(2.1)
            if band_ is not None:
                band_.set_color(t["neutral"])
                band_.set_alpha(0.25)
                band_.set_zorder(1.9)


def label_lines(ax, *, gap: float | None = None, bold: bool = False):
    """Each named series labelled at its line's end, in its colour, in place of a legend; labels that
    would touch are moved apart. The labels."""
    import numpy as np
    m = _m()
    ax.autoscale_view()
    rows = []
    for line in ax.get_lines():
        label = line.get_label()
        if label.startswith("_") or getattr(line, "_rft_role", "series") == "reference":
            continue
        x, y = np.asarray(line.get_xdata(), dtype=float), np.asarray(line.get_ydata(), dtype=float)
        ok = np.isfinite(x) & np.isfinite(y)
        if not ok.any():
            continue
        i = np.flatnonzero(ok)[-1]
        rows.append((line, label, x[i], y[i], ax.transData.transform((x[i], y[i]))[1]))
    if ax.get_legend() is not None:
        ax.get_legend().remove()
    if not rows:
        return []
    # moved apart from the bottom up, at least one line of text between two labels (in pixels)
    px = (gap or m["small"] * 1.25) * ax.figure.dpi / 72
    rows.sort(key=lambda r: r[4])
    placed = []
    for r in rows:
        want = r[4]
        if placed and want < placed[-1] + px:
            want = placed[-1] + px
        placed.append(want)
    shift = (placed[-1] - rows[-1][4]) / 2 if len(rows) > 1 else 0  # centred on where they belong
    out = []
    for (line, label, x, y, d), p in zip(rows, placed):
        dy = (p - d - shift) * 72 / ax.figure.dpi
        out.append(ax.annotate(label, xy=(x, y), xytext=(m["size"] * 0.6, dy), textcoords="offset points", va="center", ha="left",
                               color=line.get_color(), fontsize=m["small"], fontweight="bold" if bold else "normal", annotation_clip=False))
    return out


def title(ax, bold: str, rest: str = "", *, color=None, loc: str = "center"):
    """A title with one word (or a few) in bold, the rest in the regular weight: `title(ax, "Vanilla",
    "BSF")`. `color` colours the bold part, so the title is also the series' legend."""
    from matplotlib.offsetbox import AnchoredOffsetbox, HPacker, TextArea
    m, t = _m(), TOKENS
    size = m["title"]
    # the title's place kept by an invisible one of the same text, so the layout makes room for it
    ax.set_title(f"{bold} {rest}".strip(), color="none", fontsize=size, fontweight="bold", loc=loc)
    head = {"fontsize": size, "fontfamily": _fonts(t["headingFont"])}
    parts = [TextArea(bold, textprops={**head, "fontweight": "bold", "color": color or t["text"]})]
    if rest:
        parts.append(TextArea(rest, textprops={**head, "fontweight": "normal", "color": t["text"]}))
    from matplotlib.transforms import ScaledTranslation
    # as high as the title it stands for: matplotlib puts a title its pad (axes.titlepad) above the axes
    lift = ScaledTranslation(0, m["size"] * 0.8 / 72, ax.figure.dpi_scale_trans)
    box = AnchoredOffsetbox(loc={"center": "lower center", "left": "lower left", "right": "lower right"}[loc],
                            child=HPacker(children=parts, align="baseline", pad=0, sep=size * 0.3),
                            bbox_to_anchor=({"center": 0.5, "left": 0.0, "right": 1.0}[loc], 1.0), bbox_transform=ax.transAxes + lift,
                            frameon=False, pad=0, borderpad=0)
    box.set_zorder(5)
    ax.add_artist(box)
    return box


def legend_below(fig, axes=None, ncol: int | None = None):
    """One frameless legend row under the figure, the series of every axes once (each axes' own
    legend removed). The legend."""
    handles, labels = [], []
    for ax in axes if axes is not None else fig.axes:
        for h, l in zip(*ax.get_legend_handles_labels()):
            if not l.startswith("_") and l not in labels:
                handles.append(h)
                labels.append(l)
        if ax.get_legend() is not None:
            ax.get_legend().remove()
    if not labels:
        return None
    n = ncol or min(len(labels), 6)
    try:
        return fig.legend(handles, labels, loc="outside lower center", ncol=n, frameon=False)
    except ValueError:  # matplotlib before 3.7: below the axes by hand
        return fig.legend(handles, labels, loc="upper center", bbox_to_anchor=(0.5, 0.0), ncol=n, frameon=False)
