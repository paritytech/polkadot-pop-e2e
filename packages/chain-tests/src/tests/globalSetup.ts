/**
 * Global setup: runs once before all test files.
 * - Registers a fresh account via identity-backend (if available)
 * - Waits for attestation to complete
 * - Writes credentials to a temp file for test files to read
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  generateAttestationParams,
  signAndRegister,
} from "../lib/attestation.js";
import { getNetworkConfig } from "../config/networks.js";

const CREDENTIALS_PATH = resolve(import.meta.dirname, "../../.test-credentials.json");

export async function setup() {
  config({ path: resolve(import.meta.dirname, "../../.env") });

  const network = getNetworkConfig();
  console.log(`\n[global-setup] Network: ${network.name}`);

  if (!network.identityBackend) {
    console.log("[global-setup] No identity backend — skipping attestation");
    writeFileSync(CREDENTIALS_PATH, JSON.stringify({ attested: false }));
    return;
  }

  console.log(`[global-setup] Identity backend: ${network.identityBackend}`);

  // Generate fresh account + attestation params
  const { credentials, params } = generateAttestationParams();
  console.log(`[global-setup] Fresh account: ${credentials.address}`);
  console.log(`[global-setup] Username: ${params.username}`);

  // Register via identity-backend
  const start = Date.now();
  const result = await signAndRegister(
    network.identityBackend,
    credentials.entropy,
    params,
  );
  console.log(`[global-setup] Registered: ${result.username} (${Date.now() - start}ms)`);

  // Write credentials for test files
  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({
      attested: true,
      address: credentials.address,
      publicKey: Array.from(credentials.publicKey),
      statementStoreSecret: Array.from(credentials.statementStoreSecret),
      entropy: Array.from(credentials.entropy),
      username: result.username,
    }),
  );

  console.log(`[global-setup] Credentials written to ${CREDENTIALS_PATH}`);
}

export async function teardown() {
  // Credentials file is gitignored — keep it for debugging
}
