"""The manual in parts: the core's index, the part files and what the plugin's texts cite.

skills/rft-manual/SKILL.md is the core; every other subject is a file beside it, read alone when
the work needs it. These tests hold the three lists of parts together (the files, the core's
index, PARTS in hooks/lib/manual.ts), keep each file under a size, and check that every tool the
plugin registers is named in the manual and that every section a text cites is a heading of the
part it cites.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL = ROOT / 'skills' / 'rft-manual'

# In characters (about 3.5 to a token). The whole manual was one file of 64,400.
MAX_DESCRIPTION = 350
MAX_CORE = 15500
MAX_PART = 8000


def text(path):
    return Path(path).read_text(encoding='utf-8')


def parts_in_code():
    found = re.search(r"export const PARTS = \[([^\]]*)\]", text(ROOT / 'hooks/lib/manual.ts'))
    return re.findall(r"'([a-z-]+)'", found.group(1))


def index_rows():
    """The rows of the core's index: part -> the tools it lists."""
    rows = {}
    for line in text(MANUAL / 'SKILL.md').splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        found = re.fullmatch(r'`([a-z-]+)\.md`', cells[0]) if len(cells) == 3 else None
        if found:
            rows[found.group(1)] = re.findall(r'`(rft_[a-z_]+)`', cells[2])
    return rows


def tools():
    """The tools the plugin registers: the keys of TOOLS in hooks/register.tsx."""
    return re.findall(r"(?m)^  (rft_[a-z_]+): \{$", text(ROOT / 'hooks/register.tsx'))


def headings(part):
    return re.findall(r'(?m)^#+ (.+)$', text(MANUAL / f'{part}.md'))


class Manual(unittest.TestCase):
    def test_the_files_the_index_and_the_code_name_the_same_parts(self):
        files = sorted(p.stem for p in MANUAL.glob('*.md') if p.name != 'SKILL.md')
        self.assertEqual(files, sorted(parts_in_code()))
        self.assertEqual(list(index_rows()), parts_in_code())  # same order too

    def test_sizes(self):
        core = text(MANUAL / 'SKILL.md')
        description = re.search(r'(?m)^description: (.+)$', core).group(1)
        self.assertLessEqual(len(description), MAX_DESCRIPTION)
        self.assertLessEqual(len(core), MAX_CORE)
        for part in parts_in_code():
            self.assertLessEqual(len(text(MANUAL / f'{part}.md')), MAX_PART, part)

    def test_every_tool_is_named_and_the_index_sends_to_the_part_that_says_how(self):
        names = tools()
        self.assertEqual(len(names), 43)
        rows = index_rows()
        core = text(MANUAL / 'SKILL.md')
        # the index lists every tool once: under its part, or as one of the core's own
        own = re.findall(r'`(rft_[a-z_]+)`', re.search(r"This file's own tools: ([^.]+)\.", core).group(1))
        listed = own + [t for row in rows.values() for t in row]
        self.assertEqual(sorted(listed), sorted(names))
        for part, row in rows.items():
            body = text(MANUAL / f'{part}.md')
            for tool in row:
                self.assertIn(f'`{tool}', body, f'{tool} is not in {part}.md')
        below_index = core.split("This file's own tools:")[1]
        for tool in own:
            self.assertIn(f'`{tool}', below_index, f'{tool} is not in the core')

    def test_a_part_opens_by_saying_what_it_is_part_of(self):
        for part in parts_in_code():
            lines = text(MANUAL / f'{part}.md').splitlines()
            self.assertTrue(lines[0].startswith('# '), part)
            self.assertIn('rft-manual', lines[2], part)

    def test_what_the_plugin_cites_is_there(self):
        """cite(dir, 'part', 'Section') in the hooks: the part is one, the section a heading of it."""
        cited = []
        for path in [ROOT / 'hooks/register.tsx', *sorted((ROOT / 'hooks/lib').glob('*.ts'))]:
            cited += re.findall(r"cite\(\w+, '([a-z-]+)'(?:, '([^']+)')?\)", text(path))
        self.assertGreaterEqual(len(cited), 8)
        for part, section in cited:
            self.assertIn(part, parts_in_code())
            if section:
                self.assertIn(section, headings(part), f'{part}.md has no section "{section}"')
        # the two citations written as plain text
        self.assertIn('Writing a job the monitor can read', headings('queue'))
        self.assertIn('"Writing a job the monitor can read" (queue.md)', text(ROOT / 'hooks/lib/ops.ts'))
        self.assertIn('Figures', headings('notebooks'))
        self.assertIn("notebooks.md, Figures", text(ROOT / 'hooks/register.tsx'))

    def test_no_part_points_at_a_section_that_moved(self):
        """A "(see X)" names a heading of the same file; another file is cited by its name."""
        for path in sorted(MANUAL.glob('*.md')):
            own = re.findall(r'(?m)^#+ (.+)$', text(path))
            for seen in re.findall(r'\(see ([A-Z][^)]*?)(?: below| above)?\)', text(path)):
                self.assertIn(seen, own, f'{path.name}: "(see {seen})" is not a heading of it')


if __name__ == '__main__':
    unittest.main()
