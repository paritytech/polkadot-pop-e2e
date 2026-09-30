//! How fast to send, step by step and lane by lane. A ramp is one plan; a burst, or a curve with
//! several lanes, are others. Each step is one window for the stop
//! rules and the checks.

use crate::source::LoadSource;

/// One load of a run: its own txs, rate and counts. The `call` names it in the load series.
pub struct Lane {
    /// `call` label, e.g. `Resources.set_statement_store_account`.
    pub call: &'static str,
    /// Its txs.
    pub source: Box<dyn LoadSource>,
}

impl std::fmt::Debug for Lane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lane").field("call", &self.call).finish_non_exhaustive()
    }
}

/// One step: how long, and the target rate of each lane.
#[derive(Debug, Clone, PartialEq)]
pub struct StepPlan {
    /// Length.
    pub seconds: u32,
    /// Target tx/s per lane, in lane order.
    pub rates: Vec<f64>,
}

/// When the load ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Until {
    /// At the first failure: a stress test looks for the breaking point.
    FirstFailure,
    /// After the last step, failures or not: a scenario that measures a fixed period.
    End,
}

/// A scenario's ramp defaults; every field can be changed from the command line.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ramp {
    /// First step's rate, tx/s.
    pub start: f64,
    /// Rate added per step.
    pub step: f64,
    /// Step length, s.
    pub interval_s: u32,
    /// Steps.
    pub steps: u32,
    /// Recovery budget, s.
    pub recovery_s: u32,
    /// Baseline probes.
    pub probes: usize,
}

/// The steps of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The steps.
    pub steps: Vec<StepPlan>,
    /// When the load ends.
    pub until: Until,
}

impl Plan {
    /// One lane: `start` tx/s, plus `step` every `interval_s`, for `steps` steps.
    pub fn ramp(start: f64, step: f64, interval_s: u32, steps: u32) -> Self {
        let steps = (0..steps).map(|k| StepPlan { seconds: interval_s, rates: vec![start + f64::from(k) * step] }).collect();
        Self { steps, until: Until::FirstFailure }
    }

    /// Per step, the rates of every lane, each step `interval_s` long; runs to the end.
    pub fn curve(rates: Vec<Vec<f64>>, interval_s: u32) -> Self {
        Self { steps: rates.into_iter().map(|rates| StepPlan { seconds: interval_s, rates }).collect(), until: Until::End }
    }
}

impl Plan {
    /// Checks the plan before any setup: steps, one rate per lane in every step, no negative
    /// rate. `lanes` is checked once the scenario built them.
    pub fn check(&self, lanes: Option<usize>) -> Result<(), String> {
        let first = self.steps.first().ok_or("the plan has no step")?;
        let n = lanes.unwrap_or(first.rates.len());
        for (k, s) in self.steps.iter().enumerate() {
            if s.rates.len() != n {
                return Err(format!("step {k} has {} rates for {n} lanes", s.rates.len()));
            }
            if s.seconds == 0 || s.rates.iter().any(|r| !r.is_finite() || *r < 0.0) {
                return Err(format!("step {k}: {} s at {:?} tx/s", s.seconds, s.rates));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_is_checked_against_its_lanes() {
        assert!(Plan::ramp(6.0, 4.0, 60, 10).check(Some(1)).is_ok());
        assert!(Plan::ramp(6.0, 4.0, 60, 10).check(Some(2)).unwrap_err().contains("1 rates for 2 lanes"));
        assert!(Plan::curve(vec![vec![1.0, 5.0], vec![2.0]], 60).check(None).is_err());
        assert!(Plan::ramp(6.0, 4.0, 60, 0).check(None).is_err());
    }
}
