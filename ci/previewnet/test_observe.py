import unittest
from observe import progress


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.mine = {'worker': 0, 'count': 2, 'nodes': [
            {'name': 'alice', 'chain': 'relay', 'bite_block': 100},
            {'name': 'people', 'chain': '1502', 'bite_block': 50},
        ]}
        self.relays = [(1, '10.0.0.2', {'peer_id': 'bob'})]
        self.baseline = {'alice': 101, 'people': 51}
        self.last = {'alice': {'finalized': 104, 'peers': [{'peerId': 'bob'}]},
                     'people': {'finalized': 54, 'peers': []}}

    def test_requires_advancing_finality_and_cross_runner_peer(self):
        self.assertEqual(progress(self.mine, self.last, self.baseline, self.relays), (True, True))

    def test_best_block_progress_does_not_replace_finality(self):
        self.last['alice'].update(finalized=101, best=999)
        self.assertEqual(progress(self.mine, self.last, self.baseline, self.relays), (False, True))

    def test_local_peers_do_not_prove_remote_connectivity(self):
        self.last['alice']['peers'] = [{'peerId': 'another-local-node'}]
        self.assertEqual(progress(self.mine, self.last, self.baseline, self.relays), (True, False))

    def test_stalled_people_chain_prevents_pass(self):
        self.last['people']['finalized'] = 51
        self.assertEqual(progress(self.mine, self.last, self.baseline, self.relays), (False, True))

    def test_three_workers_requires_a_peer_from_each_remote_worker(self):
        self.mine['count'] = 3
        self.relays.append((2, '10.0.0.3', {'peer_id': 'charlie'}))
        self.assertEqual(progress(self.mine, self.last, self.baseline, self.relays), (True, False))
        self.last['alice']['peers'].append({'peerId': 'charlie'})
        self.assertEqual(progress(self.mine, self.last, self.baseline, self.relays), (True, True))
