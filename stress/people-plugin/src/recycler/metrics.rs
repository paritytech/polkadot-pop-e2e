//! The Recycler metrics. They are recorded into this plugin's `series.jsonl` and declared in its
//! `metrics.json`, so Polkameter reads them with the run's series, labelled `job="plugin"`.

use polkameter_files::PluginMetric;
use polkameter_files::registry::{Def, Kind, Metric, kind};

const fn def(
	name: &'static str,
	kind: Kind,
	labels: &'static [&'static str],
	buckets: &'static [f64],
	help: &'static str,
) -> Def {
	Def { name, kind, help, labels, buckets, from: &[] }
}

/// Keys in the onboarding queue, by collection.
pub const RECYCLER_QUEUED: Metric<kind::Gauge, 1> = Metric::new(def(
	"people_recycler_queued_keys",
	Kind::Gauge,
	&["collection"],
	&[],
	"Keys in the onboarding queue, not yet in a ring (Members.OnboardingQueue).",
));
/// Keys in rings but not in a built root, by collection.
pub const RECYCLER_UNBUILT: Metric<kind::Gauge, 1> = Metric::new(def(
	"people_recycler_unbuilt_keys",
	Kind::Gauge,
	&["collection"],
	&[],
	"Keys in rings but not yet in a built root (Members.RingKeysStatus total minus included).",
));
/// Rings that need a build, by collection.
pub const RECYCLER_STALE: Metric<kind::Gauge, 1> = Metric::new(def(
	"people_recycler_stale_rings",
	Kind::Gauge,
	&["collection"],
	&[],
	"Rings that need a build (Members.StaleRings).",
));
/// Time from queueing a sampled key to a ring build that covers it.
pub const VOUCHER_IN_ROOT: Metric<kind::Histogram, 0> = Metric::new(def(
	"people_voucher_in_root_seconds",
	Kind::Histogram,
	&[],
	&[2.0, 4.0, 6.0, 9.0, 12.0, 18.0, 24.0, 36.0, 60.0, 120.0, 300.0, 600.0, 1200.0],
	"For a sample of keys queued in coinage/recycler collections: from queued_at in Members.Members until a ring build covers the key's position.",
));
/// Members and Coinage maintenance calls, by call and result.
pub const MAINTENANCE_CALLS: Metric<kind::Counter, 2> = Metric::new(def(
	"people_maintenance_calls_total",
	Kind::Counter,
	&["call", "result"],
	&[],
	"Members and Coinage *_authorized calls in People blocks, by call and result (success or failed).",
));
/// Cleanup work left, by kind.
pub const CLEANUP_BACKLOG: Metric<kind::Gauge, 1> = Metric::new(def(
	"people_cleanup_backlog",
	Kind::Gauge,
	&["kind"],
	&[],
	"Cleanup work left, by kind: ring_pages (Members.RingDeletionQueue), old_roots (Members.OldRoots), suspensions (Members.PendingSuspensions).",
));

/// The declarations for `metrics.json`.
pub fn declarations() -> Vec<PluginMetric> {
	[
		&RECYCLER_QUEUED.def,
		&RECYCLER_UNBUILT.def,
		&RECYCLER_STALE.def,
		&VOUCHER_IN_ROOT.def,
		&MAINTENANCE_CALLS.def,
		&CLEANUP_BACKLOG.def,
	]
	.into_iter()
	.map(PluginMetric::from)
	.collect()
}
