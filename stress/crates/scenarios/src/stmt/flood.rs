//! Statement-store claim flood: ring-proof txs, about 29 ms of weight each.
//!
//! 1. recognize N new people with sudo; wait until they are in built People rings (finalized)
//! 2. prove N × slots claims on the prover pool before the flood (immortal era)
//! 3. check the first and last claim with validate_transaction
//! 4. the runner: baseline, ramp until the chain fails, recovery, loss check
//!
//! Needs a network whose People can build rings (a previewnet fork). The last claims are kept
//! for the baseline and recovery probes.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use stress_chain::setup::{dev_signer, sudo_all};
use stress_chain::{ChainError, Client, Value, fetch, has_prefix};
use stress_files::summary::StateSample;
use stress_load::scenario::BoxFuture;
use stress_load::{Lane, Prepared, QueueSource, Ramp, Scenario, Setup, SetupError, StateCheck, Tx, TxHash};
use stress_proofs::{Job, Prover, ProverPool};

use super::claim::{self, Unproved};
use crate::shared::people::{PEOPLE_COLLECTION, PEOPLE_EXPONENT, make_people};
use crate::shared::rings::wait_for_rings;

/// The `call` label of the load series.
pub const CALL: &str = "Resources.set_statement_store_account";
/// Keys per `force_recognize_personhood` call (PoV is about 2.6 KB per key).
const KEYS_PER_TX: usize = 500;

/// Options of the claim flood.
#[derive(Debug, Clone, Serialize, clap::Args)]
pub struct Options {
    /// New people to recognize.
    #[arg(long, default_value_t = 750)]
    pub members: u32,
    /// Claims per person (people have 20 slots a day).
    #[arg(long, default_value_t = 20)]
    pub slots: u32,
    /// Proving threads (all cores but one when left out).
    #[arg(long)]
    pub threads: Option<usize>,
}

/// The scenario.
#[derive(Debug)]
pub struct StmtFlood;

fn chain(what: &'static str) -> impl FnOnce(ChainError) -> SetupError {
    move |source| SetupError::Chain { what, source }
}

fn scenario(what: &'static str, detail: impl std::fmt::Display) -> SetupError {
    SetupError::Scenario { what, detail: detail.to_string() }
}

impl Scenario for StmtFlood {
    const ID: &'static str = "stmt-flood";
    const TITLE: &'static str = "Statement-store allowance stress test";
    const ARTIFACT: &'static str = "Resources.set_statement_store_account(period, slot, target)";
    const ARTIFACT_DESCRIPTION: &'static str = "The Artifact registers a Statement Store allowance for a target account. Each submitted transaction represents one unique person/slot claim and contains the ring-VRF proof required by the `AsResources` transaction extension.";
    const ARTIFACT_CONTEXT: &'static str = "In the context of coinage, the Statement Store allowance is required to exchange information such as encrypted private keys through the Statement Store in order to perform transfers.";
    type Options = Options;
    /// 6 claims/s fills about 64% of a 6 s People block (1 core); blocks are full at about 8/s,
    /// so most of the ramp is past that point: it looks for what fails once the pool backs up.
    const RAMP: Ramp = Ramp { start: 6.0, step: 4.0, growth: None, interval_s: 60, steps: 10, recovery_s: 900, probes: 5 };

    async fn prepare(opts: &Options, setup: &Setup) -> Result<Prepared, SetupError> {
        let claims = claims(setup, opts.members, opts.slots, opts.threads).await?;
        Ok(Prepared {
            budget: format!("{} people × {} slots = {} claims ({} kept for probes)", opts.members, opts.slots, opts.members * opts.slots, setup.probes),
            lanes: vec![claims.lane],
            extra: claims.extra,
            state_check: Some(Box::new(claims.landed)),
            vouchers: None,
        })
    }
}

/// A lane of claims, proved ahead, with its state check.
pub struct Claims {
    /// The claims, the last `setup.probes` kept for probes.
    pub lane: Lane,
    /// Checks that included claims gave their targets an allowance.
    pub landed: ClaimsLanded,
    /// Numbers for summary.json.
    pub extra: serde_json::Value,
}

/// Recognizes `members` new people, waits for their rings and proves `members × slots` claims:
/// the claim lane of the claim flood.
pub async fn claims(setup: &Setup, members: u32, slots: u32, threads: Option<usize>) -> Result<Claims, SetupError> {
    let client = &setup.client;
    let total = (members * slots) as usize;
    if total <= setup.probes {
        return Err(scenario("budget", format!("{total} claims is not more than the {} kept for probes; add members", setup.probes)));
    }
    // 1. People in built rings.
    let t0 = Instant::now();
    let people = make_people(&setup.run_seed, members);
    let keys: Vec<_> = people.iter().map(|p| p.key).collect();
    let calls = recognize_calls(client, &keys).await?;
    sudo_all(client, &setup.chain, &dev_signer(), &calls, "recognize people").await.map_err(chain("recognize people"))?;
    let (rings, ring_of) = wait_for_rings(client, PEOPLE_COLLECTION, &keys, Duration::from_secs(1200)).await.map_err(chain("rings"))?;
    let rings_s = t0.elapsed().as_secs();
    println!("{} people in {} rings after {rings_s} s", people.len(), rings.len());

    // 2. Prove every claim ahead of the flood.
    let at = client.finalized().await.map_err(chain("finalized"))?;
    let now: u64 = fetch(&at, "Timestamp", "Now", ()).await.map_err(chain("timestamp"))?.unwrap_or(0);
    let suffix: Vec<u8> = fetch(&at, "NetworkSuffix", "NetworkSuffix", ()).await.map_err(chain("network suffix"))?.unwrap_or_default();
    let suffix = String::from_utf8(suffix).map_err(|e| scenario("network suffix", e))?;
    let period = claim::period_of(now);
    let pool = ProverPool::new(threads);
    let t1 = Instant::now();
    let (mut unproved, mut jobs, mut targets) = (Vec::with_capacity(total), Vec::with_capacity(total), Vec::with_capacity(total));
    for seq in 0..slots {
        for (m, ring) in ring_of.iter().enumerate() {
            let target: [u8; 32] = std::array::from_fn(|i| (m as u8) ^ (seq as u8) ^ setup.run_seed[i]);
            let u = Unproved::new(&setup.chain, period, seq, &target);
            jobs.push(Job { member: m, context: claim::context(&suffix, period, seq).to_vec(), message: u.message() });
            unproved.push((u, *ring));
            targets.push((target, m, seq));
        }
    }
    let provers: HashMap<u32, Prover> = rings.iter().map(|(i, r)| Ok((*i, Prover::new(PEOPLE_EXPONENT, r.keys.clone())?))).collect::<Result<_, stress_proofs::ProofError>>().map_err(|e| scenario("prover", e))?;
    let opened = tokio::task::block_in_place(|| people.iter().enumerate().map(|(m, p)| provers[&ring_of[m]].open(p.entropy)).collect::<Result<Vec<_>, _>>()).map_err(|e| scenario("open rings", e))?;
    let proofs = tokio::task::block_in_place(|| pool.prove_all(&opened, &jobs)).map_err(|e| scenario("prove", e))?;
    let prove_s = t1.elapsed().as_secs_f64();
    println!("proved {total} claims in {prove_s:.0} s ({:.1}/s) on {} threads", total as f64 / prove_s, pool.threads());
    let txs: Vec<Tx> = unproved.into_iter().zip(&proofs).map(|((u, ring), p)| Tx::new(u.with_proof(&p.proof, ring, rings[&ring].revision))).collect();
    let by_hash: HashMap<TxHash, Claim> = txs.iter().map(|t| t.hash).zip(targets).map(|(h, (target, member, slot))| (h, Claim { target, member, slot })).collect();

    // 3. The first and the last claim (highest slot) must be valid.
    for t in [&txs[0], &txs[total - 1]] {
        client.validate(&t.bytes, "claim").await.map_err(chain("validate claim"))?;
    }
    let (flood, probes) = txs.split_at(total - setup.probes);
    Ok(Claims {
        lane: Lane { call: CALL, source: Box::new(QueueSource::new(flood.to_vec(), probes.to_vec(), "claims")) },
        landed: ClaimsLanded { by_hash },
        extra: serde_json::json!({
            "period": period, "ringsSeconds": rings_s, "proveSeconds": prove_s.round(), "proverThreads": pool.threads(),
            "rings": rings.values().map(|r| serde_json::json!({ "index": r.index, "revision": r.revision, "keys": r.keys.len() })).collect::<Vec<_>>(),
        }),
    })
}

async fn recognize_calls(client: &Client, keys: &[[u8; 32]]) -> Result<Vec<Vec<u8>>, SetupError> {
    let mut calls = Vec::new();
    for chunk in keys.chunks(KEYS_PER_TX) {
        let people = Value::unnamed_composite(chunk.iter().map(Value::from_bytes));
        calls.push(client.call_data("People", "force_recognize_personhood", vec![people]).await.map_err(chain("recognize call"))?);
    }
    Ok(calls)
}

/// One claim: the account it gives an allowance to, and who claims which slot.
struct Claim {
    target: [u8; 32],
    member: usize,
    slot: u32,
}

/// Each included claim must have given its target an allowance (`StmtStoreAllowanceByAccount`).
pub struct ClaimsLanded {
    by_hash: HashMap<TxHash, Claim>,
}

impl StateCheck for ClaimsLanded {
    fn check<'a>(&'a self, client: &'a Client, included: &'a [TxHash], at: [u8; 32]) -> BoxFuture<'a, Result<StateSample, ChainError>> {
        Box::pin(async move {
            let block = client.at(at).await?;
            let mut missing = 0;
            for hash in included {
                let Some(claim) = self.by_hash.get(hash) else { continue };
                if !has_prefix::<([u8; 32], Value), _>(&block, "Resources", "StmtStoreAllowanceByAccount", (claim.target,)).await? {
                    missing += 1;
                }
            }
            Ok(StateSample { checked: included.len() as u64, missing, detail: "sampled claims have their StmtStoreAllowanceByAccount entry".into() })
        })
    }

    fn describe(&self, tx: &TxHash) -> serde_json::Value {
        self.by_hash.get(tx).map_or(serde_json::Value::Null, |c| serde_json::json!({ "member": c.member, "slot": c.slot, "target": format!("0x{}", hex::encode(c.target)) }))
    }
}
