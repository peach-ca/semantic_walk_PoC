import unittest
from pathlib import Path
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

import poc
from test_preferences import stop


class AppTests(unittest.TestCase):
    def test_prepare_clarify_select_required_exclude_and_rebuild(self):
        places = [dict(stop(i), dist=i * 100) for i in (1, 2, 3)]
        clarification = poc.Clarification(needs_clarification=True, question='どんな懐かしさ？', options=['商店街', '歴史建築'])
        ranked = [dict(places[0], score=8)]
        def route(lat, lon, radius, stops, max_m, required_ids):
            self.assertEqual(required_ids, [3])
            self.assertNotIn(2, [p['id'] for p in stops])
            self.assertIn(3, [p['id'] for p in stops])
            return {}, stops, 400, [(lat, lon), (35, 135), (lat, lon)]
        with patch('streamlit_folium.st_folium', return_value={}), \
             patch.object(poc, 'fetch_inventory', return_value=places), \
             patch.object(poc, 'clarify_concept', return_value=clarification), \
             patch.object(poc, 'choose_places', return_value=('解釈', ranked)) as choose, \
             patch.object(poc, 'plan_route', side_effect=route):
            app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / 'app.py'))
            app.run()
            self.assertFalse(app.exception)
            app.sidebar.button[0].click().run()
            self.assertFalse(app.exception)
            self.assertTrue(app.button[0].disabled)
            app.radio[0].set_value('歴史建築')
            app.multiselect[0].set_value([3])
            app.multiselect[1].set_value([2])
            app.run()
            self.assertFalse(app.button[0].disabled)
            app.button[0].click().run()
            self.assertFalse(app.exception)
            self.assertEqual(choose.call_args.args[2], '歴史建築')
            self.assertNotIn(2, [p['id'] for p in choose.call_args.args[1]])
            self.assertIsNotNone(app.session_state['result'])
            app.multiselect[1].set_value([2, 3]).run()
            self.assertTrue(app.button[0].disabled)
            self.assertIsNone(app.session_state['result'])
            app.sidebar.slider[0].set_value(60).run()
            self.assertIsNone(app.session_state['prepared'])
            self.assertFalse(app.exception)

    def test_concrete_request_skips_clarification(self):
        with patch('streamlit_folium.st_folium', return_value={}), \
             patch.object(poc, 'fetch_inventory', return_value=[dict(stop(1), dist=100)]), \
             patch.object(poc, 'clarify_concept', return_value=poc.Clarification(needs_clarification=False)):
            app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / 'app.py')).run()
            app.sidebar.button[0].click().run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.radio), 0)
            self.assertFalse(app.button[0].disabled)
