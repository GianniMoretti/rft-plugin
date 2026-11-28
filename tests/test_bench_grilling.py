"""The checks of the grilling scenarios (bench/grilling.py) can fail.

The scenarios are the referee of /rft-grill-me: a check that passed whatever the session wrote
would referee nothing. Here each scenario's checks are given vaults made by hand from the demo
(no session is run): one written as a grilling should write it, on which every check passes, and
ones that break a rule, on which the check of that rule fails.
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('bench_grilling', ROOT / 'bench' / 'grilling.py')
g = importlib.util.module_from_spec(spec)
sys.modules['bench_grilling'] = g
spec.loader.exec_module(g)

START = g.snapshot(ROOT / 'examples' / 'demo')
D05, D06, D09, E06 = (g.find(START, i) for i in ('D05', 'D06', 'D09', 'E06'))


def note(id, type, status, parent, title, tags='', body=''):
    return f'---\nid: {id}\ntype: {type}\nstatus: {status}\ndate: 2026-11-27\nparent: "[[{parent}]]"\nchildren: []\ntags: [demo, {type}{tags}, {status}]\n---\n\n# {id} · {title}\n\n{body}\n## Children in the tree\n'


def with_sections(text, **sections):
    return text.replace('## Status', ''.join(f'## {k.replace("_", " ")}\n{v}\n\n' for k, v in sections.items()) + '## Status', 1)


def with_child(text, child):
    """The parent as the tools leave it when a note is added under it."""
    link = f'- [[{child}]]\n'
    return text.replace('- none yet\n', link) if '- none yet\n' in text else text.rstrip('\n') + '\n' + link


def failed(checks):
    return [what for what, ok, _ in checks if not ok]


class Checks(unittest.TestCase):
    def test_the_scenarios_and_the_checks_have_the_same_names(self):
        scenarios = json.loads((ROOT / 'bench' / 'grilling.json').read_text(encoding='utf-8'))
        self.assertEqual([s['name'] for s in scenarios], list(g.CHECKS))
        self.assertEqual(len(scenarios), 5)
        for s in scenarios:
            for step in s.get('setup', []):
                self.assertIn(step['after'], (ROOT / 'examples' / 'demo' / step['file']).read_text(encoding='utf-8'))
        self.assertIn('Status', g.own(START[D05]))  # the demo's directions have the section the hand-made vaults write before

    def test_what_the_tools_derive_is_not_a_change_and_anything_else_is(self):
        grown = {**START, D09: with_child(START[D09], 'D12 A new one')}
        self.assertEqual(g.changed(START, grown), [])
        self.assertEqual(g.changed(START, grown, True), [D09])
        self.assertEqual(g.changed(START, {**START, D09: START[D09].replace('status: idea', 'status: planned')}), [D09])
        self.assertEqual(g.section(with_sections(START[D09], Scope='CIFAR-10 only.'), 'Scope'), 'CIFAR-10 only.')
        self.assertEqual(g.section(START[D09], 'Scope'), '')

    def test_the_questions_of_a_round_are_read_by_their_titles(self):
        reply = '❓ **Q1** - **The referee**: What would show it?\n\n➡️ E02 reproduced.\n\n---\n\nQ2 - Order: which first?\n**Q3 — The hypothesis**: again?'
        self.assertEqual(g.questions(reply), ['The referee', 'Order', 'The hypothesis'])
        self.assertEqual(g.questions('Nothing is asked here.'), [])

    def test_planned_experiment(self):
        good = {**START, D05: with_sections(START[D05], Hypothesis='h', Referee='r')}
        self.assertEqual(failed(g.planned_experiment([START, START, good, good, good], [''] * 4)), [])
        early = {**START, E06: START[E06] + '\nrewritten'}
        self.assertIn('before the proposal is confirmed (message 2), only D05 is written', failed(g.planned_experiment([START, START, early, good, good], [''] * 4)))
        second = {**good, 'experiments/E08 Another run.md': note('E08', 'experiment', 'planned', 'D05 A schedule that needs no stopping', 'Another run')}
        self.assertIn('no second experiment: no experiment note was added', failed(g.planned_experiment([START, START, good, good, second], [''] * 4)))
        self.assertIn('D05 holds its Hypothesis and its Referee', failed(g.planned_experiment([START, START, START, START, START], [''] * 4)))
        self.assertIn('round one only asks: no note changed, none added', failed(g.planned_experiment([START, good, good, good, good], [''] * 4)))

    def test_new_question(self):
        d12 = 'directions/D12 Augmentation on audio.md'
        parent = g.find(START, 'D02')
        made = {**START, parent: with_child(START[parent], 'D12 Augmentation on audio'), d12: note('D12', 'direction', 'idea', 'D02 Strong augmentation closes the gap', 'Augmentation on audio')}
        r05 = 'references/R05 Literature on audio augmentation.md'
        end = {**made, d12: made[d12].replace('status: idea', 'status: planned'),
               r05: note('R05', 'reference', 'planned', 'D12 Augmentation on audio', 'Literature on audio augmentation', ', literature', '## Search\nDoes it hold on spectrograms?\n')}
        self.assertEqual(failed(g.new_question([START, START, made, made, end], [''] * 4)), [])
        self.assertIn('round one only asks: no note changed, none added', failed(g.new_question([START, made, made, made, end], [''] * 4)))
        self.assertIn('before the proposal is confirmed (message 2), the only new note is the grilled direction', failed(g.new_question([START, START, end, end, end], [''] * 4)))
        self.assertIn('one literature note, at planned', failed(g.new_question([START, START, made, made, made], [''] * 4)))
        run = {**end, 'experiments/E08 A run.md': note('E08', 'experiment', 'planned', 'D12 Augmentation on audio', 'A run')}
        self.assertIn('no experiment was planned before the search is read', failed(g.new_question([START, START, made, made, run], [''] * 4)))

    def test_already_answered(self):
        asks = 'It was dropped. Stop here, or reopen it as a new direction?'
        self.assertEqual(failed(g.already_answered([START, START, START], [asks, 'Stopped.'])), [])
        touched = {**START, D06: START[D06] + '\n'}
        self.assertIn('after message 1, every note is byte for byte as it was, and none was added', failed(g.already_answered([START, touched, START], [asks, ''])))
        self.assertIn('(reply) round one asks whether to stop or to reopen', failed(g.already_answered([START, START, START], ['Q1 - The hypothesis: ...', ''])))

    def test_locked(self):
        start = {**START, D09: START[D09].replace('status: idea', 'status: idea\nlocked: true')}
        d12 = 'directions/D12 Pretraining gains two points.md'
        new = note('D12', 'direction', 'idea', 'D09 Self-supervised pretraining on the same images', 'Pretraining gains two points', body='## Hypothesis\nh\n\n## Referee\nr\n')
        end = {**start, D09: with_child(start[D09], 'D12 Pretraining gains two points'), d12: new}
        self.assertEqual(failed(g.locked([start, start, start, start, end], [''] * 4)), [])
        edited = {**end, D09: with_sections(end[D09], Hypothesis='h')}
        self.assertIn('after message 4, D09 is as the user locked it (but for the list of its children)', failed(g.locked([start, start, start, start, edited], [''] * 4)))
        self.assertIn('the grilled direction is a new direction under D09', failed(g.locked([start, start, start, start, start], [''] * 4)))

    def test_cut_and_resumed(self):
        cut = {**START, D09: with_sections(START[D09], Hypothesis='h', Scope='s', Open_questions='- the referee')}
        resumed = 'Q1 - The referee: what would show it?\n\nQ2 - Order: which first?'
        self.assertEqual(failed(g.cut_and_resumed([START, START, cut, cut], ['', '', resumed])), [])
        self.assertIn('the answers given before the cut are in D09: Hypothesis and Scope', failed(g.cut_and_resumed([START, START, START, START], ['', '', resumed])))
        again = 'Q1 - The hypothesis: what is the claim?'
        self.assertIn('(reply) the new session asks questions, and none for the hypothesis or the scope again', failed(g.cut_and_resumed([START, START, cut, cut], ['', '', again])))
        rewritten = {**cut, D09: cut[D09].replace('## Hypothesis\nh', '## Hypothesis\nanother')}
        self.assertIn('the new session leaves the Hypothesis as it was written', failed(g.cut_and_resumed([START, START, cut, rewritten], ['', '', resumed])))


if __name__ == '__main__':
    unittest.main()
