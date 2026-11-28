#!/usr/bin/env python3
"""The two real kits the documents are held to (tests/test_kits.py and what follows them): the ICML
2027 style files, and Aalborg University's PhD thesis as a collection of papers. They are fetched
into a cache outside the repo and never committed: their licences are not ours to settle.

    python3 tests/fetch_kits.py            fetch what is missing
    python3 tests/fetch_kits.py --again    fetch both again

The cache is $RFT_KITS, else ~/.cache/rft-plugin/kits. Each kit is a folder there (`icml2027/`,
`aau-thesis/`) and `kits.json` records where each came from, when, and the SHA-256 of what was
downloaded. Standard library only; a request carries nothing but a generic client name.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

KITS = {
    # name: where its zip is, the folder of the zip that is the kit ('' when the zip is the kit), its main file
    "icml2027": {"url": "https://media.icml.cc/Conferences/ICML2027/styles/icml2027.zip", "folder": "", "main": "example_paper.tex"},
    "aau-thesis": {"url": "https://github.com/jkjaer/aauLatexTemplates/archive/refs/heads/master.zip", "folder": "aauPhdCollectionThesis", "main": "master.tex"},
}
RECORD = "kits.json"


def cache() -> Path:
    """Where the kits are kept: $RFT_KITS, else ~/.cache/rft-plugin/kits."""
    return Path(os.environ.get("RFT_KITS") or Path.home() / ".cache" / "rft-plugin" / "kits")


def kit(name: str) -> Path | None:
    """A kit's folder, when it has been fetched (its main file is there); else None."""
    folder = cache() / name
    return folder if (folder / KITS[name]["main"]).is_file() else None


def missing(name: str) -> str:
    """What a test that needs a kit says when it skips."""
    return f"the {name} kit is not in {cache()}: python3 tests/fetch_kits.py fetches it"


def kit_zip(name: str) -> Path | None:
    """The zip a kit was fetched as (kept beside it, for the tests that load a zip); else None."""
    z = cache() / f"{name}.zip"
    return z if z.is_file() else None


def _members(z: zipfile.ZipFile, folder: str) -> list[tuple[zipfile.ZipInfo, str]]:
    """The files of a zip under `folder` (a folder at any depth; '': the zip's own top folder when
    it has just one, else its root), each with its path inside the kit."""
    names = [i for i in z.infolist() if not i.is_dir()]
    if folder:
        out = []
        for i in names:
            parts = i.filename.split("/")
            if folder in parts[:-1]:
                out.append((i, "/".join(parts[parts.index(folder) + 1:])))
        return out
    tops = {i.filename.split("/")[0] for i in names if "/" in i.filename}
    lone = len(tops) == 1 and all("/" in i.filename for i in names)
    return [(i, i.filename.split("/", 1)[1] if lone else i.filename) for i in names]


def fetch(name: str) -> dict:
    """Downloads a kit's zip, unpacks the kit into the cache, and answers its record."""
    spec = KITS[name]
    req = urllib.request.Request(spec["url"], headers={"User-Agent": "kit-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=120) as res:
        data = res.read()
    root = cache()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / name
    if folder.exists():
        shutil.rmtree(folder)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info, rel in _members(z, spec["folder"]):
            parts = Path(rel).parts
            if not rel or Path(rel).is_absolute() or ".." in parts or "__MACOSX" in parts:
                continue
            target = folder / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(info))
        # the kit as a zip of its own, as a user would load it
        with zipfile.ZipFile(root / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as out:
            for p in sorted(folder.rglob("*")):
                if p.is_file():
                    out.write(p, f"{name}/{p.relative_to(folder).as_posix()}")
    if not (folder / spec["main"]).is_file():
        raise RuntimeError(f"{name}: {spec['main']} is not in what {spec['url']} gave")
    return {"url": spec["url"], "folder": spec["folder"], "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "files": sum(1 for p in folder.rglob("*") if p.is_file()), "fetched": time.strftime("%Y-%m-%d")}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--again", action="store_true", help="fetch the kits that are already there too")
    a = p.parse_args(argv)
    record_path = cache() / RECORD
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = {}
    failed = 0
    for name in KITS:
        if kit(name) and kit_zip(name) and not a.again:
            print(f"{name}: already in {cache() / name}")
            continue
        try:
            record[name] = fetch(name)
            print(f"{name}: {record[name]['files']} files in {cache() / name} (sha256 {record[name]['sha256'][:16]}…, from {record[name]['url']})")
        except Exception as err:  # noqa: BLE001 (a kit that cannot be fetched is said, the other still tried)
            failed += 1
            print(f"{name}: not fetched ({err})", file=sys.stderr)
    cache().mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
