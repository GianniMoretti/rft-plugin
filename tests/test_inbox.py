"""Tests of the inbox's file as the server reads and writes it (server/rft_inbox.py), against the
fixture and the cases the plugin's side is held to as well (tests/fixtures/inbox; tests/inbox.test.ts
reads them through their copy, tests/fixtures/inbox.ts).

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_inbox  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "inbox"
sys.path.insert(0, str(FIXTURE))
import to_ts  # noqa: E402


class InboxFileTest(unittest.TestCase):
    def setUp(self):
        self.text = (FIXTURE / "Inbox.md").read_text(encoding="utf-8")
        self.want = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))
        self.cases = json.loads((FIXTURE / "cases.json").read_text(encoding="utf-8"))

    def test_the_plugin_tests_read_the_same_fixture(self):
        self.assertEqual(to_ts.OUT.read_text(encoding="utf-8"), to_ts.module(),
                         "tests/fixtures/inbox.ts is behind the fixture: python3 tests/fixtures/inbox/to_ts.py")

    def test_identity_case_by_case(self):
        for text, key in self.cases["identity"]:
            items = rft_inbox.Inbox(f"- {text}").items
            self.assertEqual(items[0]["key"] if items else None, key, text)

    def test_the_links_a_reference_names(self):
        for text, keys in self.cases["sources"]:
            self.assertEqual(rft_inbox.links_in(text), keys, text)
        for note, keys in self.cases["notes"]:
            self.assertEqual(rft_inbox.links_in(rft_inbox.source_of(note)), keys, note)

    def test_white_space_is_the_set_spelled_out(self):
        # the plugin's side has the same list: neither side's own idea of a space decides a line
        spaces = [c for c in range(0x110000) if rft_inbox.SPACES.fullmatch(chr(c))]
        self.assertEqual(spaces, [9, 10, 11, 12, 13, 32, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000])
        self.assertEqual(rft_inbox.strip("\u00a0\t x \u3000\n"), "x")
        self.assertEqual(rft_inbox.strip("\ufeffx\x85"), "\ufeffx\x85")

    def test_what_already_holds_a_link(self):
        box = rft_inbox.Inbox(self.text)
        for key, kind, fields in self.cases["finds"]:
            got = box.find(key)
            self.assertEqual(got[0] if got else None, kind, key)
            for k, v in (fields or {}).items():
                self.assertEqual(got[1][k], v, (key, k))

    def test_add_case_by_case(self):
        for case in self.cases["adds"]:
            box = rft_inbox.Inbox(case["text"])
            args = {k: case[k] for k in ("why", "priority", "title", "today") if k in case}
            if case.get("error"):
                with self.assertRaises(rft_inbox.InboxError, msg=case["name"]):
                    box.add(case["link"], **args)
                self.assertEqual(box.text(), case["text"], case["name"])
                continue
            item = box.add(case["link"], **args)
            self.assertEqual(box.text(), case["want"], case["name"])
            self.assertIn(item, box.shown(), case["name"])

    def test_an_add_changes_one_line_of_the_fixture(self):
        box = rft_inbox.Inbox(self.text)
        item = box.add("arXiv:2511.00042v2", why="from the talk", priority="high", today="2026-11-23")
        self.assertEqual(item, {"key": "arxiv:2511.00042", "url": "https://arxiv.org/abs/2511.00042", "title": "", "why": "from the talk",
                                "priority": "high", "added": "2026-11-23", "read": "", "duplicate": False, "brief": None})
        before, after = self.text.split("\n"), box.text().split("\n")
        at = before.index("- see also the list in Scratchpad") + 1
        self.assertEqual(after, before[:at] + ["- https://arxiv.org/abs/2511.00042 — from the talk · high · added 2026-11-23"] + before[at:])
        self.assertEqual(box.shown(), self.want["items"] + [item])
        self.assertEqual(box.processed, self.want["processed"])

    def test_the_read_mark_case_by_case(self):
        # the user's mark, `read <day>`, is one only as a part of its own after the link
        for text, fields in self.cases["reads"]:
            items = rft_inbox.Inbox(f"- {text}").shown()
            self.assertEqual(len(items), 1, text)
            self.assertEqual({k: items[0][k] for k in fields}, fields, text)
        for case in self.cases["unmarked"]:
            with self.assertRaises(rft_inbox.InboxError, msg=case["name"]):
                rft_inbox.Inbox(case["text"]).add(case["link"], case["why"])
        self.assertTrue(all(i["read"] == "" for i in self.want["items"]))

    def test_change_case_by_case(self):
        for case in self.cases["changes"]:
            box = rft_inbox.Inbox(case["text"])
            args = (case["key"], case.get("nth", 0), case.get("why"), case.get("priority"), case.get("read"))
            if case.get("error"):
                with self.assertRaises(rft_inbox.InboxError, msg=case["name"]):
                    box.change(*args)
            else:
                item = box.change(*args)
                self.assertEqual(item is None, bool(case.get("none")), case["name"])
                if item:
                    self.assertIn(item, box.shown(), case["name"])
                    for k in ("why", "priority", "read"):
                        if case.get(k) is not None:
                            self.assertEqual(item[k], rft_inbox.one_line(case[k]).lower() if k == "priority" else rft_inbox.one_line(case[k]), case["name"])
            self.assertEqual(box.text(), case.get("want", case["text"]), case["name"])
            self.assertEqual(rft_inbox.Inbox(box.text()).shown(), box.shown(), case["name"])

    def test_close_case_by_case(self):
        for case in self.cases["closes"]:
            box = rft_inbox.Inbox(case["text"])
            before = box.shown()
            done = box.close(case["key"], case.get("nth", 0), case.get("outcome", "discarded"), case["today"])
            self.assertEqual(done is None, bool(case.get("none")), case["name"])
            self.assertEqual(box.text(), case.get("want", case["text"]), case["name"])
            again = rft_inbox.Inbox(box.text())
            self.assertEqual((again.shown(), again.processed), (box.shown(), box.processed), case["name"])
            if done:
                self.assertEqual(done, case.get("processed", done), case["name"])
                self.assertEqual(box.processed[-1], done, case["name"])
                self.assertEqual(len(box.shown()), len(before) - 1, case["name"])

    def test_a_change_and_a_close_in_the_fixture(self):
        box = rft_inbox.Inbox(self.text)
        before = self.text.split("\n")
        # the reading priority of one item: its line, and no other
        item = box.change("doi:10.1007/s11263-021-01453-z", priority="high")
        self.assertEqual((item["why"], item["priority"]), ("IJCV survey, low", "high"))
        after = box.text().split("\n")
        at = before.index("- https://doi.org/10.1007/s11263-021-01453-z \u2014 IJCV survey, low")
        self.assertEqual(after, before[:at] + ["- https://doi.org/10.1007/s11263-021-01453-z \u2014 IJCV survey, low \u00b7 high"] + before[at + 1:])
        self.assertEqual([i for i in box.shown() if i != item], [i for i in self.want["items"] if i["key"] != item["key"]])
        # the first item discarded: it and its brief go, one line more under Processed, and the one typed twice is alone
        box = rft_inbox.Inbox(self.text)
        done = box.close("arxiv:2406.01234", today="2026-11-23")
        self.assertEqual(done, {"date": "2026-11-23", "key": "arxiv:2406.01234", "title": "Mixup at scale", "outcome": "discarded"})
        self.assertEqual(box.text().split("\n"), before[:4] + before[8:-1] + ["- 2026-11-23 [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 discarded", ""])
        self.assertEqual(box.processed, self.want["processed"] + [done])
        left = [dict(i, duplicate=False) if i["key"] == "arxiv:2406.01234" else i for i in self.want["items"][1:]]
        self.assertEqual(box.shown(), left)
        self.assertEqual(box.find("arxiv:2406.01234")[0], "item")
        box.close("arxiv:2406.01234", today="2026-11-24")
        self.assertEqual(box.find("arxiv:2406.01234"), ("processed", {"date": "2026-11-24", "key": "arxiv:2406.01234", "title": "", "outcome": "discarded"}))

    def test_a_title_changes_the_link_of_one_line(self):
        box = rft_inbox.Inbox(self.text)
        # the first untitled item with the link: the fixture's first one has its title already
        item = box.set_title("arxiv:2406.01234", "Mixup, [again]")
        self.assertEqual((item["title"], item["why"], item["duplicate"]), ("Mixup, (again)", "same one from Gianni?", True))
        before, after = self.text.split("\n"), box.text().split("\n")
        at = before.index("* arXiv:2406.01234v2 - same one from Gianni?")
        self.assertEqual(after, before[:at] + ["* [Mixup, (again)](https://arxiv.org/abs/2406.01234) - same one from Gianni?"] + before[at + 1:])
        # nothing to do: every item with the link has a title, the link is in no item, the title is empty
        for key, title in (("arxiv:2406.01234", "Another"), ("arxiv:2111.06377", "Processed"), ("arxiv:2311.09876", " \n ")):
            now = box.text()
            self.assertIsNone(box.set_title(key, title), key)
            self.assertEqual(box.text(), now)
        # the line as typed stays: its bullet, its spaces, its ending
        box = rft_inbox.Inbox("-   <https://arxiv.org/pdf/2501.00001v3>   \u2014 why  \u00b7 urgent\r\n  - briefed 2026-11-20: x\r\n- 2501.00001\n")
        self.assertEqual(box.set_title("arxiv:2501.00001", "  A   title\nin two lines ")["title"], "A title in two lines")
        self.assertEqual(box.text(), "-   [A title in two lines](https://arxiv.org/abs/2501.00001)   \u2014 why  \u00b7 urgent\r\n  - briefed 2026-11-20: x\r\n- 2501.00001\n")
        self.assertEqual([(i["priority"], i["why"], bool(i["brief"])) for i in box.shown()], [("urgent", "why", True), ("", "", False)])

    def test_the_fixture_yields_its_items(self):
        box = rft_inbox.Inbox(self.text)
        self.assertEqual(box.shown(), self.want["items"])
        self.assertEqual(box.processed, self.want["processed"])

    def test_read_and_written_back_unchanged(self):
        self.assertEqual(rft_inbox.Inbox(self.text).text(), self.text)
        for text in ("", "no newline at the end", "- https://a.example/x\n\n\n", self.text.replace("\n", "\r\n")):
            self.assertEqual(rft_inbox.Inbox(text).text(), text)
        self.assertEqual(rft_inbox.Inbox(self.text.replace("\n", "\r\n")).shown(), self.want["items"])

    def test_one_paper_however_it_is_given(self):
        forms = ["2406.01234", "arXiv:2406.01234v3", "https://arxiv.org/abs/2406.01234", "http://arxiv.org/pdf/2406.01234v2.pdf",
                 "https://export.arxiv.org/abs/2406.01234v1", "[Mixup](https://arxiv.org/pdf/2406.01234)", "<https://arxiv.org/abs/2406.01234>"]
        items = rft_inbox.Inbox("\n".join(f"- {f}" for f in forms)).items
        self.assertEqual([i["key"] for i in items], ["arxiv:2406.01234"] * len(forms))
        self.assertEqual([i["duplicate"] for i in items], [False] + [True] * (len(forms) - 1))
        self.assertEqual(rft_inbox.Inbox("- hep-th/9901001v2").items[0]["key"], "arxiv:hep-th/9901001")
        dois = rft_inbox.Inbox("- doi:10.1109/CVPR.2022.01553\n- https://doi.org/10.1109/cvpr.2022.01553\n- 10.1109/CVPR.2022.01553").items
        self.assertEqual({i["key"] for i in dois}, {"doi:10.1109/cvpr.2022.01553"})
        urls = rft_inbox.Inbox("- https://Example.org/a/b/#top\n- https://example.org/a/b\n- https://example.org/a/b?x=1").items
        self.assertEqual([i["key"] for i in urls], ["https://example.org/a/b", "https://example.org/a/b", "https://example.org/a/b?x=1"])

    def test_what_is_not_an_item(self):
        text = ("free text with https://example.org/in-a-sentence\n- [ ] a to-do\n- a remark\n- see https://example.org/later\n"
                "  - https://example.org/indented\n1. https://example.org/numbered\n- ftp://example.org/file\n- [no target]()\n")
        self.assertEqual(rft_inbox.Inbox(text).items, [])

    def test_the_parts_after_the_link(self):
        item = lambda line: rft_inbox.Inbox(line).shown()[0]  # noqa: E731
        self.assertEqual(item("- https://e.org/x — low")["priority"], "low")
        self.assertEqual((item("- https://e.org/x — a low bar")["priority"], item("- https://e.org/x — a low bar")["why"]), ("", "a low bar"))
        got = item("- https://e.org/x · added 2026-01-02 · HIGH · for D04 · medium")
        self.assertEqual((got["why"], got["priority"], got["added"]), ("for D04 · medium", "high", "2026-01-02"))
        # the user's own lines under an item are not a brief
        self.assertIsNone(item("- https://e.org/x\n  - from the reading group")["brief"])
        self.assertEqual(item("- https://e.org/x\n\t* briefed 2026-01-03: one line")["brief"], {"date": "2026-01-03", "lines": ["one line"]})

    def test_the_processed_list_ends_at_the_next_heading(self):
        box = rft_inbox.Inbox("- https://e.org/a\n\n## Processed\n- 2026-01-02 https://e.org/b -> R01, D02\n- https://e.org/c\n\n## Later\n- https://e.org/d\n")
        self.assertEqual([i["key"] for i in box.items], ["https://e.org/a", "https://e.org/d"])
        self.assertEqual(box.processed, [{"date": "2026-01-02", "key": "https://e.org/b", "title": "", "outcome": "R01, D02"},
                                         {"date": "", "key": "https://e.org/c", "title": "", "outcome": ""}])


if __name__ == "__main__":
    unittest.main()
