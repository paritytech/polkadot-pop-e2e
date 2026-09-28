//! `RunData`: window math over `run.om`.
//!
//! Values at a time: node series are scraped, so a step edge takes the first scrape at or after
//! the edge (the edge scrape lands a few ms after it). Our own series only change on events, so
//! they take the last value at or before the time, or 0.

use stress_files::summary::Summary;
use stress_files::{Series, Store};

/// Label filter: every pair must match.
pub type Filter<'a> = &'a [(&'a str, &'a str)];

/// A time window of the run, in ms.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    /// Start.
    pub start: f64,
    /// End.
    pub end: f64,
    /// "step 3" or "recovery", for check details.
    pub label: String,
}

/// A counter went down in a window: a node restarted, so that window has no result.
#[derive(Debug, Clone)]
pub struct CounterReset(pub String);

impl std::error::Error for CounterReset {}

impl std::fmt::Display for CounterReset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn value_at(s: &Series, t: f64) -> f64 {
    let scraped = s.labels.get("job").is_none_or(|j| j != "stress");
    let p = if scraped {
        s.points.iter().find(|p| p.t >= t).or(s.points.last())
    } else {
        s.points.iter().rev().find(|p| p.t <= t)
    };
    p.map_or(0.0, |p| p.value)
}

/// Histogram buckets over a window: (upper bound, count), ascending, `+Inf` last.
pub type Buckets = Vec<(f64, f64)>;

/// A finished run: `run.om` plus what the load tool knew.
#[derive(Debug)]
pub struct RunData {
    store: Store,
    /// summary.json without the checks.
    pub summary: Summary,
    /// People's block interval before the run.
    pub block_interval_s: f64,
}

impl RunData {
    /// From a parsed `run.om` and summary.
    pub fn new(store: Store, summary: Summary) -> Self {
        let block_interval_s = summary.network.block_interval_s;
        Self { store, summary, block_interval_s }
    }

    /// Series of `name` whose labels match.
    pub fn series(&self, name: &str, filter: Filter<'_>) -> Vec<&Series> {
        let matches = |s: &&Series| filter.iter().all(|(k, v)| s.labels.get(*k).is_some_and(|x| x == v));
        self.store.get(name).into_iter().flatten().filter(matches).collect()
    }

    /// True when some series matches.
    pub fn has(&self, name: &str, filter: Filter<'_>) -> bool {
        !self.series(name, filter).is_empty()
    }

    /// The value at `t`, summed over matching series; `None` when none matches.
    pub fn at(&self, name: &str, filter: Filter<'_>, t: f64) -> Option<f64> {
        let list = self.series(name, filter);
        (!list.is_empty()).then(|| list.iter().map(|s| value_at(s, t)).sum())
    }

    /// A counter's increase over `w`, summed over matching series.
    pub fn diff(&self, name: &str, filter: Filter<'_>, w: &Window) -> Result<Option<f64>, CounterReset> {
        let mut sum = None;
        for s in self.series(name, filter) {
            let (a, b) = (value_at(s, w.start), value_at(s, w.end));
            if b < a {
                return Err(CounterReset(format!("{name} went down from {a} to {b}")));
            }
            *sum.get_or_insert(0.0) += b - a;
        }
        Ok(sum)
    }

    /// A histogram's bucket increases over `w`, summed over matching series.
    pub fn buckets(&self, name: &str, filter: Filter<'_>, w: &Window) -> Result<Option<Buckets>, CounterReset> {
        let mut out: Buckets = Vec::new();
        for s in self.series(&format!("{name}_bucket"), filter) {
            let le = match s.labels.get("le").map(String::as_str) {
                Some("+Inf") => f64::INFINITY,
                Some(le) => le.parse().unwrap_or(f64::NAN),
                None => continue,
            };
            let (a, b) = (value_at(s, w.start), value_at(s, w.end));
            if b < a {
                return Err(CounterReset(format!("{name} went down from {a} to {b}")));
            }
            match out.iter_mut().find(|(x, _)| *x == le) {
                Some((_, n)) => *n += b - a,
                None => out.push((le, b - a)),
            }
        }
        out.sort_by(|a, b| a.0.total_cmp(&b.0));
        Ok((!out.is_empty()).then_some(out))
    }

    /// The ramp steps, from the `stress_step` gauge.
    pub fn steps(&self) -> Vec<Window> {
        let Some(s) = self.series("stress_step", &[]).first().copied() else { return Vec::new() };
        let p = &s.points;
        (0..p.len())
            .filter(|&i| p[i].value >= 0.0)
            .map(|i| Window { start: p[i].t, end: p.get(i + 1).map_or(p[i].t, |n| n.t), label: format!("step {}", p[i].value) })
            .collect()
    }

    /// The steps, then recovery: after a burst (one short step) the load lands there.
    pub fn load_windows(&self) -> Vec<Window> {
        let mut w = self.steps();
        w.extend(self.phase("recovery").map(|r| Window { label: "recovery".into(), ..r }));
        w
    }

    /// The window of a phase (baseline, ramp, recovery, done), from the `stress_phase` gauge.
    pub fn phase(&self, name: &str) -> Option<Window> {
        let s = *self.series("stress_phase", &[("phase", name)]).first()?;
        let on = s.points.iter().position(|p| p.value == 1.0)?;
        let end = s.points[on + 1..].iter().find(|p| p.value == 0.0).or(s.points.last())?;
        Some(Window { start: s.points[on].t, end: end.t, label: name.into() })
    }

    /// The whole run: first to last sample of `stress_phase`.
    pub fn run(&self) -> Window {
        let ts = self.series("stress_phase", &[]).into_iter().flat_map(|s| s.points.iter().map(|p| p.t));
        let (start, end) = ts.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), t| (a.min(t), b.max(t)));
        Window { start, end, label: "run".into() }
    }

    /// A gauge's lowest and highest value in `w`, summed over matching series (each series'
    /// own extremes; one without a sample inside takes its value at the start).
    pub fn gauge_range(&self, name: &str, filter: Filter<'_>, w: &Window) -> Option<(f64, f64)> {
        let list = self.series(name, filter);
        if list.is_empty() {
            return None;
        }
        let (mut min, mut max) = (0.0, 0.0);
        for s in list {
            let inside: Vec<f64> = s.points.iter().filter(|p| p.t >= w.start && p.t <= w.end).map(|p| p.value).collect();
            let values = if inside.is_empty() { vec![value_at(s, w.start)] } else { inside };
            min += values.iter().copied().fold(f64::INFINITY, f64::min);
            max += values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        }
        Some((min, max))
    }

    /// Every sample time of `name`, whatever the labels.
    pub fn times(&self, name: &str) -> Vec<f64> {
        self.series(name, &[]).into_iter().flat_map(|s| s.points.iter().map(|p| p.t)).collect()
    }
}

/// The bucket bound below which a share `q` of the counts fall; `None` with no counts.
pub fn quantile(b: Option<&Buckets>, q: f64) -> Option<f64> {
    let b = b?;
    let total = b.iter().find(|(le, _)| le.is_infinite()).map_or_else(|| b.iter().map(|x| x.1).fold(0.0, f64::max), |x| x.1);
    if total == 0.0 {
        return None;
    }
    Some(b.iter().find(|(_, n)| *n >= q * total).map_or(f64::INFINITY, |x| x.0))
}

/// Counts above `bound` (one of the buckets).
pub fn count_above(b: Option<&Buckets>, bound: f64) -> Option<f64> {
    let b = b?;
    let get = |x: f64| b.iter().find(|(le, _)| *le == x).map_or(0.0, |x| x.1);
    Some(get(f64::INFINITY) - get(bound))
}
