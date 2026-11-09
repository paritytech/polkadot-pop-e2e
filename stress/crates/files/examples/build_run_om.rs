//! Spike C: `cargo run --release -p stress-files --example build_run_om -- <run dir> <out dir>`.
//! Copies nothing: reads the raw files of <run dir>, writes run.om into <out dir>.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = stress_files::RunDir::open(std::path::Path::new(&args[1]));
    let t = std::time::Instant::now();
    let text = stress_files::build_run_om(&src).expect("build");
    std::fs::write(std::path::Path::new(&args[2]).join("run.om"), &text).expect("write");
    eprintln!("run.om: {} lines in {:.2} s", text.lines().count(), t.elapsed().as_secs_f64());
}
