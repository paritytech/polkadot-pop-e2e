import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('case_queue', Path(__file__).with_name('coinage-case-queue.py'))
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class WatchTests(unittest.TestCase):
    def test_external_rerun_does_not_replace_original_attempt(self):
        attempt = {'runId': 123, 'runAttempt': 1, 'status': 'in_progress'}
        with patch.object(queue, 'gh_json', return_value={'attempt': 2, 'status': 'queued'}), \
                patch.object(queue, 'save') as save:
            with self.assertRaisesRegex(RuntimeError, 'External rerun'):
                queue.watch('ledger', {}, {}, attempt)
        self.assertEqual(attempt['runAttempt'], 1)
        self.assertEqual(attempt['status'], 'in_progress')
        self.assertEqual(attempt['externalRerun']['observedAttempt'], 2)
        save.assert_called_once()

    def test_first_observation_cannot_adopt_a_bot_rerun(self):
        attempt = {'runId': 123, 'status': 'queued'}
        with patch.object(queue, 'gh_json', return_value={'attempt': 2, 'status': 'in_progress'}), \
                patch.object(queue, 'save'):
            with self.assertRaisesRegex(RuntimeError, 'attempt 1 -> 2'):
                queue.watch('ledger', {}, {}, attempt)
        self.assertEqual(attempt['runAttempt'], 1)

    def test_read_timeout_keeps_watching_the_same_run(self):
        attempt = {'runId': 123, 'runAttempt': 1, 'status': 'queued'}
        completed = {'attempt': 1, 'status': 'completed', 'conclusion': 'failure',
                     'headSha': 'abc', 'jobs': []}
        with patch.object(queue, 'gh_json', side_effect=[subprocess.TimeoutExpired('gh', 120), completed]) as read, \
                patch.object(queue, 'save'), patch.object(queue.time, 'sleep') as sleep:
            queue.watch('ledger', {}, {}, attempt)
        self.assertEqual(read.call_args_list[0], read.call_args_list[1])
        sleep.assert_called_once_with(queue.POLL_SECONDS)
        self.assertEqual(attempt['conclusion'], 'failure')


if __name__ == '__main__':
    unittest.main()
