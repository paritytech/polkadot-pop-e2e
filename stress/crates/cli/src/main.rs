//! `stress`: runs one scenario end to end (preflight, setup, load, recovery, loss check,
//! summary), or rebuilds `run.om` and the checks of a finished run.
//!
//! Adding a scenario is one variant here and a module in `stress-scenarios`.

mod machine;
mod run;
mod wiring;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use stress_scenarios::stmt::flood::StmtFlood;

/// Options every scenario has. The ramp flags change the scenario's own defaults
/// (`Scenario::RAMP`); left out, the defaults hold.
#[derive(Debug, Clone, clap::Args, serde::Serialize)]
pub struct Common {
    /// First step's rate, tx/s.
    #[arg(long)]
    pub start: Option<f64>,
    /// Rate added per step.
    #[arg(long)]
    pub step: Option<f64>,
    /// Step length, s.
    #[arg(long)]
    pub interval: Option<u32>,
    /// Steps.
    #[arg(long)]
    pub steps: Option<u32>,
    /// Recovery budget, s.
    #[arg(long)]
    pub recovery: Option<u32>,
    /// Baseline probes.
    #[arg(long)]
    pub probes: Option<usize>,
    /// Sender connections.
    #[arg(long, default_value_t = 4)]
    pub connections: usize,
    /// smoke: any problem fails the run; stress: only tool errors do.
    #[arg(long, default_value = "stress")]
    pub mode: String,
    /// Results root.
    #[arg(long, default_value = "results")]
    pub out: PathBuf,
}

impl Common {
    /// The scenario's ramp with the flags that were given.
    pub fn ramp(&self, d: stress_load::Ramp) -> stress_load::Ramp {
        stress_load::Ramp {
            start: self.start.unwrap_or(d.start),
            step: self.step.unwrap_or(d.step),
            interval_s: self.interval.unwrap_or(d.interval_s),
            steps: self.steps.unwrap_or(d.steps),
            recovery_s: self.recovery.unwrap_or(d.recovery_s),
            probes: self.probes.unwrap_or(d.probes),
        }
    }
}

#[derive(Debug, Parser)]
#[command(name = "stress", about = "Non-functional tests of People")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Statement-store claim flood.
    StmtFlood {
        #[command(flatten)]
        common: Common,
        #[command(flatten)]
        opts: stress_scenarios::stmt::flood::Options,
    },
    /// Builds run.om from a run's raw files and runs the checks again.
    Check {
        /// The run directory.
        dir: PathBuf,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::StmtFlood { common, opts } => std::process::exit(run::scenario::<StmtFlood>(common, opts).await?),
        Command::Check { dir } => run::check(&dir),
    }
}
