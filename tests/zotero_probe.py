"""A live probe of zotero.org: with the user's own key, it asks zotero.org the questions the Zotero
sync's design leans on and prints each answer beside what the design expects. The facts in the
design were read from Zotero's documentation and never run; this is where they are checked, before
any code of the sync is written.

    export ZOTERO_API_KEY=...        # made at https://www.zotero.org/settings/keys/new, with read
                                     # and write on the personal library; never pasted in a chat
    python3 tests/zotero_probe.py                 # the table, and nothing kept
    python3 tests/zotero_probe.py --record tests/fixtures/zotero   # the answers saved, for the fake
    python3 tests/zotero_probe.py --pause         # stops before it cleans up, to try the links
    python3 tests/zotero_probe.py --try-url       # also asks zotero.org to make an item from a URL

It works in a scratch collection it makes in the library, and at its end deletes only what it made,
each by its key: no other item or collection of the library is changed. Of the library's own items
it reads how many there are and the library's version, never what they are. `--try-url` is apart
because zotero.org then makes the item itself: when its answer does not name the item, the probe
cannot tell it from one the user added meanwhile, so it deletes nothing and says what to look for.

What is recorded has the key, the user's id and their names taken out, and holds the probe's own
items alone. The files may be committed and pushed: read them before they are.

It exits 0 when every answer is as expected, 1 when one differs (the design is then changed first),
2 when it could not run. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.zotero.org"
DOI = "https://doi.org"
AGENT = "rft-zotero-probe"
KEY_PAGE = "https://www.zotero.org/settings/keys/new"
A_DOI = "10.1038/nature14539"  # a paper every resolver knows
A_URL = "https://arxiv.org/abs/1706.03762"
TIMEOUT_S = 30
KEPT_HEADERS = ("Last-Modified-Version", "Total-Results", "Backoff", "Retry-After", "Link", "Content-Type")


class Answer:
    def __init__(self, status: int, headers, text: str, url: str = ""):
        self.status, self.text, self.url = status, text, url
        self.headers = {k: headers[k] for k in KEPT_HEADERS if headers.get(k) is not None}
        try:
            self.json = json.loads(text) if text else None
        except ValueError:
            self.json = None

    @property
    def version(self) -> int | None:
        v = self.headers.get("Last-Modified-Version")
        return int(v) if v and v.isdigit() else None


class Probe:
    """The calls, what each was expected to answer and what it answered, and what was made on the
    way (so that it can be deleted, and nothing else)."""

    def __init__(self, api: str, key: str, out=sys.stdout, sleep=time.sleep):
        self.api, self.key, self.out, self.sleep = api.rstrip("/"), key, out, sleep
        self.user = ""
        self.names: list[str] = []  # the user's id and names, taken out of what is recorded
        self.calls: list[dict] = []
        self.rows: list[dict] = []
        self.items: list[str] = []  # made here, by key, and not deleted yet
        self.collections: list[str] = []
        self.mine: set[str] = set()  # every key made here: all that is recorded of the library
        self.slowed: list[str] = []
        self.step = ""

    # ------------------------------------------------------------ the calls

    def call(self, method: str, path: str, body=None, headers: dict | None = None, base: str | None = None, keep_body: bool = True) -> Answer:
        url = (base or self.api) + path
        data = None if body is None else json.dumps(body).encode()
        send = {"User-Agent": AGENT, **(headers or {})}
        if base is None:
            send.update({"Zotero-API-Key": self.key, "Zotero-API-Version": "3"})
        if data is not None:
            send["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=send)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                got = Answer(r.status, r.headers, r.read().decode("utf-8", errors="replace"), r.geturl())
        except urllib.error.HTTPError as e:  # any answer that is not a 2xx, a 304 among them
            got = Answer(e.code, e.headers, e.read().decode("utf-8", errors="replace"), e.geturl() or url)
        asked = {k: v for k, v in send.items() if k not in ("Zotero-API-Key", "User-Agent")}
        self.calls.append({"step": self.step, "method": method, "path": path if base is None else url, "asked": asked, "body": body,
                           "status": got.status, "headers": got.headers, "answer": (got.json if got.json is not None else got.text) if keep_body else "(not recorded: the user's own library)"})
        for name in ("Backoff", "Retry-After"):
            if got.headers.get(name):
                self.slowed.append(f"{name}: {got.headers[name]} (after {method} {path})")
                wait = got.headers[name]
                self.sleep(min(int(wait), 60) if wait.isdigit() else 5)
        return got

    def lib(self, path: str) -> str:
        return f"/users/{self.user}{path}"

    def row(self, what: str, expected: str, answered: str, ok: bool | None) -> bool:
        """One line of the table: `ok` None is something only noted, with nothing expected of it."""
        self.rows.append({"what": what, "expected": expected, "answered": answered, "ok": ok})
        mark = {True: "as expected", False: "DIFFERS", None: "noted"}[ok]
        print(f"\n[{mark}] {len(self.rows)}. {what}\n    expected: {expected}\n    answered: {answered}", file=self.out)
        return ok is not False

    # ------------------------------------------------------------ the steps

    def who(self) -> bool:
        self.step = "the key"
        got = self.call("GET", "/keys/current")
        d = got.json if isinstance(got.json, dict) else {}
        access = (d.get("access") or {}).get("user") or {}
        self.user = str(d.get("userID") or "")
        self.names = [str(d[k]) for k in ("username", "displayName") if d.get(k)]
        ok = got.status == 200 and bool(self.user) and access.get("library") is True and access.get("write") is True
        self.row("the key says whose it is and what it may do",
                 "200, with the user's id, and read and write on the personal library",
                 f"{got.status}; a user id: {'yes' if self.user else 'no'}; library: {access.get('library')}; write: {access.get('write')}; notes: {access.get('notes')}", ok)
        return ok

    def made(self, got: Answer, n: int = 0) -> tuple[str, int | None]:
        """The key and the version of the n-th object a write made, wherever the answer says it."""
        d = got.json if isinstance(got.json, dict) else {}
        full = (d.get("successful") or {}).get(str(n)) or {}
        key = full.get("key") or (d.get("success") or {}).get(str(n)) or ""
        return key, full.get("version") or got.version

    def collection(self, name: str, parent: str | None = None) -> tuple[str, int | None, Answer]:
        got = self.call("POST", self.lib("/collections"), [{"name": name, "parentCollection": parent or False}])
        key, version = self.made(got)
        if key:
            self.collections.append(key)
            self.mine.add(key)
        return key, version, got

    def item(self, fields: dict) -> tuple[str, int | None, Answer]:
        got = self.call("POST", self.lib("/items"), [fields])
        key, version = self.made(got)
        if key:
            self.items.append(key)
            self.mine.add(key)
        return key, version, got

    def since(self, version: int | None, trashed: bool = False) -> dict:
        got = self.call("GET", self.lib(f"/items?since={version}&format=versions" + ("&includeTrashed=1" if trashed else "")))
        d = got.json if isinstance(got.json, dict) else {}
        # recorded: the probe's own items alone (the user may have changed one of theirs meanwhile)
        self.calls[-1]["answer"] = {k: v for k, v in d.items() if k in self.mine}
        return d

    def deleted(self, version: int | None) -> dict:
        got = self.call("GET", self.lib(f"/deleted?since={version}"))
        d = got.json if isinstance(got.json, dict) else {}
        self.calls[-1]["answer"] = {k: ([x for x in v if x in self.mine] if k in ("items", "collections") else []) for k, v in d.items() if isinstance(v, list)}
        return d

    def keys_in(self, collection: str) -> list[str]:
        got = self.call("GET", self.lib(f"/collections/{collection}/items/top?format=keys"))
        return sorted(k for k in got.text.split("\n") if k)

    def run(self, try_url: bool = False, doi: str | None = DOI, pause=None) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")

        self.step = "collections"
        top, _, got = self.collection(f"rft probe {stamp}")
        d = got.json if isinstance(got.json, dict) else {}
        said = [k for k in ("successful", "success", "unchanged", "failed") if k in d]
        if not self.row("a collection made", '200; the new key under "successful" (the whole object) and under "success" (the key alone); "unchanged" and "failed" there too',
                        f"{got.status}; keys of the answer: {', '.join(said) or 'none'}; a key: {'yes' if top else 'no'}",
                        got.status == 200 and bool(top) and {"successful", "success", "failed"} <= set(said)) or not top:
            return
        sub, sub_version, got = self.collection("a search", top)
        disc, _, _ = self.collection("Discarded", top)
        got = self.call("GET", self.lib(f"/collections/{top}/collections"))
        under = sorted(c.get("key") for c in got.json) if isinstance(got.json, list) else []
        self.row("the collections inside a collection are listed", "200, with the two collections made inside it, each naming it as its parent",
                 f"{got.status}; {len(under)} listed, the two made here: {under == sorted([sub, disc])}", got.status == 200 and under == sorted([sub, disc]))

        self.step = "items"
        a, a_version, got = self.item({"itemType": "preprint", "title": "rft probe item A", "url": "https://example.org/rft-probe-a", "collections": [sub]})
        full = ((got.json or {}).get("successful") or {}).get("0") or {} if isinstance(got.json, dict) else {}
        placed = (full.get("data") or {}).get("collections")
        page = ((full.get("links") or {}).get("alternate") or {}).get("href", "")
        if not self.row("an item made with its collection set", "200; the item under \"successful\" with its collections as sent, and the library's version on the answer",
                        f"{got.status}; a key: {'yes' if a else 'no'}; its collections as sent: {placed == [sub]}; Last-Modified-Version: {got.version}",
                        got.status == 200 and bool(a) and placed == [sub] and got.version is not None) or not a:
            return
        self.row("the address of an item's page on zotero.org", "the item names it (links.alternate.href): what the panel links to on a phone",
                 f"{'named' if page else 'not named'}{': ' + self.scrub(page) if page else ''}", bool(page))
        b, b_version, got = self.item({"itemType": "webpage", "title": "rft probe item B", "url": "https://example.org/rft-probe-b"})
        before = got.version
        if not b:
            self.row("an item made in no collection", "200, with its key", f"{got.status}", False)
            return

        self.step = "an item added to a collection"
        got = self.call("PATCH", self.lib(f"/items/{b}"), {"collections": [top]}, {"If-Unmodified-Since-Version": str(b_version)})
        changed = self.since(before)
        self.row("an item already in the library is added to a collection", "204; its version changes, and asking what changed since the version before names it",
                 f"{got.status}; the library's version went from {before} to {got.version}; named as changed: {b in changed}",
                 got.status == 204 and got.version is not None and before is not None and got.version > before and b in changed)
        b_version = changed.get(b, got.version)
        self.row("a collection lists its own items, not those of the collections inside it", "the top collection lists B alone; the one inside it lists A",
                 f"top: {self.keys_in(top) == [b]}; inside: {self.keys_in(sub) == [a]}", self.keys_in(top) == [b] and self.keys_in(sub) == [a])

        self.step = "an item in two collections"
        before = got.version
        got = self.call("PATCH", self.lib(f"/items/{a}"), {"collections": [sub, disc]}, {"If-Unmodified-Since-Version": str(a_version)})
        changed = self.since(before)
        both = self.call("GET", self.lib(f"/items/{a}"))
        held = sorted(((both.json or {}).get("data") or {}).get("collections") or []) if isinstance(both.json, dict) else []
        self.row("an item put in a second collection is in both", "204; the item lists both collections, and is named as changed",
                 f"{got.status}; in both: {held == sorted([sub, disc])}; named as changed: {a in changed}", got.status == 204 and held == sorted([sub, disc]) and a in changed)
        a_version = changed.get(a, got.version)

        self.step = "an item taken out of its collection"
        before = got.version
        got = self.call("PATCH", self.lib(f"/items/{b}"), {"collections": []}, {"If-Unmodified-Since-Version": str(b_version)})
        changed = self.since(before)
        listed = self.deleted(before).get("items") or []
        self.row("an item taken out of its collection, and still in the library", "204; named as changed, not as deleted: the sync sees it is no longer in the project",
                 f"{got.status}; named as changed: {b in changed}; named as deleted: {b in listed}", got.status == 204 and b in changed and b not in listed)
        b_version = changed.get(b, got.version)

        self.step = "an item in the trash"
        before = got.version
        got = self.call("PATCH", self.lib(f"/items/{b}"), {"deleted": 1}, {"If-Unmodified-Since-Version": str(b_version)})
        plain, with_trash = self.since(before), self.since(before, trashed=True)
        listed = self.deleted(before).get("items") or []
        seen = self.call("GET", self.lib(f"/items/{b}"))
        flag = ((seen.json or {}).get("data") or {}).get("deleted") if isinstance(seen.json, dict) else None
        self.row("an item moved to the trash", "204; the item says it is deleted (data.deleted), it is named as changed when the trash is asked for too, and it is not among the deleted",
                 f"{got.status}; data.deleted: {flag}; named as changed: {b in plain} (plainly), {b in with_trash} (with includeTrashed=1); named as deleted: {b in listed}",
                 got.status == 204 and bool(flag) and b in with_trash and b not in listed)
        self.row("whether a plain listing of what changed leaves out the trash", "not known from the documentation: the sync asks with includeTrashed=1 if it does",
                 f"a trashed item is {'named' if b in plain else 'left out'} without includeTrashed", None)
        b_version = with_trash.get(b, got.version)

        self.step = "an item deleted"
        before = got.version
        got = self.call("DELETE", self.lib(f"/items/{b}"), None, {"If-Unmodified-Since-Version": str(b_version)})
        d = self.deleted(before)
        if got.status == 204:
            self.items.remove(b)
        self.row("an item deleted", '204; "deleted since" names it among its items, beside collections, searches and tags',
                 f"{got.status}; keys of the answer: {', '.join(sorted(d)) or 'none'}; named as deleted: {b in (d.get('items') or [])}",
                 got.status == 204 and b in (d.get("items") or []) and "collections" in d)

        self.step = "a collection deleted"
        before = got.version
        got = self.call("DELETE", self.lib(f"/collections/{sub}"), None, {"If-Unmodified-Since-Version": str(sub_version)})
        d = self.deleted(before)
        left = self.call("GET", self.lib(f"/items/{a}"))
        held = ((left.json or {}).get("data") or {}).get("collections") if isinstance(left.json, dict) else None
        changed = self.since(before)
        if got.status == 204:
            self.collections.remove(sub)
        self.row("a collection deleted, its items kept", "204; the collection is named as deleted, its item is still in the library and no longer lists it",
                 f"{got.status}; named as deleted: {sub in (d.get('collections') or [])}; the item is there: {left.status == 200}; it lists: {'the other collection alone' if held == [disc] else held}",
                 got.status == 204 and sub in (d.get("collections") or []) and left.status == 200 and held == [disc])
        self.row("whether the items of a deleted collection are named as changed", "not known from the documentation: if they are not, the sync reads each tied item's collections again",
                 f"the item that was in it is {'named' if a in changed else 'not named'} as changed", None)

        self.step = "the library, in pages"
        got = self.call("GET", self.lib("/items/top?format=keys&limit=1"), keep_body=False)
        total, version = got.headers.get("Total-Results"), got.version
        more = 'rel="next"' in got.headers.get("Link", "")
        self.row("the library's top-level items, a page at a time", "200, with how many there are (Total-Results) and the library's version (Last-Modified-Version)",
                 f"{got.status}; Total-Results: {'given' if total else 'missing'}; Last-Modified-Version: {version}; a next page named (Link): {more}",
                 got.status == 200 and bool(total) and version is not None)
        got = self.call("GET", self.lib("/items/top?format=versions"), None, {"If-Modified-Since-Version": str(version)}, keep_body=False)
        self.row("nothing changed since the last read", "304 when asked with the library's version: a sync with nothing to do is one request",
                 f"{got.status}", got.status == 304)

        if doi:
            self.step = "doi.org"
            got = self.call("GET", f"/{A_DOI}", None, {"Accept": "application/vnd.citationstyles.csl+json"}, base=doi)
            d = got.json if isinstance(got.json, dict) else {}
            host = urllib.parse.urlsplit(got.url).hostname or ""
            self.row("doi.org describes a paper by its DOI", "200, as CSL JSON with a title, a type and authors; answered in the end by another host, which the sync has to allow",
                     f"{got.status}; title: {'yes' if d.get('title') else 'no'}; type: {d.get('type')}; authors: {len(d.get('author') or [])}; answered by: {host}",
                     got.status == 200 and bool(d.get("title")) and bool(d.get("type")))

        if try_url:
            self.step = "an item from a URL"
            before = self.call("GET", self.lib("/items/top?format=keys&limit=1"), keep_body=False).version
            got = self.call("POST", self.lib("/items"), {"url": A_URL})
            key, _ = self.made(got)
            if key:
                self.items.append(key)
                self.mine.add(key)
            new = [] if key else sorted(self.since(before))
            self.row("zotero.org makes an item from a URL", "not known: the documentation's page is marked as possibly outdated. If it works, a link that is no arXiv id or DOI gets a fuller item",
                     f"{got.status}; the item it made is named: {'yes' if key else 'no'}" + (f"; changed in the library since: {', '.join(new) or 'nothing'} (not deleted here: look at them in Zotero)" if not key else ""), None)

        if self.slowed:
            self.row("zotero.org asked to slow down", "it may, on any answer; the probe waited as asked", "; ".join(self.slowed), None)
        else:
            self.row("zotero.org asked to slow down", "it may, on any answer", "not once in this run", None)

        if pause:
            pause(f"\nBefore the probe cleans up, item A is in your library, in the collection \"rft probe {stamp}\" → Discarded.\n"
                  f"  in the app:    zotero://select/library/items/{a}\n  on zotero.org: {page or '(not named by the answer)'}\n"
                  "Open each (the second also on your phone), then press Enter here.")

    # ------------------------------------------------------------ the end

    def clean(self) -> list[str]:
        """Deletes what the probe made, each by its key, and answers what it could not delete."""
        self.step = "cleaning up"
        left = []
        for kind, keys in (("items", self.items), ("collections", self.collections)):
            for key in reversed(list(keys)):
                seen = self.call("GET", self.lib(f"/{kind}/{key}"))
                if seen.status == 404:
                    continue
                version = (seen.json or {}).get("version") if isinstance(seen.json, dict) else None
                got = self.call("DELETE", self.lib(f"/{kind}/{key}"), None, {"If-Unmodified-Since-Version": str(version)})
                if got.status not in (204, 404):
                    left.append(f"{kind[:-1]} {key} ({got.status})")
        return left

    def scrub(self, text: str) -> str:
        """A text without the key, the user's id and their names."""
        if self.key:
            text = text.replace(self.key, "KEY")
        if self.user:
            text = re.sub(rf"(?<![0-9]){re.escape(self.user)}(?![0-9])", "0", text)
        for name in sorted(self.names, key=len, reverse=True):
            text = text.replace(name, "user")
        return text

    def recorded(self) -> str:
        """Every call and its answer, as the fake zotero.org will serve them, scrubbed."""
        return self.scrub(json.dumps({"rows": self.rows, "calls": self.calls}, indent=1, ensure_ascii=False)) + "\n"


def main(argv=None, out=sys.stdout, ask=input) -> int:
    ap = argparse.ArgumentParser(description="Ask zotero.org what the Zotero sync's design expects of it.")
    ap.add_argument("--record", metavar="DIR", help="save the calls and their answers there, scrubbed (probe.json)")
    ap.add_argument("--pause", action="store_true", help="stop before cleaning up, to open the item's links")
    ap.add_argument("--try-url", action="store_true", help="also ask zotero.org to make an item from a URL (see this file's head)")
    ap.add_argument("--api", default=API, help=argparse.SUPPRESS)  # a test's stand-in
    ap.add_argument("--doi", default=DOI, help=argparse.SUPPRESS)
    ap.add_argument("--no-doi", action="store_true", help="do not ask doi.org")
    a = ap.parse_args(argv)
    key = os.environ.get("ZOTERO_API_KEY", "").strip()
    if not key:
        print(f"ZOTERO_API_KEY is not set. Make a key at {KEY_PAGE} with read and write on your personal library, "
              "set it where you start Claude Code (export ZOTERO_API_KEY=...), and never paste it in a chat.", file=out)
        return 2
    probe = Probe(a.api, key, out)
    try:
        if not probe.who():
            print("\nThe probe cannot go on with this key: it needs read and write on the personal library.", file=out)
            return 2
        probe.run(try_url=a.try_url, doi=None if a.no_doi else a.doi, pause=(lambda text: ask(text)) if a.pause else None)
    finally:
        left = probe.clean() if probe.user else []
        if left:
            print(f"\nNOT DELETED, delete them in Zotero: {', '.join(left)}", file=out)
        elif probe.user:
            print("\nCleaned up: everything the probe made is deleted, and nothing else was touched.", file=out)
        if a.record and probe.calls:
            folder = Path(a.record)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "probe.json").write_text(probe.recorded(), encoding="utf-8")
            print(f"Recorded in {folder / 'probe.json'}: read it before it is committed.", file=out)
    differs = [r["what"] for r in probe.rows if r["ok"] is False]
    print(f"\n{len(probe.rows)} answers: {len(differs)} differ from what the design expects" + (f" ({'; '.join(differs)})." if differs else "."), file=out)
    return 1 if differs else 0


if __name__ == "__main__":
    sys.exit(main())
