//! The Recycler observer. `start` follows People's finalized blocks into this plugin's
//! `series.jsonl` and declares the metrics in `metrics.json`, so Polkameter reads them with the
//! run's own series. `stop` waits for the backlog to return to where it started, then stops.
//! `checks` judges the recorded series against the run's phases.

mod checks;
mod metrics;
mod monitor;

use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use polkameter_chain::Client;
use polkameter_checks::{CheckResult, RunData};
use polkameter_files::summary::Summary;
use polkameter_files::{Problems, RunDir, read_store};
use polkameter_monitors::{MonitorError, chain_series, walker};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use monitor::RecyclerRecorder;

/// A running observer.
pub struct Running {
	stop: CancellationToken,
	walker: JoinHandle<Result<(), MonitorError>>,
	writer: JoinHandle<Result<(), polkameter_files::FileError>>,
	drained: watch::Receiver<bool>,
	problems: Problems,
}

/// Starts recording into `dir`. `None` when the chain has no Members pallet.
pub async fn start(client: Client, dir: &Path) -> Result<Option<Running>> {
	std::fs::create_dir_all(dir)?;
	std::fs::write(dir.join("metrics.json"), serde_json::to_vec_pretty(&metrics::declarations())?)?;
	let (series, ops) = chain_series::channel();
	let writer = tokio::spawn(chain_series::run(RunDir::open(dir).jsonl("series.jsonl")?, ops));
	let Some((recorder, drained)) = RecyclerRecorder::new(client.clone(), series).await? else {
		writer.await??;
		return Ok(None);
	};
	let (stop, problems) = (CancellationToken::new(), Problems::default());
	let walker = tokio::spawn(walker::walk(client, recorder, stop.clone(), problems.clone()));
	Ok(Some(Running { stop, walker, writer, drained, problems }))
}

impl Running {
	/// Waits up to `drain` for the backlog to return to its start, then stops and returns what
	/// could not be recorded.
	pub async fn stop(mut self, drain: Duration) -> Result<Vec<String>> {
		let _ = tokio::time::timeout(drain, self.drained.wait_for(|d| *d)).await;
		self.stop.cancel();
		self.walker.await??;
		self.writer.await??;
		Ok(self.problems.all())
	}
}

/// The Recycler checks for the run in `run_dir`, plus whether the observer recorded everything.
pub fn checks(run_dir: &Path, problems: &[String]) -> Result<Vec<CheckResult>> {
	let run = RunDir::open(run_dir);
	let summary: Summary = serde_json::from_slice(&std::fs::read(run_dir.join("summary.json"))?)?;
	let data = RunData::new(read_store(&run)?, summary);
	Ok(checks::run(&data, problems))
}
