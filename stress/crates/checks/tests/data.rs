//! Window math and one check on a small hand-written run.om.

use stress_checks::{RunData, Status, count_above, quantile};
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
    assert_eq!(count_above(Some(&b), 2.5), Some(4.0));
}

#[test]
fn build_time_fails_when_most_blocks_take_over_2_5_s() {
    let d = RunData::new(parse_run_om(RUN_OM), summary());
    let results = stress_checks::run(&stress_checks::all(), &d);
    let build = results.iter().find(|r| r.check == "build time within the authoring deadline").unwrap();
    assert_eq!(build.verdict.status, Status::Fail, "{}", build.verdict.detail);
    assert!(build.verdict.detail.starts_with("step 1: 4 of 5 blocks took over 2.5 s"));
}
