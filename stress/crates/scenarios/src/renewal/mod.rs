//! Renewal hour (stub for the architecture check): the Android daily renewal after 00:00 UTC.
//! N devices renew their slots over 3,600 s on a curve, while coin transfers run steady, and the
//! run goes to the end whatever fails, to measure how long payments wait. Two lanes, one plan.

use serde::Serialize;
use stress_load::{Lane, Plan, Prepared, Ramp, Scenario, Setup, SetupError};

use crate::shared::coins::CoinSource;

/// Options of the renewal hour.
#[derive(Debug, Clone, Serialize, clap::Args)]
pub struct Options {
    /// Devices renewing.
    #[arg(long, default_value_t = 10_000)]
    pub devices: u32,
    /// Slots per device.
    #[arg(long, default_value_t = 2)]
    pub slots: u32,
    /// Steady coin transfers, tx/s.
    #[arg(long, default_value_t = 5.0)]
    pub payments: f64,
}

/// The scenario.
#[derive(Debug)]
pub struct RenewalHour;

/// Claims per second in each of `steps` one-minute steps: most devices renew early in the hour
/// (their hourly jobs are not aligned, so the renewals spread over it).
fn curve(total: f64, steps: u32) -> Vec<f64> {
    let weights: Vec<f64> = (0..steps).map(|m| (-(f64::from(m)) / 20.0).exp()).collect();
    let sum = weights.iter().fold(0.0, |a, w| a + w);
    weights.iter().map(|w| total * w / sum / 60.0).collect()
}

impl Scenario for RenewalHour {
    const ID: &'static str = "renewal-hour";
    const TITLE: &'static str = "Android renewal hour";
    type Options = Options;
    /// Only recovery and probes apply: the plan is the hour, from the options.
    const RAMP: Ramp = Ramp { start: 0.0, step: 0.0, interval_s: 60, steps: 60, recovery_s: 900, probes: 5 };

    fn plan(opts: &Options, r: &Ramp) -> Plan {
        let rates = curve(f64::from(opts.devices * opts.slots), r.steps).into_iter().map(|claims| vec![claims, opts.payments]).collect();
        Plan::curve(rates, r.interval_s)
    }

    async fn prepare(opts: &Options, setup: &Setup) -> Result<Prepared, SetupError> {
        let claims = crate::stmt::flood::claims(setup, opts.devices, opts.slots, None).await?;
        let coins = crate::shared::coins_seed::seed(&setup.client, &setup.chain, &setup.run_seed, 10_000).await?;
        Ok(Prepared {
            lanes: vec![claims.lane, Lane { call: crate::coin::CALL, source: Box::new(CoinSource::new(setup.chain, coins, 0)) }],
            budget: format!("{} devices × {} slots, {} payments/s", opts.devices, opts.slots, opts.payments),
            extra: serde_json::json!({}),
            state_check: Some(Box::new(claims.landed)),
            vouchers: None,
        })
    }
}
