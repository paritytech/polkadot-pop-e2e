import assert from 'node:assert/strict';
import test from 'node:test';
import { readyPoolGauge } from './coinage-pool-metric.js';

test('reads the single ingress gauge and ignores Prometheus declarations', () => {
  assert.equal(readyPoolGauge('# HELP substrate_ready_transactions_number Ready\n'
    + '# TYPE substrate_ready_transactions_number gauge\n'
    + 'substrate_ready_transactions_number{chain="individuality-local"} 8000\n'), 8000);
});
test('missing or ambiguous gauges cannot appear as an empty pool', () => {
  for (const text of ['', 'substrate_ready_transactions_number NaN',
    'substrate_ready_transactions_number -1',
    'substrate_ready_transactions_number{view="a"} 8000\nsubstrate_ready_transactions_number{view="b"} 8000']) {
    assert.throws(() => readyPoolGauge(text));
  }
});
