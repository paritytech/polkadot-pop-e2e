//! Criterion 4: the sender with a 20 ms send tick against a local mock RPC that answers every
//! `author_submitExtrinsic` after 1 ms and sends a WebSocket ping every 100 ms (the node pings
//! every 30 s; a sender that takes a ping for a close fails every run).
//! `cargo run --release -p stress-load --example sender_bench -- <rate> <seconds> <connections>`
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use stress_load::now_ms;
use stress_load::sender::{Reply, Sender};
use stress_load::submit::Submit;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

async fn mock_rpc(listener: TcpListener) {
    loop {
        let (tcp, _) = listener.accept().await.unwrap();
        tokio::spawn(async move {
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let (mut sink, mut stream) = ws.split();
            let mut ping = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = ping.tick() => { if sink.send(Message::Ping(vec![1].into())).await.is_err() { return } }
                    msg = stream.next() => {
                        let Some(Ok(Message::Text(text))) = msg else { if msg.is_none() { return } else { continue } };
                        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                        tokio::time::sleep(Duration::from_millis(1)).await;
                        let reply = format!(r#"{{"jsonrpc":"2.0","id":{},"result":"0x00"}}"#, v["id"]);
                        if sink.send(Message::text(reply)).await.is_err() { return }
                    }
                }
            }
        });
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<f64> = std::env::args().skip(1).map(|a| a.parse().unwrap()).collect();
    let (rate, seconds, connections) = (args[0], args[1], args[2] as usize);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(mock_rpc(listener));
    let (replies_tx, mut replies) = tokio::sync::mpsc::unbounded_channel();
    let mut sender = Sender::open(&url, connections, replies_tx).await.unwrap();
    let tx = vec![0x5a_u8; 858]; // a claim's size
    let (mut id, mut tokens, mut sent, mut answered, mut backed_up, mut closed) = (0u64, 0.0, 0u64, 0u64, 0u64, 0u64);
    let mut sent_at = std::collections::HashMap::new();
    let mut reply_ms = Vec::new();
    let start = now_ms();
    let mut last = start;
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    while ((now_ms() - start) as f64) < seconds * 1000.0 {
        tokio::select! {
            _ = tick.tick() => {
                let now = now_ms();
                tokens = (tokens + rate * (now - last) as f64 / 1000.0).min(rate);
                last = now;
                while tokens >= 1.0 {
                    id += 1;
                    if sender.submit(id, &tx).is_none() { backed_up += 1; tokens = 0.0; break }
                    sent_at.insert(id, now);
                    sent += 1;
                    tokens -= 1.0;
                }
            }
            Some(r) = replies.recv() => match r {
                Reply::Accepted { id, at } => { answered += 1; if let Some(t) = sent_at.remove(&id) { reply_ms.push(at - t) } }
                Reply::Closed { .. } => closed += 1,
                Reply::Refused { .. } => {}
            }
        }
    }
    reply_ms.sort_unstable();
    let p95 = reply_ms.get(reply_ms.len() * 95 / 100).copied().unwrap_or(0);
    println!("target {rate} tx/s on {connections} connections for {seconds} s: sent {:.1} tx/s ({:.1}%), answered {answered}, backed-up ticks {backed_up}, closed {closed}, reply p95 {p95} ms", sent as f64 / seconds, 100.0 * sent as f64 / (rate * seconds));
}
