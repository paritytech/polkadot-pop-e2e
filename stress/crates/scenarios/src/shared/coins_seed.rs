//! Seeds coins with `Sudo.sudo(System.set_storage { items })`, 2,000 items per tx (TS
//! `seed-coins.ts`). Stub: the storage key and the 7-byte Coin value are not ported yet.

use stress_chain::{ChainInfo, Client};
use stress_load::SetupError;

use super::coins::Coin;

/// Seeds `count` coins for this run.
pub async fn seed(_client: &Client, _chain: &ChainInfo, _seed: &[u8; 32], count: u32) -> Result<Vec<Coin>, SetupError> {
    Err(SetupError::Scenario { what: "seed coins", detail: format!("not ported yet ({count} coins asked)") })
}
