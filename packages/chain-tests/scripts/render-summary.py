#!/usr/bin/env python3
"""
Render JUnit XML test results for the GitHub Actions step summary.

The chain-tests health-check workflow runs each network as a matrix job,
each upload its junit.xml as `test-results-<network>/junit.xml`. This
script produces three sections (one mode each):

* `overview <dir1> <dir2> ...` — top-level pass/fail row per network
  (Network | Status | Tests | Passed | Failed | Duration). Returns
  non-zero exit if any network had failures, so the workflow can wire
  it to a "Fail if tests failed" step.
* `compare <dir1> <dir2> ...` — cross-network comparison table: one row
  per test name, one column per network, with ✅/❌/⚠️/— cells.
* `per-network <junit.xml>` — emit a markdown table for one suite
  (Test | Status | Duration), matching what we render under the
  per-network <details> blocks.
* `failures <dir1> <dir2> ...` — print each network's failed test names
  under a heading. Empty output if everything passed.
* `matrix-summary <dir1> <dir2> ...` — terse one-line-per-network text
  for the Matrix notification body (e.g. "preview: 14/15 passed (130s)").

Each `<dirN>` is `test-results-<network>/` containing `junit.xml`.

Lives outside the workflow file because heredocs at column 0 terminate
the YAML `run: |` block — the bug we hit before.
"""
from __future__ import annotations
import os
import sys
import xml.etree.ElementTree as ET


def status_icon(tc: ET.Element) -> str:
    if tc.find("failure") is not None or tc.find("error") is not None:
        return ":x:"
    if tc.find("skipped") is not None:
        return ":warning:"
    return ":white_check_mark:"


def _counts(root: ET.Element) -> tuple[int, int, int, int, float]:
    """Return (total, passed, failed, skipped, time) for a junit root.

    Vitest's junit reporter puts `failures="N" errors="N"` on the
    `<testsuites>` root but does NOT include a `skipped` attribute there
    — skips are only visible per-`<testcase>` via a `<skipped/>` child.
    So `tests - failures` overcounts pass by the skip total, which is
    the exact bug behind "17/21 passed" when reality was "2 passed, 15
    skipped, 2 failed".
    """
    total = int(root.get("tests", "0"))
    failed = int(root.get("failures", "0")) + int(root.get("errors", "0"))
    skipped = sum(1 for tc in root.iter("testcase") if tc.find("skipped") is not None)
    passed = total - failed - skipped
    time = float(root.get("time", "0") or "0")
    return total, passed, failed, skipped, time


def network_from_dir(path: str) -> str:
    name = os.path.basename(path.rstrip("/"))
    return name[len("test-results-") :] if name.startswith("test-results-") else name


def parse_dirs(dirs: list[str]) -> list[tuple[str, ET.ElementTree]]:
    """Return (network_name, tree) for each dir with a usable junit.xml.

    Empty or malformed XML files are skipped with a stderr note —
    they happen when the test job is killed by the CI step timeout
    before vitest finalises its output.
    """
    out: list[tuple[str, ET.ElementTree]] = []
    for path in dirs:
        if not os.path.isdir(path):
            continue
        junit = os.path.join(path, "junit.xml")
        if not os.path.exists(junit):
            continue
        if os.path.getsize(junit) == 0:
            print(f"[render-summary] skipping empty junit: {junit}", file=sys.stderr)
            continue
        try:
            tree = ET.parse(junit)
        except ET.ParseError as err:
            print(f"[render-summary] skipping malformed junit {junit}: {err}", file=sys.stderr)
            continue
        out.append((network_from_dir(path), tree))
    return out


def overview(dirs: list[str]) -> int:
    print("| Network | Status | Tests | Passed | Failed | Skipped | Duration |")
    print("|---------|--------|-------|--------|--------|---------|----------|")
    any_fail = False
    seen_any = False
    for path in dirs:
        if not os.path.isdir(path):
            continue
        network = network_from_dir(path)
        junit = os.path.join(path, "junit.xml")

        def emit_no_results(reason: str) -> None:
            nonlocal any_fail
            print(f"| **{network}** | :x: NO RESULTS ({reason}) | - | - | - | - | - |")
            any_fail = True

        if not os.path.exists(junit):
            emit_no_results("artifact missing")
            continue
        if os.path.getsize(junit) == 0:
            # Vitest never finalised junit.xml — usually the CI step timeout
            # killed the run mid-flight. Treat as failure so the run goes red.
            emit_no_results("empty junit (test step timed out)")
            continue
        try:
            root = ET.parse(junit).getroot()
        except ET.ParseError as err:
            emit_no_results(f"malformed junit ({err})")
            continue

        seen_any = True
        tests, passed, failed, skipped, time = _counts(root)
        if failed > 0:
            any_fail = True
            status = ":x: FAIL"
        else:
            status = ":white_check_mark: PASS"
        print(
            f"| **{network}** | {status} | {tests} | {passed} | {failed} | {skipped} | {time:.1f}s |"
        )
    if not seen_any:
        any_fail = True
    return 1 if any_fail else 0


def per_network(junit_path: str) -> None:
    # Defensive: an empty / missing / malformed junit.xml is itself a verdict
    # ("vitest never finalised — likely SIGKILL'd at the wrapper timeout").
    # Without this guard, ET.parse raises ParseError → `set -e` in the Build
    # report step aborts before outputs are set → flip + Notify Matrix are
    # skipped → the room goes silent on the exact runs we most need to ping
    # the team about. Render a one-line "no results" row and return cleanly.
    if not os.path.exists(junit_path) or os.path.getsize(junit_path) == 0:
        print("| _vitest produced no junit.xml — see workflow logs_ | :x: | — |")
        return
    try:
        tree = ET.parse(junit_path)
    except ET.ParseError as err:
        print(f"| _malformed junit.xml ({err})_ | :x: | — |")
        return
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        time = tc.get("time", "0")
        print(f"| {name} | {status_icon(tc)} | {time}s |")


def compare(dirs: list[str]) -> None:
    parsed = parse_dirs(dirs)
    if not parsed:
        print("_No results._")
        return
    networks = [n for n, _ in parsed]
    results: dict[str, dict[str, str]] = {
        n: {tc.get("name", ""): status_icon(tc) for tc in t.iter("testcase")}
        for n, t in parsed
    }
    # Union of all test names, in first-seen order so rows follow the
    # natural ordering of whichever network discovered them first.
    all_tests: list[str] = []
    seen: set[str] = set()
    for net in networks:
        for name in results[net]:
            if name not in seen:
                seen.add(name)
                all_tests.append(name)

    print("| Test | " + " | ".join(networks) + " |")
    print("|------|" + "|".join("------" for _ in networks) + "|")
    for name in all_tests:
        cells = [results[net].get(name, "—") for net in networks]
        print(f"| {name} | " + " | ".join(cells) + " |")


def failures(dirs: list[str]) -> None:
    parsed = parse_dirs(dirs)
    blocks: list[str] = []
    for network, tree in parsed:
        names = [
            tc.get("name", "")
            for tc in tree.iter("testcase")
            if tc.find("failure") is not None or tc.find("error") is not None
        ]
        if not names:
            continue
        blocks.append(f"#### {network}\n```\n" + "\n".join(f"  {n}" for n in names) + "\n```\n")
    if not blocks:
        return
    print("### Failed Tests\n")
    for b in blocks:
        print(b)


def matrix_summary(dirs: list[str]) -> None:
    """One-liner-per-network markdown list for the Matrix notification body.

    Matrix clients render the HTML conversion of the message, so we emit
    a proper markdown bullet list — one network per line — that the
    `discount` markdown converter inside the action turns into a `<ul>`.
    """
    for path in dirs:
        if not os.path.isdir(path):
            continue
        network = network_from_dir(path)
        junit = os.path.join(path, "junit.xml")
        if not os.path.exists(junit):
            print(f"- ⚠️ **{network}** — no results")
            continue
        if os.path.getsize(junit) == 0:
            print(f"- ⚠️ **{network}** — timed out (empty junit)")
            continue
        try:
            root = ET.parse(junit).getroot()
        except ET.ParseError:
            print(f"- ⚠️ **{network}** — malformed junit")
            continue
        tests, passed, failed, skipped, time = _counts(root)
        suffix = f" ({time:.0f}s)" if time else ""
        skip_suffix = f", {skipped} skipped" if skipped else ""
        if failed > 0:
            print(
                f"- ❌ **{network}** — {passed}/{tests} passed, {failed} failed{skip_suffix}{suffix}"
            )
        elif skipped and passed == 0:
            # Everything that ran was skipped — surface that rather than
            # rendering "0/N passed" as a green check.
            print(f"- ⚠️ **{network}** — all {skipped} tests skipped{suffix}")
        else:
            print(
                f"- ✅ **{network}** — {passed}/{tests} passed{skip_suffix}{suffix}"
            )


def _failure_body(tc: ET.Element) -> str:
    """Concatenate failure/error message attributes and inner text for a testcase."""
    parts: list[str] = []
    for tag in ("failure", "error"):
        el = tc.find(tag)
        if el is None:
            continue
        msg = el.get("message") or ""
        text = (el.text or "").strip()
        parts.append(f"{msg}\n{text}".strip())
    return "\n".join(p for p in parts if p)


# When ensureAttested cascades into a dependent suite's beforeAll, the
# fixture tags the cached failure with this marker — see attested-fixture.ts.
# Matching either the cascade marker OR the upstream IB error text catches
# both the IB-health probe's own failure AND any beforeAll downstream that
# tried to attest. Listing "PGAS / Statement / Storage" alongside the IB
# probe in the Matrix message would be misleading: those features were never
# actually exercised. Group them under one IB-attribution line instead.
_IB_FAILURE_MARKERS = (
    "[ib-cascade]",
    "[attested-fixture]",
    "ASSIGNED timeout",
    "Identity Backend",
)

# Same pattern as IB: once one waitForInclusion timeout proves the
# People-chain ring builder is stuck, dependent tests fail-fast off a
# cached `[ring-cascade]` error rather than each burning their own
# 5 min. The first failure carries the full chain-side diagnostic; the
# others are tagged effects and should be grouped under one line.
_RING_FAILURE_MARKERS = (
    "[ring-cascade]",
    "Ring inclusion timed out",
    "ring builder",
)

# Top-of-suite chain-liveness probe (src/tests/probes/chain-health.test.ts)
# writes the verdict to chain-cascade; every downstream beforeAll fail-
# fasts off the cached marker. Grouping under one "Chain X degraded"
# line keeps the message focused on the chain, not the unrelated
# attestation/ring symptoms that would otherwise dominate the list.
_CHAIN_FAILURE_MARKERS = (
    "[chain-cascade]",
)

# Mirrors `ASSIGNED_TIMEOUT_MS` in attested-fixture.ts. Duplicated rather
# than parsed out of TS because this renderer runs in the workflow's
# Python step where importing TS isn't an option; the number changes
# rarely and a stale value here only affects the human-readable budget
# in the Matrix line, not the actual test behavior.
_IB_ASSIGNED_BUDGET_SECONDS = 100


def _is_ib_attributed(body: str) -> bool:
    return any(m in body for m in _IB_FAILURE_MARKERS)


def _is_ring_attributed(body: str) -> bool:
    return any(m in body for m in _RING_FAILURE_MARKERS)


def _is_chain_attributed(body: str) -> bool:
    return any(m in body for m in _CHAIN_FAILURE_MARKERS)


_CHAIN_NAMES = ("people", "asset-hub", "bulletin")


def _chains_in_body(body: str) -> list[str]:
    """Return the chain names that appear in a `[chain-cascade]` body.

    The probe and the assertChainHealthy helper both emit `<name> chain`
    in the message — match on that substring to attribute the cascade
    to the right chain (or chains, if multiple were unhealthy at probe
    time).
    """
    found = [c for c in _CHAIN_NAMES if c in body.lower()]
    return found or list(_CHAIN_NAMES)  # fall back to all if message shape changed


def matrix_failures(dirs: list[str]) -> None:
    """Failed tests grouped by network as a markdown nested list.

    Two cascade groupings:

    - **IB**: when the Identity Backend probe (or any beforeAll calling
      `ensureAttested`) fails, downstream entries collapse to one
      "Identity Backend attestation degraded" line.
    - **Ring**: when the People-chain ring builder is stuck, downstream
      ring-dependent tests collapse to one "Ring builder stuck" line.

    Real, unrelated failures still surface individually so a coincidental
    product bug during an IB or ring outage isn't hidden by the grouping.
    """
    for network, tree in parse_dirs(dirs):
        ib_blocked: list[str] = []
        ring_blocked: list[str] = []
        chain_blocked: list[str] = []
        chain_unhealthy_names: set[str] = set()
        other_failures: list[str] = []
        for tc in tree.iter("testcase"):
            if tc.find("failure") is None and tc.find("error") is None:
                continue
            name = tc.get("name", "")
            body = _failure_body(tc)
            # Chain cascade wins over IB / ring — a dead chain produces
            # IB/ring symptoms downstream but the root cause is the chain.
            if _is_chain_attributed(body):
                chain_blocked.append(name)
                chain_unhealthy_names.update(_chains_in_body(body))
            elif _is_ib_attributed(body):
                ib_blocked.append(name)
            elif _is_ring_attributed(body):
                ring_blocked.append(name)
            else:
                other_failures.append(name)

        if not ib_blocked and not ring_blocked and not chain_blocked and not other_failures:
            continue

        print(f"- **{network}**")
        if chain_blocked:
            chains = ", ".join(sorted(chain_unhealthy_names)) or "unknown"
            blocked_suites = sorted(
                {n.split(" > ")[0] for n in chain_blocked if "Chain Health" not in n}
            )
            line = (
                f"  - **Chain unhealthy ({chains})** — the Chain Health probe "
                "failed at the top of the suite; downstream beforeAlls fail-fast "
                "off a cached cascade marker. See the Chain Health suite for the "
                "first symptom (no finalized blocks, AH ring-roots window lagging "
                "People, etc.)."
            )
            if blocked_suites:
                line += f" Blocked: {', '.join(blocked_suites)}."
            print(line)
        if ib_blocked:
            blocked_suites = sorted(
                {
                    n.split(" > ")[0]
                    for n in ib_blocked
                    if "Identity Backend Health" not in n
                }
            )
            # Networks without IB deployed are gated via `needsAttestation()`
            # `describe.skipIf` / `it.skipIf` upstream — those tests skip
            # cleanly and never reach this branch. So reaching here means
            # the IB exists but failed: a genuine reconciler issue.
            line = (
                "  - **Identity Backend attestation degraded** — "
                f"reconciler did not flip a fresh account to ASSIGNED within "
                f"the {_IB_ASSIGNED_BUDGET_SECONDS} s poll budget. "
                "Identity Backend Health runs first and gates the suite: "
                "downstream features below were never exercised."
            )
            if blocked_suites:
                line += f" Blocked: {', '.join(blocked_suites)}."
            print(line)
        if ring_blocked:
            blocked_suites = sorted({n.split(" > ")[0] for n in ring_blocked})
            line = (
                "  - **Ring builder stuck** — the People-chain ring builder "
                "did not include a new attested account within 300 s. "
                "Ring-VRF proofs can't be generated, so any test that "
                "depends on attestation (PGAS, Statement, Storage, Bulletin) "
                "fails-fast off a shared cascade marker after the first "
                "timeout. This is a chain-side fault — ping the runtime team."
            )
            if blocked_suites:
                line += f" Blocked: {', '.join(blocked_suites)}."
            print(line)
        for n in other_failures:
            print(f"  - {n}")


def network_statuses(dirs: list[str]) -> None:
    """Emit per-network pass/fail verdicts as JSON.

    Output shape: `{"paseo-next-v2": "pass", "previewnet": "fail"}`.
    Used by the health-check workflow's flip-detection step — read this
    once, diff against the previously-cached snapshot, notify only on the
    networks whose verdict changed. The set of networks is whatever's
    present on disk: adding or removing a matrix entry needs no change
    here or in the workflow's flip logic.

    A "fail" verdict covers all three not-green shapes — failures > 0,
    artifact missing, junit empty/malformed — collapsing them into the
    same operator-visible signal "this network's last run did not pass."
    """
    import json
    out: dict[str, str] = {}
    for path in dirs:
        if not os.path.isdir(path):
            continue
        network = network_from_dir(path)
        junit = os.path.join(path, "junit.xml")
        if not os.path.exists(junit) or os.path.getsize(junit) == 0:
            out[network] = "fail"
            continue
        try:
            root = ET.parse(junit).getroot()
        except ET.ParseError:
            out[network] = "fail"
            continue
        out[network] = "pass" if int(root.get("failures", "0")) == 0 else "fail"
    print(json.dumps(out, sort_keys=True))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: render-summary.py overview         <dirs...>", file=sys.stderr)
        print("       render-summary.py compare          <dirs...>", file=sys.stderr)
        print("       render-summary.py failures         <dirs...>", file=sys.stderr)
        print("       render-summary.py matrix-summary   <dirs...>", file=sys.stderr)
        print("       render-summary.py matrix-failures  <dirs...>", file=sys.stderr)
        print("       render-summary.py network-statuses <dirs...>", file=sys.stderr)
        print("       render-summary.py per-network      <junit.xml>", file=sys.stderr)
        return 2
    mode = argv[1]
    if mode == "overview":
        return overview(argv[2:])
    elif mode == "per-network":
        if len(argv) != 3:
            print("per-network: expected exactly one junit.xml path", file=sys.stderr)
            return 2
        per_network(argv[2])
    elif mode == "compare":
        compare(argv[2:])
    elif mode == "failures":
        failures(argv[2:])
    elif mode == "matrix-summary":
        matrix_summary(argv[2:])
    elif mode == "matrix-failures":
        matrix_failures(argv[2:])
    elif mode == "network-statuses":
        network_statuses(argv[2:])
    else:
        print(f"unknown mode: {mode}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
