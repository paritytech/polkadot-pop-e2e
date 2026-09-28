//! The loss check, after recovery: every flood tx we sent must be included, refused, expired or
//! still ready in the node's pool; anything else is lost. Then it waits until the last block
//! with our txs is finalized and lets the scenario check chain state for a sample.

use std::time::Duration;

use stress_chain::Client;
use stress_files::FinalStep;
use stress_files::summary::{Finality, Loss, NodePool};

use crate::rules::RULES;
use crate::scenario::StateCheck;
use crate::source::TxHash;

const STATE_SAMPLE: usize = 100;

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
}

/// Runs the loss check. `node_pool` reads the node's own mempool and ready counts from
/// `/metrics` (the caller knows the node); it runs after the finality wait, once our included
/// txs are pruned. Chain errors become notes, never a stop.
pub async fn loss_check(client: &Client, run: Settled<'_>, node_pool: impl std::future::Future<Output = Option<NodePool>>, state: Option<&dyn StateCheck>) -> Loss {
    let mut notes = Vec::new();
    let sum = |f: fn(&FinalStep) -> u64| run.finals.iter().map(f).sum::<u64>();
    let in_pool = match client.pending().await {
        Ok(ready) => Some(run.outstanding.iter().filter(|h| ready.contains(h)).count() as u64),
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
        in_pool,
        lost: in_pool.map(|p| run.outstanding.len() as u64 - p),
        node_pool: None,
        note: None,
        finalized: None,
        state: None,
    };
    let finalized = wait_finalized(client, run.last_ours_block).await;
    match &finalized {
        Ok((number, _)) => {
            let waited_for_it = *number >= run.last_ours_block;
            if !waited_for_it {
                notes.push(format!("block {} not finalized after {} s (finalized {number})", run.last_ours_block, RULES.finality_wait_ms / 1000));
            }
            loss.finalized = Some(Finality { last_ours_block: run.last_ours_block, finalized_at: *number, waited_for_it });
        }
        Err(e) => notes.push(format!("finalized block: {e}")),
    }
    loss.node_pool = node_pool.await;
    if let (Some(check), Ok((_, at)), false) = (state, &finalized, run.included_ok.is_empty()) {
        let ok = run.included_ok;
        let n = STATE_SAMPLE.min(ok.len());
        let sample: Vec<TxHash> = (0..n).map(|i| ok[i * ok.len() / n]).collect();
        match check.check(client, &sample, *at).await {
            Ok(s) => loss.state = Some(s),
            Err(e) => notes.push(format!("state check: {e}")),
        }
    }
    loss.note = (!notes.is_empty()).then(|| notes.join("; "));
    loss
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
