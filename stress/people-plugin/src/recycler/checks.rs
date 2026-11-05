//! Recycler maintenance checks: backlog, maintenance, cleanup, and the time from a voucher load to
//! a built root. They read the run's series, which hold this plugin's series and the run's
//! phases.

use polkameter_checks::{CheckResult, CounterReset, RunData, Status, Verdict, Window, quantile};
use polkameter_files::num;

const NO_DATA: &str = "no Recycler data (no Members pallet?)";

fn sum(d: &RunData, name: &str, t: f64, filter: &[(&str, &str)]) -> f64 {
	d.at(name, filter, t).unwrap_or(0.0)
}

/// Queued, unbuilt, stale rings at `t`.
fn backlog(d: &RunData, t: f64) -> (f64, f64, f64) {
	(
		sum(d, "people_recycler_queued_keys", t, &[]),
		sum(d, "people_recycler_unbuilt_keys", t, &[]),
		sum(d, "people_recycler_stale_rings", t, &[]),
	)
}

/// From the chain recorder's first Recycler read to its last. Our gauges have no value before
/// the first, and the run waits for the Recycler after the loss check, so the last is after the phases.
fn read_window(d: &RunData, name: &str) -> Window {
	let times = d.times(name);
	let (start, end) = times
		.iter()
		.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), t| (a.min(*t), b.max(*t)));
	Window { start, end, label: "read".into() }
}

/// Maintenance calls up to the end of `w`. The observer's counters start at zero when it starts
/// and never reset, so their value is the count; a difference over `w` would drop the calls in
/// the first block the observer read.
fn calls(d: &RunData, w: &Window, filter: &[(&str, &str)]) -> f64 {
	sum(d, "people_maintenance_calls_total", w.end, filter)
}

fn backlog_clears(d: &RunData) -> Result<Verdict, CounterReset> {
	if !d.has("people_recycler_queued_keys", &[]) {
		return Ok(Verdict::new(Status::NoResult, NO_DATA));
	}
	let w = read_window(d, "people_recycler_queued_keys");
	let start = backlog(d, w.start);
	let end = backlog(d, w.end);
	let peak = d.gauge_range("people_recycler_queued_keys", &[], &w).map_or(0.0, |r| r.1);
	let done = d.phase("done").map_or(d.run().end, |p| p.start);
	let mut times: Vec<f64> = d
		.times("people_recycler_unbuilt_keys")
		.into_iter()
		.filter(|t| *t >= done)
		.collect();
	times.sort_by(f64::total_cmp);
	let clear_at = times.iter().copied().find(|t| {
		let b = backlog(d, *t);
		b.0 + b.1 <= start.0 + start.1
	});
	let grew = end.0 > start.0 || end.1 > start.1 || end.2 > start.2;
	let mut detail = format!(
		"at the end: {} queued, {} unbuilt, {} stale rings (start {} / {} / {}); queue peak {}",
		num(end.0),
		num(end.1),
		num(end.2),
		num(start.0),
		num(start.1),
		num(start.2),
		num(peak)
	);
	if let Some(t) = clear_at {
		detail += &format!(
			"; back to the start {} s after the last load",
			num(((t - done) / 1000.0).round())
		);
	}
	Ok(Verdict::new(if grew { Status::Fail } else { Status::Pass }, detail))
}

fn maintenance_keeps_up(d: &RunData) -> Result<Verdict, CounterReset> {
	if !d.has("people_recycler_stale_rings", &[]) {
		return Ok(Verdict::new(Status::NoResult, NO_DATA));
	}
	let w = read_window(d, "people_recycler_stale_rings");
	let stale_peak = d.gauge_range("people_recycler_stale_rings", &[], &w).map_or(0.0, |r| r.1);
	let builds = calls(d, &w, &[("call", "Members.build_ring_authorized"), ("result", "success")]);
	let onboards =
		calls(d, &w, &[("call", "Members.onboard_members_authorized"), ("result", "success")]);
	let failed = calls(d, &w, &[("result", "failed")]);
	let starved = stale_peak > 0.0 && builds == 0.0;
	let detail = format!(
		"{} ring builds, {} onboardings, {} failed maintenance calls; stale rings peak {}",
		num(builds),
		num(onboards),
		num(failed),
		num(stale_peak)
	);
	Ok(Verdict::new(if starved || failed > 0.0 { Status::Fail } else { Status::Pass }, detail))
}

fn cleanup_keeps_up(d: &RunData) -> Result<Verdict, CounterReset> {
	if !d.has("people_cleanup_backlog", &[]) {
		return Ok(Verdict::new(Status::NoResult, NO_DATA));
	}
	let w = read_window(d, "people_cleanup_backlog");
	let kinds: Vec<(&str, f64, f64)> = ["ring_pages", "old_roots", "suspensions"]
		.into_iter()
		.map(|kind| {
			(
				kind,
				sum(d, "people_cleanup_backlog", w.start, &[("kind", kind)]),
				sum(d, "people_cleanup_backlog", w.end, &[("kind", kind)]),
			)
		})
		.collect();
	// Old roots are kept for 600 s, so a run shorter than that ends with more of them.
	let short = w.end - w.start < 600_000.0;
	let grew = kinds
		.iter()
		.any(|(kind, start, end)| end > start && !(short && *kind == "old_roots"));
	let mut detail = kinds
		.iter()
		.map(|(kind, start, end)| format!("{kind} {} -> {}", num(*start), num(*end)))
		.collect::<Vec<_>>()
		.join(", ");
	if short {
		detail += " (old roots are kept 600 s, longer than this run)";
	}
	Ok(Verdict::new(if grew { Status::Warn } else { Status::Pass }, detail))
}

fn load_to_root(d: &RunData) -> Result<Verdict, CounterReset> {
	// Up to the last observation: vouchers keep reaching a root while the run waits for the Recycler.
	let w = Window { start: d.run().start, end: f64::INFINITY, label: "run".into() };
	let b = d.buckets("people_voucher_in_root_seconds", &[], &w)?;
	let n = b
		.as_ref()
		.and_then(|b| b.iter().find(|(le, _)| le.is_infinite()))
		.map_or(0.0, |x| x.1);
	if n == 0.0 {
		return Ok(Verdict::new(
			Status::NoResult,
			"no sampled voucher reached a built root (no loads in this run?)",
		));
	}
	let q = |q: f64| quantile(b.as_ref(), q).map_or("-".into(), num);
	Ok(Verdict::new(
		Status::Info,
		format!("{} sampled vouchers: p50 {} s, p95 {} s (bucket bounds)", num(n), q(0.5), q(0.95)),
	))
}

type Run = fn(&RunData) -> Result<Verdict, CounterReset>;

/// The Recycler checks: name, whether smoke mode may go without a result, and the check.
const CHECKS: [(&str, bool, Run); 4] = [
	("the backlog clears", false, backlog_clears),
	("maintenance keeps up", false, maintenance_keeps_up),
	("cleanup keeps up", false, cleanup_keeps_up),
	("time from load to built root", true, load_to_root),
];

/// Runs every check, then whether the observer recorded everything (`problems` is what it could
/// not record). A counter that went down in a window gives that check no result.
pub fn run(d: &RunData, problems: &[String]) -> Vec<CheckResult> {
	let mut results: Vec<CheckResult> = CHECKS
		.iter()
		.map(|(name, optional, check)| {
			let verdict = check(d).unwrap_or_else(|reset| {
				Verdict::new(Status::NoResult, format!("a node restarted: {reset}"))
			});
			result(name, verdict, *optional)
		})
		.collect();
	let recorded = if problems.is_empty() {
		Verdict::new(Status::Pass, "no unreadable blocks or unnamed extrinsics")
	} else {
		Verdict::new(Status::NoResult, problems.join("; "))
	};
	results.push(result("the Recycler observer recorded everything", recorded, false));
	results
}

fn result(check: &str, verdict: Verdict, optional: bool) -> CheckResult {
	CheckResult { outcome: "recycler".into(), check: check.into(), verdict, optional }
}
