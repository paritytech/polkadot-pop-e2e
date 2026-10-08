//! The summary of a run: builds `run.om` from the raw files, runs the checks on it and writes
//! `summary.json` and `summary.md`. The collator table comes from `run.om` too, so the summary
//! and the checks read the same numbers, and `stress check <dir>` can write it all again later.

use stress_files::summary::{ProbePhase, Rule, Summary};
use stress_files::{BlockStats, FileError, FinalStep, RunDir, build_run_om, num, parse_run_om, to_fixed};

use crate::{CheckResult, RunData, Status, Window, all, run};

/// Builds run.om, runs every check, writes summary.json (with the checks) and summary.md.
pub fn write(dir: &RunDir, mut summary: Summary, finals: &[FinalStep]) -> Result<Vec<CheckResult>, FileError> {
    let text = build_run_om(dir)?;
    let data = RunData::new(parse_run_om(&text), summary.clone());
    let checks = run(&all(), &data);
    summary.checks = Some(serde_json::to_value(&checks).expect("checks serialize"));
    dir.write_json("summary.json", &summary)?;
    let md = markdown(&summary, finals, &data, &checks);
    std::fs::write(dir.path.join("summary.md"), &md).map_err(|source| FileError::Io { path: dir.path.join("summary.md").display().to_string(), source })?;
    println!("\n{md}");
    Ok(checks)
}

/// The whole summary.md. The decision-making result stays above the fold; measurements needed
/// for diagnosis remain available without making the GitHub job summary hard to scan.
pub fn markdown(s: &Summary, finals: &[FinalStep], d: &RunData, checks: &[CheckResult]) -> String {
    format!(
        "{}\n\n<details>\n<summary><strong>Diagnostics and full measurements</strong></summary>\n\n{}\n\n### Outcome checks\n\n{}\n\n</details>\n",
        render_overview(s, finals, checks),
        render_diagnostics(s, finals, d),
        render_checks(checks)
    )
}

fn status_rank(status: Status) -> u8 {
    match status {
        Status::Fail => 0,
        Status::Warn => 1,
        Status::NoResult => 2,
        Status::Info => 3,
        Status::Pass => 4,
    }
}

/// The checks table, ordered so that actionable results are visible first.
pub fn render_checks(results: &[CheckResult]) -> String {
    let mut ordered: Vec<_> = results.iter().collect();
    ordered.sort_by_key(|r| status_rank(r.verdict.status));
    let mut lines = vec!["| outcome | check | status | detail |".to_owned(), "| --- | --- | --- | --- |".to_owned()];
    lines.extend(ordered.into_iter().map(|r| {
        format!("| {} | {} | **{}** | {} |", r.outcome.name(), r.check, r.verdict.status.name(), r.verdict.detail.replace('|', "\\|"))
    }));
    lines.join("\n")
}

/// `-` for nothing, else the number to `digits` places.
fn fmt(n: Option<f64>, digits: usize) -> String {
    n.map_or("-".into(), |n| to_fixed(n, digits))
}

fn row(cells: &[String]) -> String {
    format!("| {} |", cells.join(" | "))
}

const COLLATOR: (&str, &str) = ("job", "people-collator");

/// The collator in one step: mean build time, pool work, and why blocks ended.
struct CollatorStep {
    build_ms: Option<f64>,
    validations: Option<f64>,
    waiting: Option<f64>,
    ready: Option<f64>,
    end_reasons: Vec<(String, f64)>,
}

/// `None` without collator metrics, or when a counter went down (the node restarted).
fn collator_step(d: &RunData, w: Option<&Window>) -> Option<CollatorStep> {
    let w = w?;
    if !d.has("substrate_proposer_end_proposal_reason", &[COLLATOR]) {
        return None;
    }
    let at = |name: &str| d.at(name, &[COLLATOR], w.end);
    let builds = d.diff("substrate_proposer_block_constructed_count", &[COLLATOR], w).ok()?;
    let build_s = d.diff("substrate_proposer_block_constructed_sum", &[COLLATOR], w).ok()?;
    let (scheduled, finished) = (at("substrate_sub_txpool_validations_scheduled"), at("substrate_sub_txpool_validations_finished"));
    Some(CollatorStep {
        build_ms: match (builds, build_s) {
            (Some(b), Some(s)) if b != 0.0 => Some(1000.0 * s / b),
            _ => None,
        },
        validations: d.diff("substrate_sub_txpool_validations_finished", &[COLLATOR], w).ok()?,
        waiting: scheduled.zip(finished).map(|(s, f)| s - f),
        ready: at("substrate_ready_transactions_number"),
        end_reasons: d.end_reasons(w).ok()?,
    })
}

fn block_cells(b: &BlockStats) -> Vec<String> {
    vec![
        b.blocks.to_string(),
        format!("{} / {}", fmt(b.mean_block_gap_ms.map(|g| g / 1000.0), 1), fmt(b.max_block_gap_ms.map(|g| g as f64 / 1000.0), 1)),
        b.max_ours_per_block.to_string(),
        to_fixed(b.max_normal_ref_time_pct, 1),
        to_fixed(b.max_normal_proof_pct, 1),
    ]
}

fn collator_cells(c: Option<&CollatorStep>) -> Vec<String> {
    let why = match c {
        Some(c) => {
            let s = c.end_reasons.iter().map(|(k, v)| format!("{k} {}", num(*v))).collect::<Vec<_>>().join(", ");
            if s.is_empty() { "-".into() } else { s }
        }
        None => "no metrics".into(),
    };
    vec![fmt(c.and_then(|c| c.build_ms), 0), fmt(c.and_then(|c| c.validations), 0), fmt(c.and_then(|c| c.waiting), 0), fmt(c.and_then(|c| c.ready), 0), why]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverallStatus {
    Pass,
    Warn,
    Fail,
    Inconclusive,
}

/// One top-level answer from the runner's stop, its performance measure and the outcome checks.
fn overall_status(s: &Summary, checks: &[CheckResult]) -> OverallStatus {
    if s.stop.class.is_some() || !s.failure_modes.is_empty() || s.breaking_point.is_some() || checks.iter().any(|r| r.verdict.status == Status::Fail) {
        return OverallStatus::Fail;
    }
    if s.stop.rule != Rule::RateCap {
        return OverallStatus::Inconclusive;
    }
    let definitions = all();
    let required_gap = checks.iter().any(|r| {
        r.verdict.status == Status::NoResult && definitions.iter().any(|c| c.name == r.check && !c.optional)
    });
    if required_gap {
        OverallStatus::Inconclusive
    } else if checks.iter().any(|r| r.verdict.status == Status::Warn) {
        OverallStatus::Warn
    } else {
        OverallStatus::Pass
    }
}

fn recovery_line(s: &Summary) -> String {
    let r = &s.recovery;
    if !r.measured {
        return format!("not measured: {}", r.detail);
    }
    if r.recovered {
        let left = match r.drained_seconds {
            None => format!("{} left", r.backlog_at_end),
            Some(d) => format!("drained after {d} s"),
        };
        format!("back {} s after the load stopped ({}). Backlog at stop {} txs, {left}, at {} tx/s.", fmt(r.seconds.map(|x| x as f64), 0), r.detail, r.backlog_at_stop, to_fixed(r.drain_per_s, 1))
    } else {
        format!("not back within the budget: {}. Backlog at stop {} txs, {} left, drained at {} tx/s.", r.detail, r.backlog_at_stop, r.backlog_at_end, to_fixed(r.drain_per_s, 1))
    }
}

fn loss_line(s: &Summary) -> String {
    let l = &s.loss;
    let mut out = format!(
        "{} sent: {} included ({} failed in the block), {} refused, {} expired, {} still ready in the pool, **{} lost**",
        l.sent,
        l.included,
        l.failed_in_block,
        l.refused,
        l.dropped,
        fmt(l.in_pool.map(|x| x as f64), 0),
        fmt(l.lost.map(|x| x as f64), 0)
    );
    if let Some(p) = &l.node_pool {
        out += &format!(" (the node's mempool holds {} txs, {} of them ready)", p.mempool, p.ready);
    }
    if let Some(n) = &l.note {
        out += &format!(" ({n})");
    }
    let c = &l.on_chain;
    out += &format!(
        ". On the finalized chain (blocks {}-{}): {} included; {} the tracker missed (in a block that replaced one it read), {} only on a fork block, {} moved to another block",
        c.blocks.0, c.blocks.1, c.included, c.missed, c.only_on_fork, c.moved
    );
    if let Some(st) = &l.state {
        out += &format!(". State check: {} of {} {}", st.checked.saturating_sub(st.missing), st.checked, st.detail);
    }
    out
}

fn step_row(f: &FinalStep) -> String {
    let mut cells = vec![
        f.step.to_string(),
        num(f.target_rate),
        to_fixed(f.seconds, 1),
        f.sent.to_string(),
        to_fixed(f.sent_per_s, 0),
        to_fixed(f.included_per_s, 0),
        to_fixed(100.0 * f.included_ratio, 1),
        to_fixed(f.p50_latency_ms as f64 / 1000.0, 1),
        to_fixed(f.p95_latency_ms as f64 / 1000.0, 1),
        to_fixed(f.p95_reply_ms as f64 / 1000.0, 2),
        f.rejected.to_string(),
        f.dropped.to_string(),
        f.failed_in_block.to_string(),
    ];
    cells.extend(block_cells(&f.blocks));
    row(&cells)
}

/// Refusals over every step, by "code message", most first; ties keep the order they were seen in.
fn rpc_errors(steps: &[FinalStep]) -> Vec<(String, u64)> {
    let mut errors: Vec<(String, u64)> = Vec::new();
    for (k, v) in steps.iter().flat_map(|f| &f.errors) {
        match errors.iter_mut().find(|(e, _)| e == k) {
            Some((_, n)) => *n += v,
            None => errors.push((k.clone(), *v)),
        }
    }
    errors.sort_by(|a, b| b.1.cmp(&a.1));
    errors
}

fn status_badge(status: OverallStatus) -> &'static str {
    match status {
        OverallStatus::Pass => "✅ PASS",
        OverallStatus::Warn => "⚠️ WARN",
        OverallStatus::Fail => "❌ FAIL",
        OverallStatus::Inconclusive => "❔ INCONCLUSIVE",
    }
}

fn short_loss_line(s: &Summary) -> String {
    let l = &s.loss;
    let lost = l.lost.map_or_else(|| "loss not determined".into(), |n| format!("**{n} lost**"));
    format!(
        "{} sent; {} found on the finalized chain; {} refused; {} expired; {} failed in a block; {lost}",
        l.sent, l.on_chain.included, l.refused, l.dropped, l.failed_in_block
    )
}

fn check_counts(checks: &[CheckResult]) -> String {
    let count = |status| checks.iter().filter(|r| r.verdict.status == status).count();
    format!(
        "{} failed, {} warned, {} passed, {} had no result, {} informational",
        count(Status::Fail),
        count(Status::Warn),
        count(Status::Pass),
        count(Status::NoResult),
        count(Status::Info)
    )
}

fn response_label(s: &Summary, step: &FinalStep) -> String {
    if step.sent == 0 {
        return "— no submissions".into();
    }
    let limit = |key, fallback| s.rules.get(key).and_then(serde_json::Value::as_f64).unwrap_or(fallback);
    // Use the recorded rules, not today's runner defaults, when re-rendering old runs.
    let mut failures = Vec::new();
    if step.included_ratio < limit("minIncludedRatio", 0.9) {
        failures.push("inclusion");
    }
    if step.p95_latency_ms as f64 > limit("maxP95LatencyMs", 10_000.0) {
        failures.push("latency");
    }
    if step.rejected_ratio > limit("maxRefusedRatio", 0.01) {
        failures.push("refusals");
    }
    if failures.is_empty() {
        "✅ within limits".into()
    } else {
        format!("❌ {}", failures.join(", "))
    }
}

/// The compact part of the report: enough to decide what happened without opening diagnostics.
fn render_overview(s: &Summary, steps: &[FinalStep], checks: &[CheckResult]) -> String {
    let status = overall_status(s, checks);
    let capacity = s.max_sustained.as_ref().map_or_else(
        || "No sustained rate was established".into(),
        |m| format!("Sustained {} tx/s", num(m.target_rate)),
    );
    let onset = s.breaking_point.as_ref().map_or_else(
        || "No response criterion was violated.".into(),
        |b| format!("Failure began at {} tx/s: {}, {}.", num(b.target_rate), b.measure, b.detail),
    );
    let integrity = match s.loss.lost {
        Some(n) => format!("Of {} sent, {} were found on the finalized chain; **{n} lost**.", s.loss.sent, s.loss.on_chain.included),
        None => format!("Of {} sent, {} were found on the finalized chain; loss was not determined.", s.loss.sent, s.loss.on_chain.included),
    };
    let recovery = if s.recovery.measured && s.recovery.recovered {
        let back = s.recovery.seconds.map_or_else(|| "Recovery was observed".into(), |n| format!("Normal response returned after {n} s"));
        let drained = s.recovery.drained_seconds.map_or_else(
            || format!("{} transactions remained in the backlog", s.recovery.backlog_at_end),
            |n| format!("the backlog drained after {n} s"),
        );
        format!(" {back}; {drained}.")
    } else if s.recovery.measured {
        format!(" Recovery was not observed within the budget; {} transactions remained.", s.recovery.backlog_at_end)
    } else {
        String::new()
    };

    let mut lines = vec![
        format!("### {} — {}", s.scenario, status_badge(status)),
        String::new(),
        format!("> **{capacity}.** {onset} {integrity}{recovery}"),
    ];

    if !steps.is_empty() {
        lines.extend([
            String::new(),
            "#### Capacity".into(),
            String::new(),
            format!(
                "| target | included/s | inclusion p95 (limit {} s) | response |",
                to_fixed(s.rules.get("maxP95LatencyMs").and_then(serde_json::Value::as_f64).unwrap_or(10_000.0) / 1000.0, 1)
            ),
            "| ---: | ---: | ---: | --- |".into(),
        ]);
        lines.extend(steps.iter().map(|f| {
            format!(
                "| {} tx/s | {} | {} s | {} |",
                num(f.target_rate),
                to_fixed(f.included_per_s, 0),
                to_fixed(f.p95_latency_ms as f64 / 1000.0, 1),
                response_label(s, f)
            )
        }));
    }

    lines.extend([
        String::new(),
        "#### Key findings".into(),
        String::new(),
    ]);
    if let Some(b) = &s.breaking_point {
        lines.push(format!("- **Failure onset:** step {} at {} tx/s — {}, {}", b.step, num(b.target_rate), b.measure, b.detail));
    } else {
        lines.push("- **Failure onset:** no response criterion was violated".into());
    }
    lines.extend([
        format!("- **Load stop:** {} — {}", s.stop.rule.name(), s.stop.detail),
        format!("- **Recovery:** {}", recovery_line(s)),
        format!("- **Integrity:** {}", short_loss_line(s)),
        format!("- **Checks:** {}", check_counts(checks)),
    ]);
    lines.extend(checks.iter().filter(|r| r.verdict.status == Status::Fail).map(|r| format!("- **Failed check — {}:** {}", r.check, r.verdict.detail)));
    let warnings: Vec<_> = checks.iter().filter(|r| r.verdict.status == Status::Warn).map(|r| r.check).collect();
    if !warnings.is_empty() {
        lines.push(format!("- **Warnings:** {}", warnings.join("; ")));
    }
    lines.join("\n")
}

/// Full-fidelity measurements retained behind the report's diagnostics disclosure.
fn render_diagnostics(s: &Summary, steps: &[FinalStep], d: &RunData) -> String {
    let r = &s.recovery;
    let min_included_pct = s.rules.get("minIncludedRatio").and_then(serde_json::Value::as_f64).map(|v| 100.0 * v).unwrap_or(90.0);
    let max_latency_s = s.rules.get("maxP95LatencyMs").and_then(serde_json::Value::as_f64).map(|v| v / 1000.0).unwrap_or(10.0);
    let max_refused_pct = s.rules.get("maxRefusedRatio").and_then(serde_json::Value::as_f64).map(|v| 100.0 * v).unwrap_or(1.0);
    let windows = d.steps();
    let step_window = |k: u32| windows.iter().find(|w| w.label == format!("step {k}"));
    let mut lines: Vec<String> = Vec::new();
    if let Some(artifact) = &s.artifact {
        lines.extend([
            "#### Artifact under test".into(),
            String::new(),
            format!("`{}`", artifact.name),
            String::new(),
            artifact.description.clone(),
            String::new(),
            artifact.context.clone(),
            String::new(),
        ]);
    }
    lines.extend([
        "#### Stress method".into(),
        String::new(),
        "The stress test offers unique, prepared Artifact transactions at increasing rates in consecutive fixed-duration steps. The first step that violates a stress criterion is the failure onset.".into(),
        String::new(),
        format!("A step fails the response criteria when fewer than {}% of its transactions are eventually included, p95 send-to-inclusion latency exceeds {} s, or more than {}% of submissions are refused.", to_fixed(min_included_pct, 0), to_fixed(max_latency_s, 1), to_fixed(max_refused_pct, 0)),
        String::new(),
        format!("Scenario setup prepared {}. Setup took {} s and is excluded from the measured load. The baseline then sent {} probes, one per block.", s.budget, s.setup_seconds, s.baseline.probes),
        String::new(),
        "#### Detailed result".into(),
        String::new(),
        format!("- **Load stop:** {}: {}", s.stop.rule.name(), s.stop.detail),
        format!("- **Recovery:** {}", recovery_line(s)),
        format!("- **Loss check:** {}", loss_line(s)),
        format!("- **Baseline:** {} probes before the load, p50 {} s, max {} s", s.baseline.probes, to_fixed(s.baseline.p50_ms as f64 / 1000.0, 1), to_fixed(s.baseline.max_ms as f64 / 1000.0, 1)),
        format!("- **Network:** People spec {}, {} s blocks at start", s.network.spec_version, num(s.network.block_interval_s)),
        format!("- **Runner:** {} CPUs ({})", s.runner.cpus, s.runner.cpu_model.as_deref().unwrap_or("?")),
        String::new(),
        "#### Full load steps".into(),
        String::new(),
        format!("| step | target tx/s | duration s | transactions sent | sent/s | included/s | eventually included % | p50 s | p95 s (limit {}) | reply p95 s | refused | expired | failed | blocks | block gap s (mean / max) | max ours/block | max ref time % | max proof % |", to_fixed(max_latency_s, 1)),
        format!("|{}", " ---: |".repeat(18)),
    ]);
    lines.extend(steps.iter().map(step_row));
    let mut cells = vec!["recovery".to_owned()];
    cells.extend(std::iter::repeat_n("-".to_owned(), 12));
    cells.extend(block_cells(&r.blocks));
    lines.push(row(&cells));
    lines.extend([
        String::new(),
        "#### People collator metrics".into(),
        String::new(),
        "CPU/memory is for the submitting collator; block/pool metrics cover all collators.".into(),
        String::new(),
        "| step | max CPU % | max memory MiB | block build ms | pool validations (all) | validations waiting (all) | pool ready txs (all) | why blocks ended |".into(),
        format!("|{} --- |", " ---: |".repeat(7)),
    ]);
    for f in steps {
        let c = collator_step(d, step_window(f.step));
        let mut cells = vec![f.step.to_string(), fmt(f.node.max_cpu_pct.map(|x| x as f64), 0), fmt(f.node.max_rss_mi_b.map(|x| x as f64), 0)];
        cells.extend(collator_cells(c.as_ref()));
        lines.push(row(&cells));
    }
    let c = collator_step(d, d.phase("recovery").as_ref());
    let mut cells = vec!["recovery".to_owned(), fmt(r.node.max_cpu_pct.map(|x| x as f64), 0), fmt(r.node.max_rss_mi_b.map(|x| x as f64), 0)];
    cells.extend(collator_cells(c.as_ref()));
    lines.push(row(&cells));
    lines.push(String::new());
    let probes: Vec<_> = r.probes.iter().filter(|p| p.phase == ProbePhase::Recovery).collect();
    if !probes.is_empty() {
        let landed: Vec<String> = probes
            .iter()
            .map(|p| format!("{} s: {}", to_fixed(p.sent_at_s, 0), p.latency_ms.map_or_else(|| p.outcome.name().to_owned(), |l| format!("{} s", to_fixed(l as f64 / 1000.0, 1)))))
            .collect();
        lines.extend([
            "#### Recovery probes".into(),
            String::new(),
            format!("One per block; landing within {} s counts as back:", to_fixed(r.threshold_ms as f64 / 1000.0, 1)),
            String::new(),
            landed.join(", "),
            String::new(),
        ]);
    }
    let errors = rpc_errors(steps);
    if !errors.is_empty() {
        lines.extend(["#### RPC errors".into(), String::new()]);
        lines.extend(errors.iter().take(5).map(|(k, v)| format!("- {v} × `{k}`")));
        lines.push(String::new());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use stress_files::registry::Outcome;
    use stress_files::summary::{Artifact, BreakingPoint};

    use super::*;
    use crate::Verdict;

    fn summary() -> Summary {
        serde_json::from_str(include_str!("../tests/summary.json")).expect("summary fixture")
    }

    fn check(name: &'static str, status: Status) -> CheckResult {
        CheckResult { outcome: Outcome::Run, check: name, verdict: Verdict::new(status, "test") }
    }

    #[test]
    fn passing_checks_and_a_rate_cap_pass() {
        assert_eq!(overall_status(&summary(), &[check("monitors recorded everything", Status::Pass)]), OverallStatus::Pass);
    }

    #[test]
    fn a_breaking_point_fails() {
        let mut s = summary();
        s.breaking_point = Some(BreakingPoint { step: 1, target_rate: 18.0, measure: "latency".into(), detail: "p95 27.3 s".into() });
        assert_eq!(overall_status(&s, &[]), OverallStatus::Fail);
    }

    #[test]
    fn ending_before_the_rate_cap_is_inconclusive() {
        let mut s = summary();
        s.stop = stress_files::summary::Stop::new(Rule::BudgetUsedUp, Some(1), "no claims left");
        assert_eq!(overall_status(&s, &[]), OverallStatus::Inconclusive);
    }

    #[test]
    fn a_failed_outcome_check_fails() {
        assert_eq!(overall_status(&summary(), &[check("People relay slots (level 1)", Status::Fail)]), OverallStatus::Fail);
    }

    #[test]
    fn the_summary_separates_the_verdict_from_the_load_stop() {
        let s = summary();
        let data = RunData::new(parse_run_om("# EOF\n"), s.clone());
        let md = markdown(&s, &[], &data, &[check("People relay slots (level 1)", Status::Fail)]);
        assert!(md.starts_with("### Statement-store claim flood — ❌ FAIL"));
        assert!(md.contains("- **Load stop:** rate cap"));
        assert!(!md.contains("- **Failure:**"));
        assert!(md.contains("pool validations (all)"));
    }

    #[test]
    fn the_summary_explains_the_artifact_load_and_exact_threshold() {
        let mut s = summary();
        s.artifact = Some(Artifact {
            name: "Resources.set_statement_store_account(period, slot, target)".into(),
            description: "One unique person/slot claim with a ring-VRF proof.".into(),
            context: "Coinage exchanges encrypted private keys through the Statement Store to perform transfers.".into(),
        });
        let step = FinalStep { step: 0, target_rate: 15.0, seconds: 60.0, sent: 900, p95_latency_ms: 8_400, ..FinalStep::default() };
        let data = RunData::new(parse_run_om("# EOF\n"), s.clone());
        let md = markdown(&s, &[step], &data, &[]);
        assert!(md.contains("#### Artifact under test"));
        assert!(md.contains("`Resources.set_statement_store_account(period, slot, target)`"));
        assert!(md.contains("Coinage exchanges encrypted private keys"));
        assert!(md.contains("p95 send-to-inclusion latency exceeds 10.0 s"));
        assert!(md.contains("p95 s (limit 10.0)"));
        assert!(md.contains("| 0 | 15 | 60.0 | 900 |"));
        assert!(!md.contains("wait for one transaction"));
    }

    #[test]
    fn the_result_stays_above_the_fold_and_diagnostics_are_retained() {
        let s = summary();
        let data = RunData::new(parse_run_om("# EOF\n"), s.clone());
        let step = FinalStep {
            step: 0,
            target_rate: 12.0,
            sent: 720,
            included_per_s: 12.0,
            included_ratio: 1.0,
            p95_latency_ms: 3_600,
            ..FinalStep::default()
        };
        let checks = [check("passing check", Status::Pass), check("warning", Status::Warn), check("failure", Status::Fail)];
        let md = markdown(&s, &[step], &data, &checks);
        let (overview, diagnostics) = md.split_once("<details>").unwrap();
        assert!(overview.contains("**Sustained 5 tx/s.**"));
        assert!(overview.contains("144 were found on the finalized chain; **0 lost**"));
        assert!(overview.contains("Normal response returned after 1 s; the backlog drained after 3 s"));
        assert!(overview.contains("inclusion p95 (limit 10.0 s)"));
        assert!(overview.contains("| 12 tx/s | 12 | 3.6 s | ✅ within limits |"));
        assert!(overview.contains("**Failed check — failure:** test"));
        assert!(overview.contains("**Warnings:** warning"));
        assert!(overview.contains("1 failed, 1 warned, 1 passed, 0 had no result, 0 informational"));
        assert!(!overview.contains("pool validations"));
        assert!(!overview.contains("#### Recovery probes"));
        assert!(diagnostics.contains("#### Full load steps"));
        assert!(diagnostics.contains("eventually included %"));
        assert!(diagnostics.contains("#### Recovery probes"));
        assert!(diagnostics.contains("### Outcome checks"));
        assert!(diagnostics.contains("State check: 100 of 100"));
        assert!(md.ends_with("</details>\n"));
    }

    #[test]
    fn response_labels_use_recorded_limits_and_each_steps_actual_measurements() {
        let mut s = summary();
        s.breaking_point = Some(BreakingPoint { step: 1, target_rate: 15.0, measure: "latency".into(), detail: "p95 24.7 s".into() });
        let mut step = FinalStep { step: 2, sent: 900, included_ratio: 1.0, p95_latency_ms: 24_700, ..FinalStep::default() };
        assert_eq!(response_label(&s, &step), "❌ latency");
        s.rules["maxP95LatencyMs"] = serde_json::json!(30_000);
        assert_eq!(response_label(&s, &step), "✅ within limits");
        step.included_ratio = 0.8;
        step.rejected_ratio = 0.02;
        assert_eq!(response_label(&s, &step), "❌ inclusion, refusals");
        step.sent = 0;
        assert_eq!(response_label(&s, &step), "— no submissions");
    }

    #[test]
    fn unknown_loss_and_unmeasured_recovery_are_not_reported_as_success() {
        let mut s = summary();
        s.max_sustained = None;
        s.loss.lost = None;
        s.recovery.measured = false;
        s.recovery.detail = "RPC closed".into();
        s.stop = stress_files::summary::Stop::new(Rule::BudgetUsedUp, Some(1), "no claims left");
        let md = render_overview(&s, &[], &[]);
        assert!(md.contains("❔ INCONCLUSIVE"));
        assert!(md.contains("No sustained rate was established"));
        assert!(md.contains("loss was not determined"));
        assert!(md.contains("loss not determined"));
        assert!(md.contains("not measured: RPC closed"));
        assert!(!md.contains("Normal response returned"));
        assert!(!md.contains("**0 lost**"));
    }

    #[test]
    fn checks_are_sorted_by_severity_and_escape_table_separators() {
        let mut failure = check("failed check", Status::Fail);
        failure.verdict.detail = "left | right".into();
        let checks = [
            check("passed check", Status::Pass),
            check("warning check", Status::Warn),
            failure,
            check("missing check", Status::NoResult),
            check("info check", Status::Info),
        ];
        let md = render_checks(&checks);
        let positions: Vec<_> = ["failed check", "warning check", "missing check", "info check", "passed check"].iter().map(|name| md.find(name).unwrap()).collect();
        assert!(positions.windows(2).all(|p| p[0] < p[1]));
        assert!(md.contains("left \\| right"));
    }

    #[test]
    fn a_required_gap_is_inconclusive_but_an_optional_gap_is_not() {
        assert_eq!(overall_status(&summary(), &[check("monitors recorded everything", Status::NoResult)]), OverallStatus::Inconclusive);
        assert_eq!(overall_status(&summary(), &[check("time from load to built root", Status::NoResult)]), OverallStatus::Pass);
    }

    #[test]
    fn warnings_warn() {
        assert_eq!(overall_status(&summary(), &[check("build time within the authoring deadline", Status::Warn)]), OverallStatus::Warn);
    }
}
