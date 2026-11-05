//! The loss check, after recovery: every flood tx we sent must be included, refused, expired or
//! still ready in the node's pool; anything else is lost. Then it waits until the last block
//! with our txs is finalized, counts our txs again on the finalized chain (the tracker read best
//! blocks, which a reorg can replace), and lets the scenario check chain state for a sample.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use stress_chain::{Client, tx_hash};
use stress_files::FinalStep;
use stress_files::summary::{Finality, Loss, LostTx, NodePool, OnChain};

use crate::rules::RULES;
use crate::scenario::StateCheck;
use crate::source::TxHash;
use crate::tracker::FloodTx;

const STATE_SAMPLE: usize = 100;
/// Lost txs checked one by one for lost.jsonl; the rest are only counted.
const LOST_DETAILED: usize = 1000;

/// Everything the loss check needs from the run.
#[derive(Debug)]
pub struct Settled<'a> {
    /// Final step numbers of every lane.
    pub finals: &'a [FinalStep],
    /// Flood txs not included, refused or expired.
    pub outstanding: &'a [TxHash],
    /// Included flood txs that did not fail, in send order.
    pub included_ok: &'a [TxHash],
    /// The highest block with one of ours.
    pub last_ours_block: u32,
    /// Every flood tx sent.
    pub flood: &'a HashMap<TxHash, FloodTx>,
    /// The block the tracker saw each included flood tx in.
    pub included_in: &'a HashMap<TxHash, u32>,
    /// The first block the tracker read.
    pub first_fetched: Option<u32>,
}

/// Runs the loss check, and gives the lost txs for lost.jsonl. `node_pool` reads the node's own
/// mempool and ready counts from `/metrics` (the caller knows the node); it runs after the
/// finality wait, once our included txs are pruned. Chain errors become notes, never a stop.
pub async fn loss_check(client: &Client, run: Settled<'_>, node_pool: impl std::future::Future<Output = Option<NodePool>>, state: Option<&dyn StateCheck>) -> (Loss, Vec<LostTx>) {
    let mut notes = Vec::new();
    let sum = |f: fn(&FinalStep) -> u64| run.finals.iter().map(f).sum::<u64>();
    let ready: Option<HashSet<TxHash>> = match client.pending().await {
        Ok(ready) => Some(ready.into_iter().collect()),
        Err(e) => {
            notes.push(format!("the pool could not be listed: {e}"));
            None
        }
    };
    let mut loss = Loss {
        sent: sum(|f| f.sent),
        included: sum(|f| f.included),
        failed_in_block: sum(|f| f.failed_in_block),
        refused: sum(|f| f.rejected),
        dropped: sum(|f| f.dropped),
        ..Loss::default()
    };
    let finalized = wait_finalized(client, run.last_ours_block).await;
    let mut on_chain = None;
    match &finalized {
        Ok((number, _)) => {
            let waited_for_it = *number >= run.last_ours_block;
            if !waited_for_it {
                notes.push(format!("block {} not finalized after {} s (finalized {number})", run.last_ours_block, RULES.finality_wait_ms / 1000));
            }
            loss.finalized = Some(Finality { last_ours_block: run.last_ours_block, finalized_at: *number, waited_for_it });
            if let Some(first) = run.first_fetched {
                match finalized_txs(client, run.flood, first, *number).await {
                    Ok(found) => on_chain = Some((first, *number, found)),
                    Err(e) => notes.push(format!("the finalized chain could not be walked: {e}")),
                }
            }
        }
        Err(e) => notes.push(format!("finalized block: {e}")),
    }
    if run.first_fetched.is_none() {
        notes.push("no block was read, so the finalized chain was not walked".into());
    }
    let r = reconcile(run.outstanding, run.included_in, on_chain.as_ref().map(|(_, _, f)| f));
    if let Some((first, last, found)) = &on_chain {
        loss.on_chain = OnChain { blocks: (*first, *last), included: found.len() as u64, missed: r.missed, only_on_fork: r.only_on_fork, moved: r.moved };
    }
    let (in_pool, unaccounted): (Vec<_>, Vec<_>) = match &ready {
        Some(ready) => r.unaccounted.into_iter().partition(|(h, _)| ready.contains(h)),
        None => (Vec::new(), r.unaccounted),
    };
    // Lost needs both the pool and the finalized chain: without the walk, a tx the tracker
    // missed in a reorg would count as lost.
    let known = ready.is_some() && on_chain.is_some();
    if ready.is_some() {
        loss.in_pool = Some(in_pool.len() as u64);
    }
    if known {
        loss.lost = Some(unaccounted.len() as u64);
    }
    loss.node_pool = node_pool.await;
    let at = finalized.as_ref().ok().map(|(_, at)| *at);
    if let (Some(check), Some(at), false) = (state, at, run.included_ok.is_empty()) {
        let ok = run.included_ok;
        let n = STATE_SAMPLE.min(ok.len());
        let sample: Vec<TxHash> = (0..n).map(|i| ok[i * ok.len() / n]).collect();
        match check.check(client, &sample, at).await {
            Ok(s) => loss.state = Some(s),
            Err(e) => notes.push(format!("state check: {e}")),
        }
    }
    if known && unaccounted.len() > LOST_DETAILED {
        notes.push(format!("lost.jsonl has the first {LOST_DETAILED} of {} lost txs", unaccounted.len()));
    }
    let mut lost = Vec::new();
    for (hash, on_fork_block) in unaccounted.into_iter().take(if known { LOST_DETAILED } else { 0 }) {
        let Some(tx) = run.flood.get(&hash) else { continue };
        let state_landed = match (state, at) {
            (Some(check), Some(at)) => check.check(client, &[hash], at).await.ok().map(|s| s.missing == 0),
            _ => None,
        };
        let validate = match client.validate(&tx.bytes, "lost tx").await {
            Ok(()) => "valid".to_owned(),
            Err(e) => e.to_string(),
        };
        lost.push(LostTx {
            hash: format!("0x{}", hex::encode(hash)),
            step: tx.step,
            sent_at: tx.sent_at,
            on_fork_block,
            scenario: state.map_or(serde_json::Value::Null, |s| s.describe(&hash)),
            state_landed,
            validate,
        });
    }
    lost.sort_by_key(|l| l.sent_at);
    loss.note = (!notes.is_empty()).then(|| notes.join("; "));
    (loss, lost)
}

/// Our flood txs in the finalized blocks `first..=last`, with the block each is in.
async fn finalized_txs(client: &Client, flood: &HashMap<TxHash, FloodTx>, first: u32, last: u32) -> Result<HashMap<TxHash, u32>, stress_chain::ChainError> {
    let mut found = HashMap::new();
    for n in first..=last {
        let hash = client.block_hash(n).await?;
        for x in client.body(hash).await? {
            let h = tx_hash(&x);
            if flood.contains_key(&h) {
                found.insert(h, n);
            }
        }
    }
    Ok(found)
}

/// The tracker's view against the finalized chain.
#[derive(Debug, PartialEq)]
struct Reconciled {
    /// In a finalized block, never seen by the tracker.
    missed: u64,
    /// Seen by the tracker in a block the finalized chain doesn't have, and in no finalized block.
    only_on_fork: u64,
    /// Seen in one block, finalized in another.
    moved: u64,
    /// In no finalized block: each with the fork block the tracker saw it in, if any.
    unaccounted: Vec<(TxHash, Option<u32>)>,
}

/// Without `on_chain` (the walk failed) the tracker's view stands: the outstanding txs.
fn reconcile(outstanding: &[TxHash], included_in: &HashMap<TxHash, u32>, on_chain: Option<&HashMap<TxHash, u32>>) -> Reconciled {
    let Some(chain) = on_chain else {
        return Reconciled { missed: 0, only_on_fork: 0, moved: 0, unaccounted: outstanding.iter().map(|h| (*h, None)).collect() };
    };
    let mut r = Reconciled { missed: 0, only_on_fork: 0, moved: 0, unaccounted: Vec::new() };
    for h in outstanding {
        if chain.contains_key(h) {
            r.missed += 1;
        } else {
            r.unaccounted.push((*h, None));
        }
    }
    for (h, seen) in included_in {
        match chain.get(h) {
            Some(n) if n != seen => r.moved += 1,
            Some(_) => {}
            None => {
                r.only_on_fork += 1;
                r.unaccounted.push((*h, Some(*seen)));
            }
        }
    }
    r
}

async fn wait_finalized(client: &Client, block: u32) -> Result<(u32, [u8; 32]), stress_chain::ChainError> {
    let deadline = crate::now_ms() + RULES.finality_wait_ms;
    loop {
        let at = client.finalized().await?;
        let number = at.block_number() as u32;
        if number >= block || crate::now_ms() > deadline {
            return Ok((number, at.block_hash().0));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(n: u8) -> TxHash {
        [n; 32]
    }

    #[test]
    fn a_reorg_moves_txs_between_the_counts() {
        // The tracker saw 1 and 2 in block 10 and 3 in block 11; 4 and 5 it never saw.
        let included_in = HashMap::from([(h(1), 10), (h(2), 10), (h(3), 11)]);
        let outstanding = [h(4), h(5)];
        // Finalized: block 10 was replaced by one with 1 and 4; 2 was included again in 12.
        let chain = HashMap::from([(h(1), 10), (h(4), 10), (h(2), 12)]);
        let r = reconcile(&outstanding, &included_in, Some(&chain));
        assert_eq!((r.missed, r.only_on_fork, r.moved), (1, 1, 1));
        let mut unaccounted = r.unaccounted;
        unaccounted.sort();
        assert_eq!(unaccounted, [(h(3), Some(11)), (h(5), None)]);
    }

    #[test]
    fn without_the_chain_the_tracker_view_stands() {
        let r = reconcile(&[h(4)], &HashMap::from([(h(1), 10)]), None);
        assert_eq!(r.unaccounted, [(h(4), None)]);
    }
}
