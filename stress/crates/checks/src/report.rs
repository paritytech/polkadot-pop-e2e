//! The summary of a run: builds `run.om` from the raw files, runs the checks on it and writes
//! `summary.json` and `summary.md`. The collator table comes from `run.om` too, so the summary
//! and the checks read the same numbers, and `stress check <dir>` can write it all again later.

use stress_files::summary::{ProbePhase, Rule, Summary};
use stress_files::{BlockStats, FileError, FinalStep, RunDir, build_run_om, num, parse_run_om, to_fixed};

use crate::block_production::end_reasons;
use crate::{CheckResult, RunData, Window, all, run};

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

/// The whole summary.md.
pub fn markdown(s: &Summary, finals: &[FinalStep], d: &RunData, checks: &[CheckResult]) -> String {
    format!("{}\n### Outcome checks\n\n{}\n", render_summary(s, finals, d), render_checks(checks))
}

/// The checks table.
pub fn render_checks(results: &[CheckResult]) -> String {
    let mut lines = vec!["| outcome | check | status | detail |".to_owned(), "| --- | --- | --- | --- |".to_owned()];
    lines.extend(results.iter().map(|r| format!("| {} | {} | **{}** | {} |", r.outcome.name(), r.check, r.verdict.status.name(), r.verdict.detail.replace('|', "\\|"))));
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
        end_reasons: end_reasons(d, w).ok()?,
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

fn headline(s: &Summary, steps: &[FinalStep]) -> String {
    let rate_of = |step: Option<u32>| step.and_then(|k| steps.iter().find(|f| f.step == k)).map_or("null".to_owned(), |f| num(f.target_rate));
    match s.stop.class {
        Some(class) => format!("failed at {} tx/s: {} ({})", rate_of(s.stop.step), s.stop.rule.name(), class.name()),
        None if s.stop.rule == Rule::RateCap => format!("no failure up to {} tx/s", steps.last().map_or("0".into(), |f| num(f.target_rate))),
        None => format!("ended by {} before a failure", s.stop.rule.name()),
    }
}

fn verdict(s: &Summary) -> String {
    if s.stop.class.is_some() || !s.failure_modes.is_empty() {
        format!("Failure modes: {}.", s.failure_modes.iter().map(|m| format!("**{}** ({})", m.class.name(), m.what)).collect::<Vec<_>>().join("; "))
    } else if s.stop.rule == Rule::RateCap {
        "No failure. A stress test that ends without failure is a performance test with a generous budget: raise `--steps` or `--step`.".into()
    } else {
        format!("Not a stress result: the run ended before the chain failed ({}).", s.stop.rule.name())
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
    if let Some(st) = &l.state {
        out += &format!(". State check: {} of {} {}", st.checked.saturating_sub(st.missing), st.checked, st.detail);
    }
    out
}

fn step_row(f: &FinalStep) -> String {
    let mut cells = vec![
        f.step.to_string(),
        num(f.target_rate),
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

fn render_summary(s: &Summary, steps: &[FinalStep], d: &RunData) -> String {
    let r = &s.recovery;
    let bp = s.breaking_point.as_ref().map_or("no measure violated".into(), |b| format!("step {} ({} tx/s): {}, {}", b.step, num(b.target_rate), b.measure, b.detail));
    let best = s.max_sustained.as_ref().map_or("none".into(), |m| format!("{} tx/s target (step {}), {} tx/s included", num(m.target_rate), m.step, to_fixed(m.included_per_s, 0)));
    let windows = d.steps();
    let step_window = |k: u32| windows.iter().find(|w| w.label == format!("step {k}"));
    let mut lines: Vec<String> = vec![
        format!("### {}: {}", s.scenario, headline(s, steps)),
        String::new(),
        format!("- **Verdict:** {}", verdict(s)),
        format!("- **Breaking point** (first violated measure): {bp}"),
        format!("- **Max sustained:** {best}"),
        format!("- **Failure:** {}: {}", s.stop.rule.name(), s.stop.detail),
        format!("- **Recovery:** {}", recovery_line(s)),
        format!("- **Loss check:** {}", loss_line(s)),
        format!("- **Baseline:** {} probes before the load, p50 {} s, max {} s", s.baseline.probes, to_fixed(s.baseline.p50_ms as f64 / 1000.0, 1), to_fixed(s.baseline.max_ms as f64 / 1000.0, 1)),
        format!("- **Network:** People spec {}, {} s blocks at start", s.network.spec_version, num(s.network.block_interval_s)),
        format!("- **Budget:** {}, set up in {} s", s.budget, s.setup_seconds),
        format!("- **Runner:** {} CPUs ({})", s.runner.cpus, s.runner.cpu_model.as_deref().unwrap_or("?")),
        String::new(),
        "| step | target tx/s | sent/s | included/s | included % | p50 s | p95 s | reply p95 s | refused | expired | failed | blocks | block gap s (mean / max) | max ours/block | max ref time % | max proof % |".into(),
        format!("|{}", " ---: |".repeat(16)),
    ];
    lines.extend(steps.iter().map(step_row));
    let mut cells = vec!["recovery".to_owned()];
    cells.extend(std::iter::repeat_n("-".to_owned(), 10));
    cells.extend(block_cells(&r.blocks));
    lines.push(row(&cells));
    lines.extend([
        String::new(),
        "People node (collator) per step:".into(),
        String::new(),
        "| step | max CPU % | max memory MiB | block build ms | pool validations | validations waiting | pool ready txs | why blocks ended |".into(),
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
        lines.extend([format!("Recovery probes (one per block; landing within {} s counts as back):", to_fixed(r.threshold_ms as f64 / 1000.0, 1)), String::new(), landed.join(", "), String::new()]);
    }
    let errors = rpc_errors(steps);
    if !errors.is_empty() {
        lines.extend(["RPC errors:".into(), String::new()]);
        lines.extend(errors.iter().take(5).map(|(k, v)| format!("- {v} × `{k}`")));
        lines.push(String::new());
    }
    lines.join("\n")
}
