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
import sys
from pathlib import Path


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


def build_message(state: dict, prev: dict | None, run_url: str) -> str:
    verdict = state.get("verdict", "?")
    prev_verdict = prev.get("verdict") if prev else None
    network = state.get("network", "?")
    metrics = state.get("metrics", {})
    errors = state.get("errors", [])

    if prev_verdict is None:
        header = f"📊 Ring health on `{network}`: **{verdict.upper()}** (first observation)"
    elif verdict == "fail" and prev_verdict == "pass":
        header = f"❌ Ring health on `{network}`: **{verdict.upper()}** (was PASS)"
    elif verdict == "pass" and prev_verdict == "fail":
        header = f"✅ Ring health on `{network}`: **{verdict.upper()}** (recovered from FAIL)"
    else:
        header = f"📊 Ring health on `{network}`: {verdict.upper()}"

    body = [header, ""]
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
    state_changed = prev_verdict != curr_verdict

    message = ""
    if state_changed:
        message = build_message(curr, prev, args.run_url)

    out_path = os.environ.get("GITHUB_OUTPUT")
    out_lines = [
        f"state_changed={'true' if state_changed else 'false'}",
        f"verdict={curr_verdict or 'unknown'}",
        f"prev_verdict={prev_verdict or 'none'}",
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
