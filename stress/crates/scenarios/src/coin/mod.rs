//! Coin transfer flood (stub for the architecture check: the source is real and tested in
//! `shared/coins.rs`; seeding is the TS `seed-coins.ts` port, not done yet).

use serde::Serialize;
use stress_load::{Lane, Prepared, Ramp, Scenario, Setup, SetupError};

use crate::shared::coins::CoinSource;

/// The `call` label.
pub const CALL: &str = "Coinage.transfer";

/// Options of the coin flood.
#[derive(Debug, Clone, Serialize, clap::Args)]
pub struct Options {
    /// Coins to seed.
    #[arg(long, default_value_t = 100_000)]
    pub coins: u32,
}

/// The scenario.
#[derive(Debug)]
pub struct CoinFlood;

impl Scenario for CoinFlood {
    const ID: &'static str = "coin-flood";
    const TITLE: &'static str = "Coin transfer flood";
    type Options = Options;
    /// With weights only, the limit is about 1,400 tx/s; the ramp must get there (TS coin-flood).
    const RAMP: Ramp = Ramp { start: 50.0, step: 50.0, interval_s: 60, steps: 40, recovery_s: 600, probes: 5 };

    async fn prepare(opts: &Options, setup: &Setup) -> Result<Prepared, SetupError> {
        let coins = crate::shared::coins_seed::seed(&setup.client, &setup.chain, &setup.run_seed, opts.coins).await?;
        Ok(Prepared {
            lanes: vec![Lane { call: CALL, source: Box::new(CoinSource::new(setup.chain, coins, setup.probes)) }],
            budget: format!("{} coins", opts.coins),
            extra: serde_json::json!({}),
            state_check: None,
            vouchers: None,
        })
    }
}
