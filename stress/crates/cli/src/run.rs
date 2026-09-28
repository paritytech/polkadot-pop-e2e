//! One scenario run, stage by stage (the order matters; see each step):
//!
//!   preflight → setup → baseline → load → recovery → stop the load and the sampler
//!   → steps.jsonl → loss check → stop the chain recorders → stop the rest → summary

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use stress_chain::Client;
use stress_files::summary::{Loss, MaxSustained, Network, NodePool, SCHEMA_VERSION, Summary};
use stress_files::{FinalStep, NodeMax, NodeSample, RunDir};
use stress_load::runner::{Io, Mode, RunOptions, baseline, drain, load, recover};
use stress_load::sender::Sender;
use stress_load::steps::final_step;
use stress_load::tracker::{Phase, Tracker};
use stress_load::{Scenario, Setup, follower, now_ms, probe_count, rules};
use stress_monitors::{load_targets, preflight::preflight, topology::zombie_json_path};
use tokio_util::sync::CancellationToken;

use crate::wiring::{Chains, Monitors};
use crate::{Common, machine};

fn run_id(id: &str) -> String {
    let secs = now_ms() / 1000;
    format!("{id}-{secs}")
}

fn run_seed() -> [u8; 32] {
    sp_crypto_hashing::blake2_256(format!("{}-{}", now_ms(), std::process::id()).as_bytes())
}

/// Runs scenario `S`; the process exit code (1 when smoke mode found gaps).
pub async fn scenario<S: Scenario>(common: Common, opts: S::Options) -> anyhow::Result<i32> {
    let mode = match common.mode.as_str() {
        "smoke" => Mode::Smoke,
        "stress" => Mode::Stress,
        other => bail!("--mode must be smoke or stress, not {other}"),
    };
    let ramp = common.ramp(S::RAMP);
    let plan = S::plan(&opts, &ramp);
    plan.check(None).map_err(|e| anyhow::anyhow!("the plan: {e}"))?;
    let dir = RunDir::create(&common.out, &run_id(S::ID))?;
    println!("run {} ({}) -> {}", dir.run_id, common.mode, dir.path.display());

    let Preflight { targets, url, relay_url, client, chain, block_interval_s } = preflight_and_connect().await?;

    // Setup.
    let t0 = Instant::now();
    let probes = probe_count(ramp.probes, ramp.recovery_s, block_interval_s);
    let setup = Setup { client: client.clone(), chain, run_seed: run_seed(), block_interval_s, probes };
    let mut prepared = S::prepare(&opts, &setup).await?;
    let setup_seconds = t0.elapsed().as_secs();
    plan.check(Some(prepared.lanes.len())).map_err(|e| anyhow::anyhow!("the plan against the scenario's lanes: {e}"))?;
    let calls: Vec<&str> = prepared.lanes.iter().map(|l| l.call).collect();
    let run_opts = RunOptions { mode, plan, connections: common.connections, recovery_s: ramp.recovery_s, baseline_probes: ramp.probes, block_interval_s };

    // Monitors and the load.
    let (events, _) = tokio::sync::broadcast::channel(64);
    let chains = Chains { people: &client, people_url: &url, relay_url: &relay_url, vouchers: prepared.vouchers.take() };
    let mut monitors = Monitors::start(&dir, targets, &events, chains).await?;
    let (replies_tx, replies) = tokio::sync::mpsc::unbounded_channel();
    let (blocks_tx, blocks) = tokio::sync::mpsc::unbounded_channel();
    let sender = Sender::open(&url, common.connections, replies_tx).await?;
    let follow = CancellationToken::new();
    follower::start(client.clone(), client.normal_limit().await?, blocks_tx, follow.clone());
    let mut tracker = Tracker::new(prepared.lanes, sender, dir.jsonl("load.jsonl")?, dir.jsonl("blocks.jsonl")?, ramp.probes, now_ms());
    let mut io = Io { replies, blocks, events, problems: monitors.problems.clone(), tool_failed: monitors.tool_failed.clone() };

    let phases = async {
        let base = baseline(&mut tracker, &mut io, &run_opts).await?;
        let threshold_ms = (2 * base.max_ms).max((2000.0 * block_interval_s) as u64);
        let (stop, failures) = load(&mut tracker, &mut io, &run_opts).await?;
        println!("stop: {}: {}", stop.rule.name(), stop.detail);
        let recovery_from = now_ms();
        let recovery = recover(&mut tracker, &mut io, &run_opts, threshold_ms).await?;
        let recovery_to = now_ms();
        // Every block the follower still has queued, so no inclusion is missed by the loss check.
        if !drain(&mut tracker, &mut io, 30_000).await? {
            println!("drain: block {} not read after 30 s (last read {})", tracker.last_head.1, tracker.last_fetched);
        }
        Ok::<_, stress_load::runner::RunError>((base, stop, failures, recovery, (recovery_from, recovery_to)))
    };
    let (base, stop, failures, mut recovery, recovery_window) = match phases.await {
        Ok(r) => r,
        Err(e) => {
            follow.cancel();
            // A monitor's own error says more than "a monitor failed".
            if let Err(m) = monitors.stop().await {
                bail!("{e}: {m}");
            }
            bail!(e);
        }
    };
    follow.cancel();
    tracker.set_phase(Phase::Done, now_ms())?;
    // The node's CPU and memory per step come from node.jsonl, complete once the sampler stopped.
    monitors.stop_sampling().await?;
    let samples: Vec<NodeSample> = dir.read_jsonl("node.jsonl")?;
    recovery.node = NodeMax::over(&samples, recovery_window.0, recovery_window.1);
    let finals = write_steps(&dir, &tracker, &calls, &samples)?;
    let loss = loss_check(&client, &monitors, &tracker, &finals, prepared.state_check.as_deref()).await;
    let unreadable = tracker.unreadable.clone();
    tracker.finish()?.close();
    // Let the Recycler build roots for the last loads' vouchers, then stop the chain recorders.
    monitors.stop_chain(Duration::from_millis(rules::RULES.recycler_drain_ms)).await?;
    let mut problems = monitors.problems.all();
    problems.extend(unreadable.into_iter().map(|u| format!("blocks: {u}")));
    monitors.stop().await?;

    // Summary.
    let bp = rules::breaking_point(&finals);
    let sustained = match &bp { None => finals.last(), Some(b) => finals.iter().find(|f| f.step + 1 == b.step) };
    let summary = Summary {
        schema_version: Some(SCHEMA_VERSION),
        scenario: S::TITLE.into(),
        run_id: dir.run_id.clone(),
        mode: common.mode.clone(),
        params: serde_json::json!({ "ramp": ramp, "connections": common.connections, "scenario": opts }),
        budget: prepared.budget,
        setup_seconds,
        extra: prepared.extra,
        rules: serde_json::to_value(rules::RULES)?,
        failure_modes: rules::failure_modes(&stop, &failures, &loss, &finals),
        failures,
        stop,
        breaking_point: bp,
        max_sustained: sustained.map(|f| MaxSustained { step: f.step, target_rate: f.target_rate, included_per_s: f.included_per_s }),
        recovery,
        loss,
        baseline: base,
        problems,
        network: Network { people: url, spec_version: chain.spec_version, block_interval_s: (block_interval_s * 100.0).round() / 100.0 },
        runner: machine::runner(),
        steps: run_opts.plan.steps.len(),
        checks: None,
    };
    let checks = stress_checks::report::write(&dir, summary.clone(), &finals)?;
    Ok(exit_code(mode, &summary, &checks))
}

struct Preflight {
    targets: Vec<stress_monitors::Target>,
    url: String,
    relay_url: String,
    client: Client,
    chain: stress_chain::ChainInfo,
    block_interval_s: f64,
}

/// Our own tools must be right before anything else: topology, metric types, the tx layout.
async fn preflight_and_connect() -> anyhow::Result<Preflight> {
    let zombie = zombie_json_path().context("no zombie.json: set ZOMBIE_JSON or PPN_DIR")?;
    let targets = load_targets(&zombie)?;
    for w in preflight(&targets).await? {
        println!("preflight: {w}");
    }
    let url = std::env::var("PEOPLE_WS").unwrap_or_else(|_| "ws://127.0.0.1:10010".into());
    let relay_url = std::env::var("RELAY_WS").unwrap_or_else(|_| "ws://127.0.0.1:10000".into());
    let client = Client::connect(&url).await?;
    client.check_extensions().await??;
    let chain = client.chain_info().await?;
    let block_interval_s = client.block_interval_s().await?;
    println!("preflight: {} nodes answer, metric types match; People spec {}, {block_interval_s:.1} s blocks", targets.len(), chain.spec_version);
    Ok(Preflight { targets, url, relay_url, client, chain, block_interval_s })
}

/// The loss check, with the node's pool counts read from the collator we submit to after the
/// finality wait (the loss check awaits the read then).
async fn loss_check<S: stress_load::submit::Submit>(client: &Client, monitors: &Monitors, tracker: &Tracker<S>, finals: &[FinalStep], state: Option<&dyn stress_load::StateCheck>) -> Loss {
    let outstanding = tracker.outstanding();
    let included_ok: Vec<_> = tracker.included_ok.concat();
    let scraper = monitors.scraper.clone();
    let node_pool = async move {
        scraper.scrape_now().await;
        let s = scraper.collator.borrow().clone()?;
        Some(NodePool { mempool: s.sum("substrate_sub_txpool_unwatched_txs")? as u64, ready: s.sum("substrate_ready_transactions_number")? as u64 })
    };
    let settled = stress_load::loss::Settled { finals, outstanding: &outstanding, included_ok: &included_ok, last_ours_block: tracker.last_ours_block };
    let loss = stress_load::loss::loss_check(client, settled, node_pool, state).await;
    println!("loss check: {} sent, {} included, {} refused, {:?} in the pool, {:?} lost", loss.sent, loss.included, loss.refused, loss.in_pool, loss.lost);
    loss
}

/// steps.jsonl: one record per step and lane (no lane name in a single-lane run, as TS), with
/// the node's highest CPU and memory while the step ran.
fn write_steps<S: stress_load::submit::Submit>(dir: &RunDir, tracker: &Tracker<S>, calls: &[&str], samples: &[NodeSample]) -> anyhow::Result<Vec<FinalStep>> {
    let single = calls.len() == 1;
    let finals: Vec<FinalStep> = tracker
        .steps
        .iter()
        .zip(calls)
        .flat_map(|(steps, call)| {
            steps.iter().map(move |s| {
                let mut f = final_step(s, (!single).then_some(*call));
                f.node = NodeMax::over(samples, s.started_at, s.ended_at);
                f
            })
        })
        .collect();
    let mut out = dir.jsonl("steps.jsonl")?;
    for f in &finals {
        out.write(f)?;
    }
    out.finish()?;
    Ok(finals)
}

/// 1 in smoke mode when a monitor had a problem or a check that must have a result has none.
fn exit_code(mode: Mode, summary: &Summary, checks: &[stress_checks::CheckResult]) -> i32 {
    if mode != Mode::Smoke {
        return 0;
    }
    let mut errors = summary.problems.clone();
    errors.extend(stress_checks::smoke_gaps(&stress_checks::all(), checks));
    for e in &errors {
        eprintln!("smoke: {e}");
    }
    i32::from(!errors.is_empty())
}

/// `stress check <dir>`: run.om and the checks again, from the files alone.
pub fn check(dir: &Path) -> anyhow::Result<()> {
    let run = RunDir::open(dir);
    let summary: Summary = serde_json::from_str(&std::fs::read_to_string(dir.join("summary.json"))?)?;
    let finals: Vec<FinalStep> = run.read_jsonl("steps.jsonl")?;
    stress_checks::report::write(&run, summary, &finals)?;
    Ok(())
}
