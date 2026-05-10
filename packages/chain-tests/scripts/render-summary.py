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
    print("| Network | Status | Tests | Passed | Failed | Duration |")
    print("|---------|--------|-------|--------|--------|----------|")
    any_fail = False
    seen_any = False
    for path in dirs:
        if not os.path.isdir(path):
            continue
        network = network_from_dir(path)
        junit = os.path.join(path, "junit.xml")

        def emit_no_results(reason: str) -> None:
            nonlocal any_fail
            print(f"| **{network}** | :x: NO RESULTS ({reason}) | - | - | - | - |")
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
        tests = int(root.get("tests", "0"))
        failures = int(root.get("failures", "0"))
        time = float(root.get("time", "0") or "0")
        passed = tests - failures
        if failures > 0:
            any_fail = True
            status = ":x: FAIL"
        else:
            status = ":white_check_mark: PASS"
        print(
            f"| **{network}** | {status} | {tests} | {passed} | {failures} | {time:.1f}s |"
        )
    if not seen_any:
        any_fail = True
    return 1 if any_fail else 0


def per_network(junit_path: str) -> None:
    tree = ET.parse(junit_path)
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
        tests = int(root.get("tests", "0"))
        failures_n = int(root.get("failures", "0"))
        time = float(root.get("time", "0") or "0")
        passed = tests - failures_n
        if failures_n > 0:
            print(
                f"- ❌ **{network}** — {passed}/{tests} passed, {failures_n} failed ({time:.0f}s)"
            )
        else:
            print(f"- ✅ **{network}** — {tests}/{tests} passed ({time:.0f}s)")


def matrix_failures(dirs: list[str]) -> None:
    """Failed tests grouped by network as a markdown nested list.

    Renders to something like:

        - **paseo-next-v2**
          - PGAS: claim + spend on revive > claim PGAS gas allowance
          - Storage: Bulletin Chain > uploaded CID is retrievable …
        - **previewnet**
          - PGAS: claim + spend on revive > claim PGAS gas allowance
    """
    for network, tree in parse_dirs(dirs):
        names = [
            tc.get("name", "")
            for tc in tree.iter("testcase")
            if tc.find("failure") is not None or tc.find("error") is not None
        ]
        if not names:
            continue
        print(f"- **{network}**")
        for n in names:
            print(f"  - {n}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: render-summary.py overview     <dirs...>", file=sys.stderr)
        print("       render-summary.py compare      <dirs...>", file=sys.stderr)
        print("       render-summary.py failures     <dirs...>", file=sys.stderr)
        print("       render-summary.py matrix-summary <dirs...>", file=sys.stderr)
        print("       render-summary.py per-network  <junit.xml>", file=sys.stderr)
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
    else:
        print(f"unknown mode: {mode}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
