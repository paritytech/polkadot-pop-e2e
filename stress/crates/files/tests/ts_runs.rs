//! Every saved TS run's summary.json reads as a typed `Summary` (the TS schema grew over time).
//! Runs from `STRESS_TS_RESULTS`, else the pop-e2e results folder; no folder, nothing to check.

use std::path::PathBuf;

use stress_files::summary::Summary;

#[test]
fn every_saved_ts_summary_reads() {
    let dir = std::env::var("STRESS_TS_RESULTS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/stress-tests/results")));
    let Ok(runs) = std::fs::read_dir(&dir) else { return };
    let (mut read, mut prototypes, mut failed) = (0, 0, Vec::new());
    for run in runs.flatten() {
        let path = run.path().join("summary.json");
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        // The first prototypes (2026-09-24 morning) had no loss check and no scenario title.
        if !text.contains("\"loss\"") || !text.contains("\"scenario\"") {
            prototypes += 1;
            continue;
        }
        match serde_json::from_str::<Summary>(&text) {
            Ok(_) => read += 1,
            Err(e) => failed.push(format!("{}: {e}", run.file_name().to_string_lossy())),
        }
    }
    println!("{read} TS summaries read, {prototypes} prototype runs skipped");
    assert!(failed.is_empty(), "{failed:#?}");
}
