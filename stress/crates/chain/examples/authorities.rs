//! The block authors a chain has now: `Aura.Authorities` and `Session.Validators`, plus the best block.
//! `cargo run -p stress-chain --example authorities -- ws://127.0.0.1:10010`
use stress_chain::{Client, fetch};

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).expect("ws url");
    let client = Client::connect(&url).await.expect("connect");
    let at = client.finalized().await.expect("finalized");
    println!("finalized #{}", at.block_number());
    let aura: Option<Vec<[u8; 32]>> = fetch(&at, "Aura", "Authorities", ()).await.expect("Aura.Authorities");
    for (i, a) in aura.unwrap_or_default().iter().enumerate() {
        println!("Aura.Authorities[{i}] {}", hex::encode(a));
    }
    let validators: Option<Vec<[u8; 32]>> = fetch(&at, "Session", "Validators", ()).await.unwrap_or(None);
    for (i, v) in validators.unwrap_or_default().iter().enumerate() {
        println!("Session.Validators[{i}] {}", hex::encode(v));
    }
    let slot: Option<u64> = fetch(&at, "Aura", "CurrentSlot", ()).await.unwrap_or(None);
    let now: Option<u64> = fetch(&at, "Timestamp", "Now", ()).await.unwrap_or(None);
    println!("Aura.CurrentSlot {slot:?}, Timestamp.Now {now:?}");
}
