"""Downloads the open-access papers of reference notes into the vault, in the background.

The plugin (hooks/register.tsx, rft_collect_papers) starts it with a list of jobs and reads one
line per job on stdout:

    RFT_PAPER {"id": "R03", "ok": true, "file": "papers/Strong augmentation/2021 Smith Mixup at scale.pdf"}
    RFT_PAPER {"id": "R04", "ok": false, "error": "..."}
    RFT_PAPERS_DONE {"ok": 1, "failed": 1}

A job fetches a paper (`{"op": "fetch", "id", "arxiv" | "url", "dir", "title", "year"}`) or moves
one already saved to the folder of the note's concept now (`{"op": "move", "id", "from", "dir"}`).
Paths are relative to the vault and stay inside its `papers/` folder. Only arXiv and the hosts
given with --hosts (open-access proceedings) are downloaded from, and only files that are PDFs.
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

USER_AGENT = "rft-plugin (https://github.com/GianniMoretti/rft-plugin)"
MAX_BYTES = 60 * 1024 * 1024
TIMEOUT_S = 60
ARXIV_API = "https://export.arxiv.org/api/query?id_list={}"
ARXIV_PDF = "https://arxiv.org/pdf/{}"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
# characters that break file names or Obsidian links
FORBIDDEN = re.compile(r'[\^#|\[\]\\/:*"<>?]')


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", FORBIDDEN.sub(" ", text or "")).strip()


def file_name(year: str, author: str, title: str) -> str:
    """`<year> <first author's surname> <first words of the title>.pdf`, safe as a file name."""
    words = clean(title).split(" ")
    short = " ".join(words[:7])
    parts = [p for p in (clean(year)[:4], clean(author), short) if p]
    return (" ".join(parts) or "paper")[:120].rstrip(" .") + ".pdf"


def surname(name: str) -> str:
    parts = clean(name).split(" ")
    return parts[-1] if parts else ""


def parse_arxiv(xml: bytes) -> dict:
    """Title, first author's surname and year from an arXiv API answer."""
    entry = ET.fromstring(xml).find("a:entry", ATOM)
    if entry is None or entry.find("a:title", ATOM) is None:
        raise ValueError("arXiv has no such paper")
    title = " ".join((entry.findtext("a:title", "", ATOM)).split())
    authors = [a.findtext("a:name", "", ATOM) for a in entry.findall("a:author", ATOM)]
    year = (entry.findtext("a:published", "", ATOM) or "")[:4]
    return {"title": title, "author": surname(authors[0]) if authors else "", "year": year}


def get(url: str, hosts: tuple[str, ...], limit: int = MAX_BYTES) -> bytes:
    """The body at `url`, only from an allowed host (https, or http for a local test host)."""
    u = urllib.parse.urlsplit(url)
    if u.hostname not in hosts or u.scheme not in ("https", "http"):
        raise ValueError(f"{u.hostname or url} is not an open-access source this plugin downloads from")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        final = urllib.parse.urlsplit(r.geturl()).hostname
        if final not in hosts:
            raise ValueError(f"redirected to {final}, not an open-access source")
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("the file is too large")
    return data


def inside(vault: Path, rel: str) -> Path:
    """`rel` under the vault's papers/ folder, or an error."""
    path = (vault / rel).resolve()
    papers = (vault / "papers").resolve()
    if papers not in path.parents and path != papers:
        raise ValueError(f"{rel} is outside the vault's papers/ folder")
    return path


def unique(folder: Path, name: str, data: bytes | None = None) -> Path:
    """`name` in `folder`, numbered when another file already has it (the same content reuses it)."""
    path = folder / name
    n = 2
    while path.exists():
        if data is not None and path.read_bytes() == data:
            return path
        path = folder / f"{name[:-4]} ({n}).pdf"
        n += 1
    return path


def fetch(job: dict, vault: Path, hosts: tuple[str, ...]) -> str:
    meta = {"title": job.get("title") or "", "author": "", "year": job.get("year") or ""}
    if job.get("arxiv"):
        aid = job["arxiv"]
        meta = parse_arxiv(get(ARXIV_API.format(urllib.parse.quote(aid)), hosts))
        url = ARXIV_PDF.format(aid)
    else:
        url = job["url"]
    data = get(url, hosts)
    if not data.startswith(b"%PDF"):
        raise ValueError("the source did not answer with a PDF")
    folder = inside(vault, job["dir"])
    folder.mkdir(parents=True, exist_ok=True)
    path = unique(folder, file_name(meta["year"], meta["author"], meta["title"]), data)
    if not path.exists():
        tmp = path.with_name(f".{path.name}.part")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    return path.relative_to(vault.resolve()).as_posix()


def move(job: dict, vault: Path) -> str:
    src = inside(vault, job["from"])
    if not src.is_file():
        raise ValueError(f"{job['from']} is missing")
    folder = inside(vault, job["dir"])
    folder.mkdir(parents=True, exist_ok=True)
    dst = unique(folder, src.name, src.read_bytes())
    if dst != src:
        os.replace(src, dst)
        try:
            src.parent.rmdir()  # the old concept's folder, once empty
        except OSError:
            pass
    return dst.relative_to(vault.resolve()).as_posix()


def run(jobs: list[dict], vault: Path, hosts: tuple[str, ...], out=sys.stdout, pause: float = 1.0) -> dict:
    done = {"ok": 0, "failed": 0}
    last_arxiv = 0.0
    for job in jobs:
        try:
            if job.get("op") == "move":
                rel = move(job, vault)
            else:
                if job.get("arxiv"):
                    # arXiv asks for a pause between requests
                    time.sleep(max(0.0, pause - (time.monotonic() - last_arxiv)))
                    last_arxiv = time.monotonic()
                rel = fetch(job, vault, hosts)
            line = {"id": job["id"], "ok": True, "file": rel}
            done["ok"] += 1
        except Exception as e:  # one paper failing never stops the others
            line = {"id": job.get("id"), "ok": False, "error": str(e) or type(e).__name__}
            done["failed"] += 1
        print(f"RFT_PAPER {json.dumps(line)}", file=out, flush=True)
    print(f"RFT_PAPERS_DONE {json.dumps(done)}", file=out, flush=True)
    return done


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Download open-access papers into an rft vault.")
    ap.add_argument("--vault", required=True)
    ap.add_argument("--jobs", required=True, help="the jobs as a JSON list")
    ap.add_argument("--hosts", required=True, help="comma-separated hosts to download from")
    a = ap.parse_args(argv)
    run(json.loads(a.jobs), Path(a.vault), tuple(h for h in a.hosts.split(",") if h))
    return 0


if __name__ == "__main__":
    sys.exit(main())
