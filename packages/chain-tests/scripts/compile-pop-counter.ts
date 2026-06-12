/**
 * One-off compiler for `contracts/PopCounter.sol`. Run when the contract
 * source changes; the resulting hex is committed into
 * `src/lib/pop-counter-contract.ts`. Mirrors how the original counter
 * carries its bytecode as a hand-pinned constant — no runtime solc
 * dependency at test time.
 *
 * Usage: `pnpm --filter @triangle-e2e/chain-tests compile-pop-counter`
 */
// solc-js's typings are export-default-cjs; treat as `any` to keep types simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../contracts/PopCounter.sol");
const OUT = resolve(HERE, "../src/lib/pop-counter-bytecode.ts");

const source = readFileSync(SRC, "utf8");
const input = {
  language: "Solidity",
  sources: { "PopCounter.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object", "abi"] } },
    evmVersion: "cancun",
  },
};

interface SolcOutput {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
}

const out: SolcOutput = JSON.parse(
  (solc as { compile: (input: string) => string }).compile(JSON.stringify(input)),
);
if (out.errors) {
  const fatal = out.errors.filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    for (const e of fatal) console.error(e.formattedMessage);
    process.exit(1);
  }
}

const contract = out.contracts["PopCounter.sol"]?.["PopCounter"];
if (!contract) {
  console.error("PopCounter contract not found in solc output");
  process.exit(1);
}
const bytecodeHex = contract.evm.bytecode.object; // init + runtime, hex (no 0x)
const runtimeHex = contract.evm.deployedBytecode.object; // runtime only

console.log(`PopCounter init+runtime: ${bytecodeHex.length / 2} bytes`);
console.log(`PopCounter runtime    : ${runtimeHex.length / 2} bytes`);

const ts = `/**
 * AUTO-GENERATED from contracts/PopCounter.sol via
 * scripts/compile-pop-counter.ts. Do not edit by hand — re-run the
 * compile script and commit both this file and the .sol source.
 */
export const POP_COUNTER_BYTECODE_HEX = "${bytecodeHex}";
export const POP_COUNTER_RUNTIME_HEX = "${runtimeHex}";
`;
writeFileSync(OUT, ts);
console.log(`Wrote ${OUT}`);
