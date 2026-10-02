//! After the load: when do new txs land in time again.

use stress_files::summary::{Outcome, Probe, ProbePhase};
use stress_files::{BlockRecord, Millis};

use crate::rules::RULES;

/// The send time of the first of `probes_in_a_row` recovery probes in a row that landed within
/// the threshold, with blocks from then on at about the start interval. `None` while not back.
pub fn recovered_at(probes: &[Probe], blocks: &[BlockRecord], threshold_ms: Millis, block_ms: f64) -> Option<Millis> {
    let rec: Vec<&Probe> = probes.iter().filter(|p| p.phase == ProbePhase::Recovery).collect();
    let good = |p: &&Probe| p.outcome == Outcome::Included && p.latency_ms.is_some_and(|l| l <= threshold_ms);
    rec.windows(RULES.probes_in_a_row).find_map(|w| {
        if !w.iter().all(good) {
            return None;
        }
        let gaps: Vec<u64> = blocks.iter().filter(|b| b.seen_at >= w[0].sent_at).filter_map(|b| b.gap_ms).collect();
        let mean = if gaps.is_empty() { 0.0 } else { gaps.iter().sum::<u64>() as f64 / gaps.len() as f64 };
        (mean <= RULES.recovered_block_gap_factor * block_ms).then_some(w[0].sent_at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(sent_at: Millis, latency: Millis) -> Probe {
        Probe { phase: ProbePhase::Recovery, sent_at_s: sent_at as f64 / 1000.0, latency_ms: Some(latency), outcome: Outcome::Included, sent_at }
    }

    #[test]
    fn is_back_at_the_first_of_3_probes_in_a_row_within_the_threshold() {
        let blocks: Vec<BlockRecord> = [6_000, 12_000, 18_000, 24_000].map(|seen_at| BlockRecord { seen_at, gap_ms: Some(6_000), ..Default::default() }).to_vec();
        let probes = [probe(0, 30_000), probe(6_000, 7_000), probe(12_000, 6_000), probe(18_000, 6_000)];
        assert_eq!(recovered_at(&probes, &blocks, 12_000, 6_000.0), Some(6_000));
        assert_eq!(recovered_at(&probes[..3], &blocks, 12_000, 6_000.0), None);
    }
}
