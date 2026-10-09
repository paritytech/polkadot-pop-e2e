//! The machine the load tool runs on, for the summary: CPUs, CPU model, memory.

use std::process::Command;

use stress_files::summary::Runner;

fn sysctl(key: &str) -> Option<String> {
    let out = Command::new("sysctl").args(["-n", key]).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn proc_field(path: &str, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().find(|l| l.starts_with(key))?;
    Some(line.split_once(':')?.1.trim().to_owned())
}

/// This machine. `cpus` respects a cpuset (the CI pins the load tool to a share of the runner);
/// `machine_cpus` does not: /proc/cpuinfo lists every CPU.
pub fn runner() -> Runner {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    let (machine_cpus, cpu_model, mem_bytes) = if cfg!(target_os = "macos") {
        (sysctl("hw.ncpu").and_then(|s| s.parse::<usize>().ok()), sysctl("machdep.cpu.brand_string"), sysctl("hw.memsize").and_then(|s| s.parse::<u64>().ok()))
    } else {
        let kib = proc_field("/proc/meminfo", "MemTotal").and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok());
        let listed = std::fs::read_to_string("/proc/cpuinfo").ok().map(|t| t.lines().filter(|l| l.starts_with("processor")).count()).filter(|n| *n > 0);
        (listed, proc_field("/proc/cpuinfo", "model name"), kib.map(|k| k * 1024))
    };
    Runner { cpus, machine_cpus, cpu_model, mem_gi_b: mem_bytes.map_or(0, |b| (b as f64 / f64::from(1u32 << 30)).round() as u64) }
}
