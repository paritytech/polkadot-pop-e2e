//! 2. The load: the plan's steps, every lane at its own token bucket, and when a stop ends it.

use stress_files::summary::{Rule, Stop};

use super::{Io, Mode, RunError, RunEvent, RunOptions, interval, next, phase};
use crate::now_ms;
use crate::plan::Until;
use crate::rules::{LiveState, RULES, SourceState, check_step, live_failure, measure_violation, secs};
use crate::steps::final_step;
use crate::submit::Submit;
use crate::tracker::{Phase, Tracker};

/// Whether a stop ends the load. With `Until::FirstFailure` every stop does. With `Until::End`
/// only what makes the numbers after it meaningless: the node closed our connections, a smoke
/// problem, the load tool itself paused, or every lane used up.
pub fn ends_load(stop: &Stop, until: Until, paused: bool, all_exhausted: bool) -> bool {
    until == Until::FirstFailure || paused || all_exhausted || matches!(stop.rule, Rule::NodeDown | Rule::SmokeError)
}

/// 2. The plan's steps. With `Until::FirstFailure` the first failure ends the load; with
///    `Until::End` failures are kept and the load goes on. Returns the stop and every failure.
pub async fn load<S: Submit>(t: &mut Tracker<S>, io: &mut Io, opts: &RunOptions) -> Result<(Stop, Vec<Stop>), RunError> {
    phase(t, io, Phase::Ramp)?;
    let block_ms = opts.block_interval_s * 1000.0;
    let mut failures: Vec<Stop> = Vec::new();
    let mut breaking = false;
    for (k, plan) in opts.plan.steps.iter().enumerate() {
        let k = k as u32;
        t.start_step(k, &plan.rates, now_ms())?;
        let _ = io.events.send(RunEvent::StepEdge(k));
        let ended = send_step(t, io, opts, &plan.rates, plan.seconds, &mut failures).await?;
        t.end_step(now_ms());
        let _ = io.events.send(RunEvent::StepEdge(k));
        log_step(t);
        if !breaking && let Some((_, detail)) = t.steps[0].len().checked_sub(2).and_then(|i| measure_violation(&final_step(&t.steps[0][i], None))) {
            breaking = true;
            println!("breaking point: step {}: {detail}; the load goes on until a failure", k - 1);
        }
        if let Some(stop) = ended {
            return Ok((stop, failures));
        }
        let all_exhausted = t.lanes().iter().all(|l| l.source.exhausted());
        for lane in 0..t.lanes().len() {
            let s = &t.lanes()[lane].source;
            let Some(stop) = check_step(&t.steps[lane], &SourceState { exhausted: s.exhausted(), starved_reason: s.starved_reason() }, t.sender().queued_bytes() / 1024, block_ms) else { continue };
            if ends_load(&stop, opts.plan.until, false, all_exhausted) {
                return Ok((stop, failures));
            }
            if !failures.iter().any(|f| f.rule == stop.rule && f.detail == stop.detail) {
                println!("failure at step {k} in {}: {:?}: {}; the plan runs to the end", t.lanes()[lane].call, stop.rule, stop.detail);
                failures.push(stop);
            }
        }
    }
    let last = opts.plan.steps.len().saturating_sub(1) as u32;
    let done = Stop::new(Rule::RateCap, Some(last), format!("all {} steps ran", opts.plan.steps.len()));
    Ok((failures.first().cloned().unwrap_or(done), failures))
}

/// Sends at the step's rates until it ends. Returns a stop that ends the load; a failure that
/// doesn't (with `Until::End`) is recorded once in `failures` and the step goes on.
async fn send_step<S: Submit>(t: &mut Tracker<S>, io: &mut Io, opts: &RunOptions, rates: &[f64], seconds: u32, failures: &mut Vec<Stop>) -> Result<Option<Stop>, RunError> {
    let end = now_ms() + u64::from(seconds) * 1000;
    let mut tick = interval(20);
    let mut tokens = vec![0.0_f64; rates.len()];
    let mut last = now_ms();
    let step = t.steps[0].last().expect("started").step;
    while now_ms() < end {
        if !next(t, io, &mut tick).await? {
            continue;
        }
        let now = now_ms();
        if now - last > RULES.max_tick_gap_ms {
            let detail = format!("the load tool was paused for {} s (machine sleep or CPU starvation); the numbers after this are not the chain's", (now - last) / 1000);
            return Ok(Some(Stop::new(Rule::GeneratorLimit, Some(step), detail)));
        }
        for (lane, rate) in rates.iter().enumerate() {
            tokens[lane] = (tokens[lane] + rate * (now - last) as f64 / 1000.0).min(rate.max(1.0)); // at most 1 s of catch-up
            while tokens[lane] >= 1.0 && t.send_next(lane, now) {
                tokens[lane] -= 1.0;
            }
            if tokens[lane] >= 1.0 {
                tokens[lane] = 0.0; // nothing ready, or backed up
            }
        }
        last = now;
        t.tick(now)?;
        let live = LiveState {
            step,
            now,
            closed_by_node: t.closed_by_node,
            connections: opts.connections,
            last_block_at: t.last_head.0,
            last_finalized_at: t.last_finalized.0,
            best: t.last_head.1,
            finalized: t.last_finalized.1,
            smoke_problems: if opts.mode == Mode::Smoke { io.problems.all() } else { Vec::new() },
        };
        let Some(stop) = live_failure(&live) else { continue };
        if ends_load(&stop, opts.plan.until, false, false) {
            return Ok(Some(stop));
        }
        if !failures.iter().any(|f| f.rule == stop.rule && f.step == stop.step) {
            println!("failure in step {step}: {:?}: {}; the plan runs to the end", stop.rule, stop.detail);
            failures.push(stop);
        }
    }
    Ok(None)
}

fn log_step<S: Submit>(t: &Tracker<S>) {
    for (lane, steps) in t.steps.iter().enumerate() {
        let f = final_step(steps.last().expect("started"), None);
        println!(
            "step {} {}: target {} tx/s, sent {:.0} tx/s, {} blocks, {:.1} tx/s included, reply p95 {} s, {} replies pending, backlog {}",
            f.step, t.lanes()[lane].call, f.target_rate, f.sent_per_s, f.blocks.blocks, f.included_per_s, secs(f.p95_reply_ms as f64), t.inflight(), t.outstanding().len()
        );
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn stop(rule: Rule) -> Stop {
        Stop::new(rule, Some(3), "x")
    }

    #[test]
    fn a_ramp_ends_at_the_first_failure() {
        assert!(ends_load(&stop(Rule::PoolRefuses), Until::FirstFailure, false, false));
        assert!(ends_load(&stop(Rule::BudgetUsedUp), Until::FirstFailure, false, false));
    }

    #[test]
    fn a_fixed_plan_runs_through_a_stall_and_one_used_up_lane() {
        assert!(!ends_load(&stop(Rule::Stall), Until::End, false, false));
        assert!(!ends_load(&stop(Rule::PoolRefuses), Until::End, false, false));
        assert!(!ends_load(&stop(Rule::BudgetUsedUp), Until::End, false, false), "only that lane is used up");
        assert!(ends_load(&stop(Rule::BudgetUsedUp), Until::End, false, true), "every lane is used up");
        assert!(ends_load(&stop(Rule::NodeDown), Until::End, false, false));
        assert!(ends_load(&stop(Rule::SmokeError), Until::End, false, false));
        assert!(ends_load(&stop(Rule::GeneratorLimit), Until::End, true, false), "the tool paused");
    }
}
