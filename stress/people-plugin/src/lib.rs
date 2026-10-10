//! People workload for Polkameter: recognition, ring-proof claims and their encoding, and the
//! Recycler observer. `main.rs` exposes them as plugin operations.

use polkameter_chain::{AtBlock, ChainError, fetch};

pub mod recycler;
/// Parts more than one scenario uses: our people, and the built rings.
pub mod shared {
	pub mod people;
	pub mod rings;
}
/// Statement-store claims.
pub mod stmt {
	pub mod claim;
}
pub mod tx;

/// The block's time in ms (`Timestamp.Now`); an error when the runtime has none.
pub async fn block_time(at: &AtBlock) -> Result<u64, ChainError> {
	fetch::<(), u64>(at, "Timestamp", "Now", ())
		.await?
		.ok_or_else(|| ChainError::Read { what: "Timestamp.Now", detail: "missing".into() })
}
