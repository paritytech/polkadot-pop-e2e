#!/usr/bin/env bash
# Run chain-tests scripts one after another and keep each one's junit result.
#
#   environments/run-chain-tests.sh <results-dir> <script>...
#
# vitest writes <results-dir>/junit.xml again on every run, so a second script would
# replace the first one's results. After each script its junit.xml is renamed to
# junit-<script>.xml (":" and other characters the artifact upload refuses become
# "_"). The first failing script stops the run, as before, and its results are kept.
set -uo pipefail

dir=$1
shift
for t in "$@"; do
  echo "::group::$t"
  rm -f "$dir/junit.xml"
  pnpm --filter @pop-e2e/chain-tests "$t"
  status=$?
  if [ -f "$dir/junit.xml" ]; then
    mv "$dir/junit.xml" "$dir/junit-${t//[^A-Za-z0-9_.-]/_}.xml"
  fi
  echo "::endgroup::"
  [ "$status" -eq 0 ] || exit "$status"
done
