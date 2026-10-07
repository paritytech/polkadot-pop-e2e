import unittest

from reserved_ports import reservation


class Reservations(unittest.TestCase):
    def test_preserves_existing_ranges_and_reserves_later_collator(self):
        config = {'relaychain': {'nodes': [{'rpc_port': 10000, 'p2p_port': 30334}]},
                  'parachains': [{'collators': [{'rpc_port': 10040, 'p2p_port': 30337,
                                                'prometheus_port': 31000}]}]}
        merged, fixed = reservation('20000-20002,30335-30336', config)
        self.assertEqual(merged, '10000,10040,20000-20002,30334-30337,31000')
        self.assertEqual(fixed, [10000, 10040, 30334, 30337, 31000])

    def test_empty_existing_reservations_and_unspecified_ports(self):
        config = {'relaychain': {'nodes': [{'rpc_port': 10000}, {'rpc_port': 10001}]},
                  'parachains': [{'collators': [{'p2p_port': 30337}]}]}
        self.assertEqual(reservation('', config), ('10000-10001,30337', [10000, 10001, 30337]))

    def test_rejects_invalid_existing_range_instead_of_dropping_it(self):
        with self.assertRaises(AssertionError):
            reservation('30000-20000', {'relaychain': {'nodes': []}, 'parachains': []})


if __name__ == '__main__':
    unittest.main()
