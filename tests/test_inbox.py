"""Tests of the inbox's file as the server reads it (server/rft_inbox.py), against the fixture the
plugin's reader is held to as well (tests/fixtures/inbox).

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_inbox  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "inbox"


class InboxFileTest(unittest.TestCase):
    def setUp(self):
        self.text = (FIXTURE / "Inbox.md").read_text(encoding="utf-8")
        self.want = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))

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
