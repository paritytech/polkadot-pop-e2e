/** Bucket i covers (GROWTH^(i-1), GROWTH^i] milliseconds; bucket 0 is everything up to 1 ms. */
const GROWTH = 1.05;

/** Milliseconds; null when the histogram is empty. */
export interface QuantileSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/** A latency histogram in milliseconds with 5% resolution that sums across shards. */
export class Histogram {
  constructor(readonly counts: Record<number, number> = {}) {}

  add(milliseconds: number): void {
    const bucket = milliseconds <= 1 ? 0 : Math.ceil(Math.log(milliseconds) / Math.log(GROWTH));
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
  }

  merge(other: Histogram): void {
    for (const [bucket, count] of Object.entries(other.counts)) {
      this.counts[Number(bucket)] = (this.counts[Number(bucket)] ?? 0) + count;
    }
  }

  get total(): number {
    return Object.values(this.counts).reduce((sum, count) => sum + count, 0);
  }

  /** The upper bound of the bucket containing the `fraction` quantile; null when empty. */
  quantile(fraction: number): number | null {
    const total = this.total;
    if (total === 0) return null;
    const buckets = Object.keys(this.counts).map(Number).sort((a, b) => a - b);
    let seen = 0;
    for (const bucket of buckets) {
      seen += this.counts[bucket];
      if (seen >= fraction * total) return Math.round(GROWTH ** bucket);
    }
    return Math.round(GROWTH ** buckets[buckets.length - 1]);
  }

  summary(): QuantileSummary {
    return { count: this.total, p50: this.quantile(0.5), p95: this.quantile(0.95), p99: this.quantile(0.99), max: this.quantile(1) };
  }
}
