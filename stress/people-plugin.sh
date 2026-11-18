#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node --import "$root/node_modules/tsx/dist/loader.mjs" "$root/packages/chain-tests/src/stress/index.ts"
