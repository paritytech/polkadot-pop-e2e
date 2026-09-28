//! Spike B: proving throughput for a stmt flood on a full People ring (255 keys, R2e9).
//! `cargo run --release -p stress-proofs --example bench -- <members> <slots>`
use std::time::Instant;
use stress_proofs::{Job, Prover, ProverPool, member_key};

fn main() {
    let args: Vec<usize> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let (members, slots) = (args[0], args[1]);
    let entropy = |i: usize| {
        let mut e = [7u8; 32];
        e[..8].copy_from_slice(&(i as u64).to_le_bytes());
        e
    };
    let ring: Vec<_> = (0..255).map(|i| member_key(entropy(i))).collect();
    let prover = Prover::new(9, ring).unwrap();
    let threads = std::env::var("THREADS").ok().map(|t| t.parse().unwrap());
    let pool = ProverPool::new(threads);
    println!("threads {}", pool.threads());

    let t = Instant::now();
    let entropies: Vec<_> = (0..members).map(entropy).collect();
    let opened = pool.open_all(&prover, &entropies).unwrap();
    let open_s = t.elapsed().as_secs_f64();
    println!("open {members} members: {open_s:.1} s ({:.0} ms each on one thread)", open_s * 1000.0 * pool.threads() as f64 / members as f64);

    let jobs: Vec<Job> = (0..slots).flat_map(|seq| (0..members).map(move |m| Job { member: m, context: vec![seq as u8; 32], message: [m as u8; 32] })).collect();
    let t = Instant::now();
    let proofs = pool.prove_all(&opened, &jobs).unwrap();
    let s = t.elapsed().as_secs_f64();
    println!("prove {} claims: {s:.1} s = {:.1} proofs/s", proofs.len(), proofs.len() as f64 / s);
    let total = open_s + s;
    println!("total {:.1} s for {} claims = {:.1}/s; TS: 659 s for 15000 = 22.8/s", total, proofs.len(), proofs.len() as f64 / total);
}
