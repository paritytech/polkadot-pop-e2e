//! Setup txs as a dev account (`//Alice` is sudo on our networks): v5 general txs with
//! `VerifySignature::Signed`, consecutive nonces, each followed to a best block.

use std::time::Duration;

use subxt_signer::sr25519::Keypair;

use crate::client::{ChainError, Client};
use crate::reads::events;
use crate::tx::{ChainInfo, Ext, GeneralTx, tx_hash};

/// The dev signer, `//Alice` unless `SUDO_URI` names another.
pub fn dev_signer() -> Keypair {
    match std::env::var("SUDO_URI").ok().as_deref() {
        None | Some("//Alice") => subxt_signer::sr25519::dev::alice(),
        Some(uri) => Keypair::from_uri(&uri.parse().expect("SUDO_URI is a secret URI")).expect("SUDO_URI derives"),
    }
}

/// `call` signed by `signer` with `nonce`.
pub fn signed(chain: &ChainInfo, signer: &Keypair, nonce: u32, call: Vec<u8>) -> Vec<u8> {
    sign(GeneralTx::new(chain, call).nonce(nonce), signer)
}

/// Signs a general tx with `VerifySignature::Signed` (coin transfers use it with `AsCoinage`).
pub fn sign(tx: GeneralTx<'_>, signer: &Keypair) -> Vec<u8> {
    let signature = signer.sign(&tx.message_after(Ext::VerifyMultiSignature));
    // VerifySignature::Signed(MultiSignature::Sr25519(signature), account)
    let verify = [&[1u8, 1][..], &signature.0, &signer.public_key().0].concat();
    tx.with(Ext::VerifyMultiSignature, verify).encode()
}

/// Sends every call as `Sudo.sudo(call)` from `signer` with consecutive nonces, and waits until
/// each is in a best block with `Sudid(Ok)`. One block subscription, opened before the first
/// submit, so a tx that lands early is not missed.
pub async fn sudo_all(client: &Client, chain: &ChainInfo, signer: &Keypair, calls: &[Vec<u8>], what: &str) -> Result<(), ChainError> {
    let mut blocks = client.api().stream_best_blocks().await.map_err(|e| ChainError::Read { what: "best blocks", detail: e.to_string() })?;
    let mut nonce = client.nonce(signer.public_key().0).await?;
    let mut pending = std::collections::HashSet::new();
    for call in calls {
        let tx = signed(chain, signer, nonce, client.sudo(call).await?);
        client.validate(&tx, what).await?;
        client.submit(&tx).await?;
        pending.insert(tx_hash(&tx));
        nonce += 1;
    }
    let timeout = Duration::from_secs(120 + 6 * calls.len() as u64);
    let work = async {
        while !pending.is_empty() {
            let Some(block) = blocks.next().await else { return Err(ChainError::Read { what: "best blocks", detail: "stream ended".into() }) };
            let hash = block.map_err(|e| ChainError::Read { what: "best block", detail: e.to_string() })?.hash().0;
            let ours: Vec<u32> = client.body(hash).await?.iter().enumerate().filter(|(_, x)| pending.remove(&tx_hash(x))).map(|(i, _)| i as u32).collect();
            if ours.is_empty() {
                continue;
            }
            let events = events(&client.at(hash).await?).await?;
            for i in ours {
                let sudid = events.iter().find(|e| e.0 == "Sudo" && e.1 == "Sudid" && e.2 == Some(i));
                if !sudid.is_some_and(|e| e.3.to_string().contains("Ok")) {
                    return Err(ChainError::Read { what: "sudo result", detail: format!("{what}: extrinsic {i}: {:?}", sudid.map(|e| e.3.to_string())) });
                }
            }
        }
        Ok(())
    };
    tokio::time::timeout(timeout, work).await.map_err(|_| ChainError::Timeout(format!("{what}: not all in a best block after {timeout:?}")))?
}
