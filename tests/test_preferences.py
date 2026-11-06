import unittest
from unittest.mock import patch

import networkx as nx
from pydantic import ValidationError

import poc


def graph(disconnected=False):
    g = nx.MultiDiGraph(crs='EPSG:4326')
    for n in range(5):
        g.add_node(n, x=135 + n * .001, y=35.0)
    for n in range(3 if disconnected else 4):
        g.add_edge(n, n + 1, length=100)
        g.add_edge(n + 1, n, length=100)
    return g


def stop(n, score=7):
    return {'id': n, 'name': f'場所{n}', 'lat': 35.0, 'lon': 135 + n * .001,
            'score': score, 'reason': 'テスト', 'kind': 'park'}


class RouteTests(unittest.TestCase):
    def plan(self, stops, budget, required=(), disconnected=False):
        with patch.object(poc, 'OSM_WALK_FILE', 'test'), patch.object(poc, '_local_graph', return_value=graph(disconnected)):
            return poc.plan_route(35.0, 135.0, 1000, stops, budget, required)

    def test_required_is_kept_despite_low_score(self):
        _, order, total, _ = self.plan([stop(1, 10), stop(3, 0)], 600, [3])
        self.assertIn(3, [s['id'] for s in order])
        self.assertLessEqual(total, 600)

    def test_one_optional_over_budget_is_not_returned(self):
        with self.assertRaises(poc.RouteConstraintError):
            self.plan([stop(3)], 599)

    def test_two_optionals_never_bypass_budget(self):
        _, order, total, _ = self.plan([stop(1), stop(3)], 250)
        self.assertEqual([p['id'] for p in order], [1])
        self.assertLessEqual(total, 250)

    def test_required_over_budget_is_explicit(self):
        with self.assertRaisesRegex(poc.RouteConstraintError, '時間を延ばす'):
            self.plan([stop(3)], 599, [3])

    def test_unreachable_required_is_explicit(self):
        with self.assertRaisesRegex(poc.RouteConstraintError, '徒歩経路'):
            self.plan([stop(4)], 2000, [4], disconnected=True)

    def test_unreachable_optional_does_not_remove_required(self):
        _, order, _, _ = self.plan([stop(1, 0), stop(4, 10)], 1000, [1], disconnected=True)
        self.assertEqual([p['id'] for p in order], [1])

    def test_required_route_checks_all_orders(self):
        _, order, total, coords = self.plan([stop(3), stop(1), stop(2)], 600, [1, 2, 3])
        self.assertEqual({p['id'] for p in order}, {1, 2, 3})
        self.assertEqual(total, 600)
        self.assertEqual(coords[0], coords[-1])

    def test_input_is_not_mutated(self):
        p = stop(1)
        self.plan([p], 500)
        self.assertNotIn('node', p)

    def test_snap_distance_counts_towards_time(self):
        p = stop(1)
        p['lat'] += .0005
        with self.assertRaises(poc.RouteConstraintError):
            self.plan([p], 250, [1])


class SelectionTests(unittest.TestCase):
    def test_clarification_needs_distinct_options(self):
        with self.assertRaises(ValidationError):
            poc.Clarification(needs_clarification=True, question='どちら？', options=['静か', '静か'])

    def test_clear_request_can_skip_question(self):
        c = poc.Clarification(needs_clarification=False)
        self.assertFalse(c.needs_clarification)

    def test_excluded_candidates_are_not_in_prompt_and_preference_is_included(self):
        selection = poc.Selection(interpretation='緑で落ち着く', picks=[poc.Pick(id=1, score=8, reason='公園')])
        with patch.object(poc, 'ask', return_value=selection) as ask:
            _, ranked = poc.choose_places('癒し', [stop(1)], '自然の中で静かに')
        prompt = ask.call_args.args[0]
        self.assertIn('自然の中で静かに', prompt)
        self.assertNotIn('場所2', prompt)
        self.assertEqual(len(ranked), 1)

    def test_duplicate_and_unknown_ai_ids_are_ignored(self):
        picks = [poc.Pick(id=i, score=8, reason='理由') for i in [1, 1, 99]]
        with patch.object(poc, 'ask', return_value=poc.Selection(interpretation='解釈', picks=picks)):
            _, ranked = poc.choose_places('希望', [stop(1)])
        self.assertEqual([p['id'] for p in ranked], [1])


if __name__ == '__main__':
    unittest.main()
