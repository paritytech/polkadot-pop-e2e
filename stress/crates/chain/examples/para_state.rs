//! What the relay knows about a para: its head, and whether a code upgrade is pending.
//! `cargo run -p stress-chain --example para_state -- ws://127.0.0.1:10000 1502`
use stress_chain::{Client, Value, fetch};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (url, para): (&str, u32) = (&args[1], args[2].parse().expect("para id"));
    let client = Client::connect(url).await.expect("connect");
    let at = client.finalized().await.expect("finalized");
    println!("relay finalized #{}", at.block_number());
    let head: Option<Vec<u8>> = fetch(&at, "Paras", "Heads", (para,)).await.expect("Paras.Heads");
    if let Some(h) = &head {
        let mut n = &h[32..];
        let number = <parity_scale_codec::Compact<u32> as parity_scale_codec::Decode>::decode(&mut n).map(|c| c.0).unwrap_or(0);
        println!("Paras.Heads({para}): {} bytes, parent 0x{}, number #{number}", h.len(), hex::encode(&h[..32]));
    } else {
        println!("Paras.Heads({para}): none");
    }
    for entry in ["FutureCodeHash", "UpgradeGoAheadSignal", "UpgradeRestrictionSignal", "FutureCodeUpgrades", "PvfActiveVoteMap"] {
        let v: Result<Option<Value>, _> = fetch(&at, "Paras", entry, (para,)).await;
        println!("Paras.{entry}({para}): {:?}", v.map(|v| v.map(|v| v.to_string())));
    }
    let lifecycle: Option<Value> = fetch(&at, "Paras", "ParaLifecycles", (para,)).await.expect("lifecycle");
    println!("Paras.ParaLifecycles({para}): {:?}", lifecycle.map(|v| v.to_string()));
}
