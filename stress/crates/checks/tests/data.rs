//! Window math and one check on a small hand-written run.om.

use stress_checks::{RunData, Status, count_above, quantile, quantile_bucket};
use stress_files::parse_run_om;
use stress_files::summary::Summary;

const RUN_OM: &str = r#"# TYPE stress_step gauge
stress_step{instance="load-tool",job="stress"} 0 100.000
stress_step{instance="load-tool",job="stress"} 1 110.000
stress_step{instance="load-tool",job="stress"} -1 120.000
# TYPE substrate_proposer_block_constructed histogram
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="1.0"} 0 100.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="2.5"} 0 100.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="+Inf"} 0 100.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="1.0"} 5 110.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="2.5"} 5 110.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="+Inf"} 5 110.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="1.0"} 5 120.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="2.5"} 6 120.001
substrate_proposer_block_constructed_bucket{instance="c",job="people-collator",le="+Inf"} 10 120.001
# EOF
"#;

fn summary() -> Summary {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/summary.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn steps_and_buckets() {
    let d = RunData::new(parse_run_om(RUN_OM), summary());
    let steps = d.steps();
    assert_eq!(steps.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), ["step 0", "step 1"]);
    let b = d.buckets("substrate_proposer_block_constructed", &[("job", "people-collator")], &steps[1]).unwrap().unwrap();
    assert_eq!(b, vec![(1.0, 0.0), (2.5, 1.0), (f64::INFINITY, 5.0)]);
    assert_eq!(quantile(Some(&b), 0.95), Some(f64::INFINITY));
    assert_eq!(quantile_bucket(Some(&b), 0.95), Some((2.5, f64::INFINITY)));
    assert_eq!(quantile_bucket(Some(&b), 0.1), Some((1.0, 2.5)));
    assert_eq!(quantile_bucket(Some(&vec![(1.0, 5.0), (f64::INFINITY, 5.0)]), 0.95), Some((0.0, 1.0)));
    assert_eq!(count_above(Some(&b), 2.5), Some(4.0));
}

#[test]
fn pool_work_names_the_bucket_the_maintenance_p95_is_in() {
    // Step 0's 191 runs as run 37800300053 had them: 93.2% within 1.25 s, 97.4% within 1.5 s.
    let run_om = r#"# TYPE stress_step gauge
stress_step{instance="load-tool",job="stress"} 0 100.000
stress_step{instance="load-tool",job="stress"} -1 110.000
# TYPE substrate_sub_txpool_maintain_duration_seconds histogram
substrate_sub_txpool_maintain_duration_seconds_bucket{instance="c",job="people-collator",le="1.25"} 0 100.001
substrate_sub_txpool_maintain_duration_seconds_bucket{instance="c",job="people-collator",le="1.5"} 0 100.001
substrate_sub_txpool_maintain_duration_seconds_bucket{instance="c",job="people-collator",le="+Inf"} 0 100.001
substrate_sub_txpool_maintain_duration_seconds_bucket{instance="c",job="people-collator",le="1.25"} 178 110.001
substrate_sub_txpool_maintain_duration_seconds_bucket{instance="c",job="people-collator",le="1.5"} 186 110.001
substrate_sub_txpool_maintain_duration_seconds_bucket{instance="c",job="people-collator",le="+Inf"} 191 110.001
# EOF
"#;
    let d = RunData::new(parse_run_om(run_om), summary());
    let results = stress_checks::run(&stress_checks::all(), &d);
    let work = results.iter().find(|r| r.check == "pool work leaves time for blocks").unwrap();
    assert_eq!(work.verdict.status, Status::Fail);
    assert_eq!(
        work.verdict.detail,
        "step 0: pool maintenance after each new block took between 1.25 and 1.5 s (p95); the threshold is 1.0 s, 50% of the block interval at the start (2 s)"
    );
}

#[test]
fn end_reasons_count_each_block_once_over_collators() {
    let run_om = r#"# TYPE stress_step gauge
stress_step{instance="load-tool",job="stress"} 0 100.000
stress_step{instance="load-tool",job="stress"} -1 110.000
# TYPE substrate_proposer_end_proposal_reason counter
substrate_proposer_end_proposal_reason{instance="a",job="people-collator",reason="no_more_transactions"} 1 100.001
substrate_proposer_end_proposal_reason{instance="b",job="people-collator",reason="no_more_transactions"} 2 100.001
substrate_proposer_end_proposal_reason{instance="b",job="people-collator",reason="hit_deadline"} 0 100.001
substrate_proposer_end_proposal_reason{instance="a",job="people-collator",reason="no_more_transactions"} 4 110.001
substrate_proposer_end_proposal_reason{instance="b",job="people-collator",reason="no_more_transactions"} 4 110.001
substrate_proposer_end_proposal_reason{instance="b",job="people-collator",reason="hit_deadline"} 1 110.001
substrate_proposer_end_proposal_reason{instance="a",job="people-collator",reason="hit_block_weight_limit"} 2 110.001
# EOF
"#;
    let d = RunData::new(parse_run_om(run_om), summary());
    let mut reasons = d.end_reasons(&d.steps()[0]).unwrap();
    reasons.sort_by(|a, b| a.0.cmp(&b.0));
    // weight: a's series first appears at the end scrape, after a was scraped without it: 0 -> 2.
    assert_eq!(reasons, vec![("deadline".to_owned(), 1.0), ("empty".to_owned(), 5.0), ("weight".to_owned(), 2.0)]);
}

#[test]
fn build_time_fails_when_most_blocks_take_over_2_5_s() {
    let d = RunData::new(parse_run_om(RUN_OM), summary());
    let results = stress_checks::run(&stress_checks::all(), &d);
    let build = results.iter().find(|r| r.check == "build time within the authoring deadline").unwrap();
    assert_eq!(build.verdict.status, Status::Fail, "{}", build.verdict.detail);
    assert!(build.verdict.detail.starts_with("step 1: 4 of 5 blocks took over 2.5 s"));
}
