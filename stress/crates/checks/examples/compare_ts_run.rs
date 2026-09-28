//! Compares this evaluator with the TS tool on saved runs, from each run's own `run.om` and
//! `summary.json`: every check (status, detail, numbers) and the whole `summary.md`. Writes nothing.
//!
//! `cargo run --release -p stress-checks --example compare_ts_run -- <results root or run dir>...`

use std::path::{Path, PathBuf};

use serde_json::Value;
use stress_checks::report::markdown;
use stress_files::summary::Summary;
use stress_files::{FinalStep, RunDir, parse_run_om};

fn main() {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for arg in std::env::args().skip(1) {
        let p = PathBuf::from(arg);
        if p.join("summary.json").exists() {
            dirs.push(p);
        } else if let Ok(entries) = std::fs::read_dir(&p) {
            dirs.extend(entries.flatten().map(|e| e.path()).filter(|p| p.join("summary.json").exists()));
        }
    }
    dirs.sort();
    let mut all_same = true;
    for dir in &dirs {
        all_same &= compare(dir);
    }
    println!("{} runs compared; {}", dirs.len(), if all_same { "all identical" } else { "differences above" });
}

/// Numbers as f64, so 9 and 9.0 compare equal.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn compare(dir: &Path) -> bool {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (Ok(om), Ok(summary_text), Ok(ts_md)) = (std::fs::read_to_string(dir.join("run.om")), std::fs::read_to_string(dir.join("summary.json")), std::fs::read_to_string(dir.join("summary.md"))) else {
        println!("{name}: no run.om, summary.json or summary.md");
        return false;
    };
    let ts: Value = serde_json::from_str(&summary_text).expect("summary.json is JSON");
    let mut summary: Summary = match serde_json::from_str(&summary_text) {
        Ok(s) => s,
        Err(e) => {
            println!("{name}: summary.json does not read as a Summary: {e}");
            return false;
        }
    };
    summary.checks = None;
    let finals: Vec<FinalStep> = RunDir::open(dir).read_jsonl("steps.jsonl").expect("steps.jsonl");
    let data = stress_checks::RunData::new(parse_run_om(&om), summary.clone());
    let results = stress_checks::run(&stress_checks::all(), &data);
    let theirs = ts["checks"].as_array().cloned().unwrap_or_default();
    let mut same = 0;
    let mut diffs = Vec::new();
    for r in &results {
        let ours = serde_json::to_value(r).expect("a result serializes");
        let Some(t) = theirs.iter().find(|c| c["check"] == r.check) else {
            diffs.push(format!("  {}: not in the TS summary", r.check));
            continue;
        };
        let (status, detail, numbers) = (ours["status"] == t["status"], ours["detail"] == t["detail"], ours.get("numbers").map(norm) == t.get("numbers").map(norm));
        if status && detail && numbers {
            same += 1;
            continue;
        }
        diffs.push(format!("  {}: status {} detail {} numbers {}", r.check, ok(status), ok(detail), ok(numbers)));
        if !detail {
            diffs.push(format!("    ours:   {}\n    theirs: {}", ours["detail"], t["detail"]));
        }
        if !numbers {
            let cut = |v: Option<&Value>| v.map(ToString::to_string).unwrap_or_default().chars().take(300).collect::<String>();
            diffs.push(format!("    ours:   {}\n    theirs: {}", cut(ours.get("numbers")), cut(t.get("numbers"))));
        }
    }
    let md = markdown(&summary, &finals, &data, &results);
    let md_same = md == ts_md;
    println!("{name}: {same} of {} checks identical ({} in TS); summary.md {}", results.len(), theirs.len(), if md_same { "identical" } else { "differs" });
    for d in &diffs {
        println!("{d}");
    }
    if !md_same {
        for (i, (a, b)) in md.lines().zip(ts_md.lines()).enumerate() {
            if a != b {
                println!("  line {}:\n    ours:   {a}\n    theirs: {b}", i + 1);
                break;
            }
        }
        if md.lines().count() != ts_md.lines().count() {
            println!("  {} lines, TS {}", md.lines().count(), ts_md.lines().count());
        }
    }
    same == results.len() && md_same
}

fn ok(b: bool) -> &'static str {
    if b { "same" } else { "DIFF" }
}
