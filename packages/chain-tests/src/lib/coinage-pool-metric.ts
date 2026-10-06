/** Do not sum gauges from different collators or pool views. */
export function readyPoolGauge(text: string): number {
  const values = text.split('\n').flatMap(line => {
    const match = /^substrate_ready_transactions_number(?:\{[^}]*\})?\s+(\S+)(?:\s+\S+)?$/.exec(line.trim());
    return match ? [Number(match[1])] : [];
  });
  if (values.length !== 1 || !Number.isInteger(values[0]) || values[0] < 0) {
    throw new Error('Expected one valid ingress ready-pool gauge');
  }
  return values[0];
}

export async function readReadyPool(url: string): Promise<number> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Pool telemetry HTTP ${response.status}`);
  return readyPoolGauge(await response.text());
}
