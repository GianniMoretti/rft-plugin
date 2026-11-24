"""Tests of a reading note's file as the server reads and writes it (server/rft_reading.py),
against the cases the plugin's side is held to as well (tests/fixtures/reading-note;
tests/reading.test.ts reads them through their copy, tests/fixtures/reading-note.ts).

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_reading  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "reading-note"
sys.path.insert(0, str(FIXTURE))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("reading_to_ts", FIXTURE / "to_ts.py")
to_ts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(to_ts)


def note_of(case) -> rft_reading.Note:
    return rft_reading.Note.new(**case["item"]) if case["text"] is None else rft_reading.Note(case["text"])


class ReadingNoteFileTest(unittest.TestCase):
    def setUp(self):
        self.cases = json.loads((FIXTURE / "cases.json").read_text(encoding="utf-8"))

    def test_the_plugin_tests_read_the_same_fixture(self):
        self.assertEqual(to_ts.OUT.read_text(encoding="utf-8"), to_ts.module(),
                         "tests/fixtures/reading-note.ts is behind the fixture: python3 tests/fixtures/reading-note/to_ts.py")
        self.assertEqual(to_ts.PAGE.read_text(encoding="utf-8"), to_ts.page(),
                         "tests/fixtures/reading-note/SCENARIOS.md is behind the fixture: python3 tests/fixtures/reading-note/to_ts.py")

    def test_a_file_name_and_a_heading_from_a_key(self):
        for key, title, name, second, head in self.cases["names"]:
            self.assertEqual((rft_reading.file_name(key), rft_reading.file_name(key, 1), rft_reading.name_of(key, title)), (name, second, head), key)
            self.assertNotIn("/", name)
            self.assertLessEqual(len(name), rft_reading.NAME_CHARS + 3)

    def test_read_case_by_case_and_written_back_unchanged(self):
        for case in self.cases["reads"]:
            note = rft_reading.Note(case["text"])
            self.assertEqual((note.key, note.mine, note.impression), (case["key"], case["mine"], case["impression"]), case["name"])
            self.assertEqual(note.text(), case["text"], case["name"])

    def test_the_users_part_case_by_case(self):
        for case in self.cases["mine"]:
            note = note_of(case)
            before = (note.key, note.impression)
            if case.get("error"):
                with self.assertRaises(rft_reading.ReadingError, msg=case["name"]):
                    note.set_mine(case["mine"])
                self.assertEqual(note.text(), case["text"], case["name"])
                continue
            self.assertEqual(note.set_mine(case["mine"]), case["changed"], case["name"])
            self.assertEqual(note.text(), case["want"], case["name"])
            # the part reads back as given, without the blank lines at its ends, and nothing else moved
            self.assertEqual(note.mine, "\n".join(rft_reading.lines_of(case["mine"])), case["name"])
            self.assertEqual((note.key, note.impression), before, case["name"])
            # written a second time, nothing changes
            self.assertFalse(note.set_mine(case["mine"]), case["name"])
            self.assertEqual(note.text(), case["want"], case["name"])

    def test_what_the_plugin_writes_reads_the_same_here(self):
        for case in self.cases["impressions"]:
            if case.get("error"):
                continue
            note = rft_reading.Note(case["want"])
            self.assertEqual(note.impression["date"], case["today"], case["name"])
            self.assertEqual(note.key, case["item"]["key"], case["name"])
            before = note_of(case)
            self.assertEqual(note.mine, before.mine, case["name"])
            # and the user's part written after an impression leaves the impression as it is
            self.assertTrue(note.set_mine("> a quote\n\nmine") or note.mine == "> a quote\n\nmine", case["name"])
            self.assertEqual(note.impression, rft_reading.Note(case["want"]).impression, case["name"])

    def test_the_file_of_an_item_by_its_key(self):
        files = {}
        read = files.get
        key, other = "https://a.org/x-y", "https://a.org/x/y"  # two links, one file name
        self.assertEqual(rft_reading.file_name(key), rft_reading.file_name(other))
        self.assertEqual(rft_reading.find(read, key), ("a.org-x-y.md", None))
        note = rft_reading.Note.new(key, key)
        note.set_mine("mine")
        files["a.org-x-y.md"] = note.text()
        name, got = rft_reading.find(read, key)
        self.assertEqual((name, got.mine), ("a.org-x-y.md", "mine"))
        # the other link's note is a file of its own, and each is found again
        self.assertEqual(rft_reading.find(read, other), ("a.org-x-y-2.md", None))
        second = rft_reading.Note.new(other, other)
        second.set_mine("the other's")
        files["a.org-x-y-2.md"] = second.text()
        self.assertEqual(rft_reading.find(read, other)[1].mine, "the other's")
        self.assertEqual(rft_reading.find(read, key)[1].mine, "mine")
        # a file that names no item (its head was edited away) is the item's by its name
        files["a.org-z.md"] = "## My reading\n\nheadless\n"
        self.assertEqual(rft_reading.find(read, "https://a.org/z")[1].mine, "headless")


if __name__ == "__main__":
    unittest.main()
