#!/usr/bin/env python3
"""Diff current ring-health state against previous, emit GitHub-actions
outputs and a matrix message body when the verdict has changed.

Usage:
    python3 diff-ring-health.py --prev prev.json --curr curr.json \
        --run-url https://github.com/.../actions/runs/12345

Outputs (when invoked under GitHub Actions, `$GITHUB_OUTPUT` is set):
    state_changed=true|false    # transitioned PASS↔FAIL since last run
    verdict=pass|fail           # the current verdict
    matrix_message=<...>        # rich message body (multiline)

When state did not change, `matrix_message` is empty and the workflow
should skip the matrix step. The PASS→FAIL and FAIL→PASS transitions
both produce a message — recoveries are useful to see, not just regressions.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


# Map a free-form ring-health failure message to a stable category slug.
# We compare CATEGORIES rather than raw error strings between runs because
# the numbers inside the message (queue size, block-delta, latency) drift
# every run even when the underlying failure mode is identical — comparing
# raw strings would flap on every tick. Verdict change still always
# notifies; category change additionally surfaces "failing for a *different*
# reason than last run" (e.g. builder went from "completely stuck" to
# "running but slow") which the prior verdict-only diff missed.
#
# Keep this list in sync with the `throw new Error(...)` sites in
# tests/probes/ring-health.test.ts. A category that doesn't match anything
# falls into "other" — which is still distinct from the empty-error
# "no failures" baseline, so a brand-new failure mode still flips.
_ERROR_CATEGORIES: list[tuple[str, re.Pattern[str]]] = [
    ("builder-stuck", re.compile(r"Builder appears stuck|zero RingBuilt events across", re.I)),
    ("stale-onboarded", re.compile(r"Onboarded event\(s\) with no matching RingBuilt", re.I)),
    ("slow-rebuilds", re.compile(r"worst submit.*rebuild latency was", re.I)),
    ("ah-lag", re.compile(r"AssetHub is \d+ revision\(s\) behind", re.I)),
    ("ah-no-root", re.compile(r"AH RingRoots window is empty|never propagated to AssetHub", re.I)),
]


def categorise(message: str) -> str:
    for cat, pat in _ERROR_CATEGORIES:
        if pat.search(message):
            return cat
    return "other"


# Pass→fail flips require this many consecutive observed fails before we
# notify the room. A single transient RPC flake on a load-balanced public
# endpoint shouldn't ping anyone — the probe self-retries once inside the
# test, but if even that fails we want a second sample before treating it
# as real. Recoveries (fail→pass) always notify on the first observation;
# silence after a flake-driven false-alarm would mask the real recovery.
FLIP_TO_FAIL_THRESHOLD = 2


def categories_of(state: dict | None) -> set[str]:
    if not state:
        return set()
    return {categorise(e) for e in state.get("errors", []) if isinstance(e, str)}


def fmt_litepeople_metrics(metrics: dict) -> list[str]:
    """Build the human-readable lines describing the current LitePeople state."""
    lp = metrics.get("LitePeople", {})
    if not lp:
        return ["LitePeople: no metrics emitted (probe didn't run or output unparseable)"]
    lines = []
    rev = lp.get("people_rev", "?")
    ah = lp.get("ah_max_rev", "?")
    delta = lp.get("delta_rev", "?")
    budget = lp.get("budget_revs", lp.get("budget_blocks", "?"))
    lines.append(
        f"AH catch-up: People rev={rev}, AH max rev={ah}, delta={delta} (budget {budget} rev)"
    )
    onboarded = lp.get("onboarded", lp.get("onboarded_in_window", "?"))
    rebuilt = lp.get("rebuilt", lp.get("rebuilt_in_window", "?"))
    p50 = lp.get("p50_blocks", "?")
    p95 = lp.get("p95_blocks", "?")
    maxb = lp.get("max_blocks", "?")
    window = lp.get("window_blocks", "?")
    lines.append(
        f"Rebuild latency over last {window} blocks: onboarded={onboarded} rebuilt={rebuilt} "
        f"p50={p50}b p95={p95}b max={maxb}b"
    )
    queue = lp.get("queue_now")
    ring = lp.get("ring_now")
    rev_now = lp.get("rev_now")
    if queue is not None or ring is not None or rev_now is not None:
        lines.append(
            f"Current snapshot: queue={queue or '?'} ring_size={ring or '?'} rev={rev_now or '?'}"
        )
    return lines


def build_message(
    state: dict,
    prev: dict | None,
    run_url: str,
    pr_context: str = "",
) -> str:
    verdict = state.get("verdict", "?")
    prev_verdict = prev.get("verdict") if prev else None
    network = state.get("network", "?")
    metrics = state.get("metrics", {})
    errors = state.get("errors", [])

    prev_cats = categories_of(prev)
    curr_cats = categories_of(state)
    if prev_verdict is None:
        header = f"📊 Ring health on `{network}`: **{verdict.upper()}** (first observation)"
    elif verdict == "fail" and prev_verdict == "pass":
        header = f"❌ Ring health on `{network}`: **{verdict.upper()}** (was PASS)"
    elif verdict == "pass" and prev_verdict == "fail":
        header = f"✅ Ring health on `{network}`: **{verdict.upper()}** (recovered from FAIL)"
    elif verdict == "fail" and prev_verdict == "fail" and prev_cats != curr_cats:
        # Same verdict, *different* failure mode — e.g. went from "builder
        # stuck" (zero rebuilds) to "slow rebuilds" (rebuilds happening
        # but past threshold). Surface the transition because it changes
        # what the operator should do next.
        added = sorted(curr_cats - prev_cats)
        cleared = sorted(prev_cats - curr_cats)
        bits = []
        if cleared:
            bits.append("no longer " + ", ".join(cleared))
        if added:
            bits.append("now " + ", ".join(added))
        header = f"🔀 Ring health on `{network}`: still FAIL — {'; '.join(bits)}"
    else:
        header = f"📊 Ring health on `{network}`: {verdict.upper()}"

    body = [header]
    if pr_context:
        body.append(pr_context)
    body.append("")
    body.extend(fmt_litepeople_metrics(metrics))

    if errors:
        body.append("")
        body.append("First error:")
        body.append(f"> {errors[0]}")

    body.append("")
    body.append(f"[Full run]({run_url}) · cross-check with the listed `rev` against People-chain `Members.Root` storage")
    return "\n".join(body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prev", default="")
    parser.add_argument("--curr", required=True)
    parser.add_argument("--run-url", default="")
    parser.add_argument(
        "--pr-context",
        default="",
        help=(
            "Optional pre-formatted line (e.g. '🔗 PR #38 · branch `mak/foo`') "
            "shown under the header. Empty on scheduled runs so they read as "
            "main; populated on PR / manual-from-branch triggers."
        ),
    )
    args = parser.parse_args()

    curr = json.loads(Path(args.curr).read_text())
    prev: dict | None = None
    if args.prev and Path(args.prev).is_file():
        try:
            prev = json.loads(Path(args.prev).read_text())
        except json.JSONDecodeError:
            prev = None

    curr_verdict = curr.get("verdict")
    prev_verdict = prev.get("verdict") if prev else None

    # Consecutive-fail debounce. `verdict` is what the probe observed THIS
    # run; `notified_verdict` is what the room currently thinks. We only
    # promote observed→notified for FAIL after FLIP_TO_FAIL_THRESHOLD
    # consecutive observed fails — that absorbs a single RPC blip without
    # paging anyone. Pass promotes immediately so a recovery isn't delayed.
    prev_consecutive_fails = (prev or {}).get("consecutive_fails", 0)
    prev_notified = (prev or {}).get("notified_verdict", prev_verdict)
    if curr_verdict == "fail":
        consecutive_fails = (
            prev_consecutive_fails + 1 if prev_verdict == "fail" else 1
        )
    else:
        consecutive_fails = 0

    if curr_verdict == "pass":
        notified_verdict = "pass"
    elif consecutive_fails >= FLIP_TO_FAIL_THRESHOLD:
        notified_verdict = "fail"
    else:
        # Below threshold: don't tell the room yet. Carry forward what they
        # last heard (pass on first-ever fail observation; otherwise prev).
        notified_verdict = prev_notified

    # State is considered changed when either:
    #   - the notified verdict flipped (pass↔fail), OR
    #   - the notified verdict stayed FAIL but the *category* of failure
    #     changed (e.g. "builder stuck" → "slow rebuilds"). Persistent same-
    #     category failures don't spam every tick.
    prev_cats = categories_of(prev)
    curr_cats = categories_of(curr)
    state_changed = (prev_notified != notified_verdict) or (
        notified_verdict == "fail"
        and prev_notified == "fail"
        and prev_cats != curr_cats
    )

    # Persist debounce state back into curr-state.json so the next run
    # reads it via the workflow's cache restore. Done in-place — the
    # workflow's `cp curr-state.json prev-state.json` then picks it up.
    curr["consecutive_fails"] = consecutive_fails
    curr["notified_verdict"] = notified_verdict
    Path(args.curr).write_text(json.dumps(curr, indent=2))

    message = ""
    if state_changed:
        # Header references the notified transition (the user-visible one),
        # not the observed verdict. Pass an overlay so build_message reads
        # `verdict` as the notified value without mutating curr's original.
        state_for_msg = {**curr, "verdict": notified_verdict}
        prev_for_msg = (
            {**prev, "verdict": prev_notified} if prev is not None else None
        )
        message = build_message(state_for_msg, prev_for_msg, args.run_url, args.pr_context)

    out_path = os.environ.get("GITHUB_OUTPUT")
    out_lines = [
        f"state_changed={'true' if state_changed else 'false'}",
        # `verdict` reports what the probe OBSERVED this run, so the workflow
        # summary line stays accurate even when we suppressed the notification.
        # The notified state is separate so the operator can see both.
        f"verdict={curr_verdict or 'unknown'}",
        f"prev_verdict={prev_verdict or 'none'}",
        f"notified_verdict={notified_verdict or 'unknown'}",
        f"consecutive_fails={consecutive_fails}",
    ]
    if message:
        # multi-line output via heredoc-style delimiter
        delim = "RINGHEALTHMSG_EOF"
        out_lines.append(f"matrix_message<<{delim}")
        out_lines.append(message)
        out_lines.append(delim)
    else:
        out_lines.append("matrix_message=")

    if out_path:
        with open(out_path, "a") as fh:
            fh.write("\n".join(out_lines) + "\n")
    else:
        sys.stdout.write("\n".join(out_lines) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
