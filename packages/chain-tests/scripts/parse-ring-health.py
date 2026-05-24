#!/usr/bin/env python3
"""Parse vitest ring-health.test.ts stdout into a compact state JSON.

Usage:
    python3 parse-ring-health.py <log-file>

Emits a single-line JSON to stdout:
    {
      "verdict": "pass" | "fail",
      "network": "paseo-next-v2",
      "tests": {
        "<test name>": "pass" | "fail" | "skip"
      },
      "metrics": {
        "<collection>": {
          "key": "value", ...
        }
      },
      "errors": [ "first-line of each failure message" ]
    }

Used by `.github/workflows/ring-health.yml` to diff against the previous
run's state — matrix notifications only fire on a state change.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


METRIC_RE = re.compile(r"\[ring-health\] METRIC (.+)$")
NETWORK_RE = re.compile(r"\[ring-health\] Network: (.+)$")
BUDGET_RE = re.compile(r"\[ring-health\] AH catch-up budget for (.+?) \(key=")
# Vitest emits failure detail lines like
#   `    [31m     → [ring-health] People: 1 member(s) in Onboarding right now…[39m`
# i.e. a "→" arrow followed by the test's error message, embedded in ANSI
# escape sequences. Strip ANSI per-line before grepping so our error
# extraction actually catches these.
ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
# `search` (not `match`) + no leading `^`: the workflow's `tee /tmp/probe.log`
# captures bare vitest stdout, but when debugging against `gh api .../logs`
# the same content is timestamp-prefixed. Tolerate either.
FAILURE_DETAIL_RE = re.compile(r"(?:^|\s)→\s+(.+?)\s*$")
# vitest summary lines look like:
#   ✓ src/tests/probes/ring-health.test.ts (4 tests) 130414ms
#   ✘ src/tests/probes/ring-health.test.ts > People-chain ring rebuild latency > X
#   Tests  4 passed (4)
#   Tests  1 failed | 1 passed (2)
TEST_OK_RE = re.compile(r"^\s*✓\s+(.+?)\s+\(\d+ms\)\s*$")
TEST_FAIL_RE = re.compile(r"^\s*✘\s+(.+?)\s+\(\d+ms\)?\s*$")
ERROR_RE = re.compile(r"^\s*(?:Error|→)\s*(.+)$")


def parse_kv(text: str) -> dict:
    """Parse `key=value key=value` pairs, leaving values as strings."""
    out: dict[str, str] = {}
    for token in text.split():
        if "=" in token:
            k, v = token.split("=", 1)
            out[k] = v
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("log_file")
    parser.add_argument(
        "--network",
        default=os.environ.get("NETWORK"),
        help="Network slug to record (defaults to $NETWORK or grepping the log)",
    )
    parser.add_argument(
        "--vitest-exit-code",
        type=int,
        default=None,
        help=(
            "Vitest's actual exit code (captured by the workflow via "
            "`${PIPESTATUS[0]}`). When provided, this is the authoritative "
            "source for the verdict — log heuristics are unreliable because "
            "vitest mixes ANSI escapes into its output and writes `FAIL` "
            "(not ✘) for failed tests."
        ),
    )
    args = parser.parse_args()
    log = Path(args.log_file).read_text(errors="replace")

    # The vitest output prefixes test stdout with `stdout | <file>`; the
    # `[ring-health]` content lines may not start at column 0. The regex
    # uses `search` (no anchor) which handles either form.
    network = args.network
    metrics: dict[str, dict] = {}
    tests: dict[str, str] = {}
    errors: list[str] = []
    overall_pass = None

    raw_lines = log.splitlines()
    # Strip ANSI escape sequences from each line for grepping; vitest mixes
    # them into both summary and per-test failure-detail lines, breaking
    # regexes that anchor on `^\s*` or look for unescaped icons.
    lines = [ANSI_RE.sub("", line) for line in raw_lines]
    for i, line in enumerate(lines):
        # Vitest's "→" arrow line carries the actual failure message.
        m = FAILURE_DETAIL_RE.search(line)
        if m:
            errors.append(m.group(1)[:240])

        if not network:
            m = NETWORK_RE.search(line)
            if m:
                network = m.group(1).strip()
                continue
            m = BUDGET_RE.search(line)
            if m:
                network = m.group(1).strip()
                continue

        m = METRIC_RE.search(line)
        if m:
            kv = parse_kv(m.group(1))
            collection = kv.pop("collection", "default")
            # Multiple METRIC lines per collection — merge so the most-recent
            # values win (later runs overwrite earlier diagnostic lines).
            metrics.setdefault(collection, {}).update(kv)
            continue

        m = TEST_OK_RE.match(line)
        if m:
            tests[m.group(1).strip()] = "pass"
            continue

        m = TEST_FAIL_RE.match(line)
        if m:
            name = m.group(1).strip()
            tests[name] = "fail"
            # Look for the first non-empty error line on the next ~5 lines.
            for j in range(i + 1, min(i + 8, len(lines))):
                emsg = ERROR_RE.search(lines[j])
                if emsg:
                    errors.append(emsg.group(1).strip()[:200])
                    break
            continue

        if line.startswith("Tests ") and ("passed" in line or "failed" in line):
            overall_pass = "failed" not in line

    # Vitest exit code is the source of truth when supplied. Heuristic-parsing
    # the log (`Tests N failed | …`, ✓/✘ markers) is fragile because vitest
    # mixes ANSI escapes into its output and uses `FAIL`/`PASS` words rather
    # than the icons we'd grep for.
    if args.vitest_exit_code is not None:
        overall_pass = args.vitest_exit_code == 0
    elif overall_pass is None:
        # Last-resort fallback only — derive from per-test verdicts.
        overall_pass = all(v == "pass" for v in tests.values()) and bool(tests)

    state = {
        "verdict": "pass" if overall_pass else "fail",
        "network": network or "unknown",
        "tests": tests,
        "metrics": metrics,
        "errors": errors,
    }
    print(json.dumps(state, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
