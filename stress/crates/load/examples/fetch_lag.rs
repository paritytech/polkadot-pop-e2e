//! How long after a head arrives is the block read? `cargo run --release -p stress-load --example fetch_lag`
use stress_load::follower::{self, BlockEvent};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let client = stress_chain::Client::connect("ws://127.0.0.1:10010").await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    follower::start(client.clone(), client.normal_limit().await.unwrap(), tx, CancellationToken::new());
    let mut n = 0;
    while let Some(e) = rx.recv().await {
        if let BlockEvent::Fetched { record, .. } = e {
            println!("block {}: fetched {} ms after its head", record.number, stress_load::now_ms() - record.seen_at);
            n += 1;
            if n == 8 { break }
        }
    }
}
