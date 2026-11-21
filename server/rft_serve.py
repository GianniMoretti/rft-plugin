#!/usr/bin/env python3
"""Serves a project's tree view from a terminal, until Ctrl+C: no Claude Code chat needs to stay open.

    python3 /path/to/rft-plugin/server/rft_serve.py [folder] [--port N]

The tree is the one a chat in `folder` (default: the current folder) works on: the nearest
`.rft/config.json` from there up, followed when it is a link (`{"tree": "../notes"}`), as the plugin
finds it. The address is the one /rft prints, key included, on the config's `webPort` (or `--port`;
with neither, a free port).

What the page asks of the session (Add child, Change type, Move, Verify, the Manuscript's changes,
Ask Claude) a chat makes: one that runs /rft on the tree, which then shows this address and takes
those requests from here. With no such chat they are refused, and the rest of the page works. A
chat that serves the tree on the same port keeps it until it ends; this terminal serves it then.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import rft_server

CONFIG_PATH = os.path.join(".rft", "config.json")
NOT_ACTIVE = "RFT is not active here: no .rft/config.json in this folder or a folder above it (/rft-init in a chat makes one)"


class NoTree(Exception):
    pass


def link_in(path: str) -> str | None:
    """The target of a config that is a link to a tree elsewhere, else None."""
    try:
        tree = json.loads(Path(path).read_text()).get("tree")
    except (OSError, ValueError, AttributeError):
        return None
    return tree.strip() if isinstance(tree, str) and tree.strip() else None


def locate(start: str) -> str:
    """The tree's folder for a chat in `start`, as hooks/lib/vault.ts locate() finds it."""
    folder = os.path.abspath(start)
    while True:
        file = os.path.join(folder, CONFIG_PATH)
        if os.path.exists(file):
            target = link_in(file)
            if target is None:
                return folder
            root = os.path.normpath(os.path.join(folder, target))
            there = os.path.join(root, CONFIG_PATH)
            if not os.path.exists(there):
                raise NoTree(f"{file} links to {root}, which holds no reasoning tree (no {CONFIG_PATH})")
            if link_in(there) is not None:
                raise NoTree(f"{file} links to {root}, which is itself a link: point it at the tree's own folder")
            return root
        up = os.path.dirname(folder)
        if up == folder:
            raise NoTree(NOT_ACTIVE)
        folder = up


def server_args(start: str, port: int | None = None) -> list[str]:
    """rft_server.py's arguments for the tree a chat in `start` works on, as the plugin's /rft gives them."""
    root = locate(start)
    config = os.path.join(root, CONFIG_PATH)
    try:
        raw = json.loads(Path(config).read_text())
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    vault = raw.get("vault") if isinstance(raw.get("vault"), str) and raw.get("vault") else "vault"
    vault = os.path.normpath(os.path.join(root, vault))
    if not os.path.isdir(vault):
        raise NoTree(f"the vault {vault} that {config} names is not there")
    project = raw.get("project") if isinstance(raw.get("project"), str) and raw.get("project") else "project"
    if port is None:
        port = raw.get("webPort") if isinstance(raw.get("webPort"), int) and not isinstance(raw.get("webPort"), bool) else 0
    web = Path(__file__).resolve().parents[1] / "web"
    return ["--vault", vault, "--web", str(web), "--project", project, "--port", str(port),
            "--config", config, "--no-watch", "--terminal"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("folder", nargs="?", default=".", help="a folder of the project (default: the current one)")
    ap.add_argument("--port", type=int, default=None, help="the port (default: the config's webPort, else a free one)")
    a = ap.parse_args(argv)
    try:
        args = server_args(a.folder, a.port)
    except NoTree as err:
        print(f"rft: {err}", file=sys.stderr)
        return 1
    rft_server.main(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
