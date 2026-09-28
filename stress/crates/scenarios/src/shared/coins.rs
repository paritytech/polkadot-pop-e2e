//! Coins as a load source: one pool tx per coin (the runtime gives each coin one provides tag),
//! two keys per coin so a transfer goes A -> B, then B -> A (the destination must hold no coin).
//! A coin is idle again when its tx is in a best block (the owner flips), refused (same owner),
//! or not in a block by the end of its mortality (same owner). Retired at age 16.

use std::collections::HashMap;

use stress_chain::{ChainInfo, Era, Ext, GeneralTx, Keypair, setup::sign};
use stress_load::{Block, LoadSource, Settled, Tx, TxHash};

/// Coinage pallet index and `transfer` call index (runtime `lib.rs`).
const COINAGE_TRANSFER: [u8; 2] = [0x44, 0x01];
/// Mortality of a coin tx: 16 blocks.
const ERA_PERIOD: u64 = 16;
/// `MaximumAge` of a coin.
const MAX_AGE: u32 = 16;

/// One coin and its two keys.
pub struct Coin {
    /// The two keys; `owner` indexes them.
    pub keys: [Keypair; 2],
    /// Which key holds it now.
    pub owner: usize,
    /// Transfers so far.
    pub age: u32,
}

struct InFlight {
    coin: usize,
    last_block: u32,
}

/// The coin source.
pub struct CoinSource {
    chain: ChainInfo,
    coins: Vec<Coin>,
    idle: Vec<usize>,
    in_flight: HashMap<TxHash, InFlight>,
    checkpoint: Option<Block>,
    probes: usize,
}

impl CoinSource {
    /// Coins seeded ahead (sudo `System.set_storage`); the last `probes` are kept for probes.
    pub fn new(chain: ChainInfo, coins: Vec<Coin>, probes: usize) -> Self {
        let idle = (probes..coins.len()).rev().collect();
        Self { chain, coins, idle, in_flight: HashMap::new(), checkpoint: None, probes }
    }

    fn transfer(&mut self, coin: usize) -> Option<Tx> {
        let cp = self.checkpoint?;
        let c = &self.coins[coin];
        let to = c.keys[1 - c.owner].public_key().0;
        let call = [&COINAGE_TRANSFER[..], &to].concat();
        let era = Era::Mortal { period: ERA_PERIOD, birth: u64::from(cp.number), birth_hash: cp.hash };
        let tx = GeneralTx::new(&self.chain, call).with(Ext::AsCoinage, vec![1, 0]).era(era);
        let tx = Tx::new(sign(tx, &c.keys[c.owner]));
        self.in_flight.insert(tx.hash, InFlight { coin, last_block: cp.number + ERA_PERIOD as u32 - 1 });
        Some(tx)
    }
}

impl LoadSource for CoinSource {
    fn next(&mut self) -> Option<Tx> {
        self.checkpoint?;
        let coin = self.idle.pop()?;
        self.transfer(coin)
    }

    fn probe(&mut self) -> Option<Tx> {
        let coin = (0..self.probes).find(|c| self.coins[*c].age < MAX_AGE && !self.in_flight.values().any(|f| f.coin == *c))?;
        self.transfer(coin)
    }

    fn exhausted(&self) -> bool {
        self.idle.is_empty() && self.in_flight.is_empty()
    }

    fn starved_reason(&self) -> String {
        format!("no idle coin ({} in flight, {} retired)", self.in_flight.len(), self.coins.iter().filter(|c| c.age >= MAX_AGE).count())
    }

    fn settled(&mut self, hash: &TxHash, how: Settled) {
        let Some(f) = self.in_flight.remove(hash) else { return };
        let c = &mut self.coins[f.coin];
        if how == (Settled::Included { failed: false }) {
            c.owner = 1 - c.owner;
            c.age += 1;
        }
        if f.coin >= self.probes && c.age < MAX_AGE {
            self.idle.push(f.coin);
        }
    }

    fn on_head(&mut self, block: Block) {
        self.checkpoint = Some(block); // born at the newest block, so the whole era is left
    }

    fn on_block(&mut self, block: Block) -> Vec<TxHash> {
        let expired: Vec<TxHash> = self.in_flight.iter().filter(|(_, f)| block.number > f.last_block + 2).map(|(h, _)| *h).collect();
        for h in &expired {
            self.settled(h, Settled::Dropped);
        }
        expired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(coins: usize) -> CoinSource {
        let chain = ChainInfo { spec_version: 1, tx_version: 1, genesis: [0; 32] };
        let coins = (0..coins).map(|i| Coin { keys: [Keypair::from_secret_key([i as u8 + 1; 32]).unwrap(), Keypair::from_secret_key([i as u8 + 100; 32]).unwrap()], owner: 0, age: 0 }).collect();
        CoinSource::new(chain, coins, 0)
    }

    #[test]
    fn a_coin_has_one_tx_in_flight_and_flips_owner_when_included() {
        let mut s = source(1);
        assert!(s.next().is_none(), "no checkpoint yet");
        s.on_head(Block { number: 10, hash: [1; 32] });
        let tx = s.next().unwrap();
        assert!(s.next().is_none(), "the only coin is in flight");
        s.settled(&tx.hash, Settled::Included { failed: false });
        assert_eq!((s.coins[0].owner, s.coins[0].age), (1, 1));
        assert!(s.next().is_some(), "idle again, sent by the other key");
    }

    #[test]
    fn a_tx_expires_after_its_mortality_and_the_coin_is_idle_with_the_same_owner() {
        let mut s = source(1);
        s.on_head(Block { number: 10, hash: [1; 32] });
        let tx = s.next().unwrap();
        assert!(s.on_block(Block { number: 27, hash: [2; 32] }).is_empty(), "within 16 + 2 blocks");
        assert_eq!(s.on_block(Block { number: 28, hash: [3; 32] }), vec![tx.hash]);
        assert_eq!(s.coins[0].owner, 0);
        assert!(s.next().is_some());
    }
}
