// Loads packages/chain-tests/.env; variables already set in the environment win. Imported first
// by networks.ts, which reads NETWORK and STACK when it loads.
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../.env") });
