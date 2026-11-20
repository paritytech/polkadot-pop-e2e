// The metadata check from the command line.
//
//   pnpm exec tsx environments/meta-check/cli/main.ts capture <live|candidate> ...
//   pnpm exec tsx environments/meta-check/cli/main.ts report ...
//
// capture.ts and report.ts say what each takes.

import * as capture from "./capture.ts";
import * as report from "./report.ts";

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = {
  capture: capture.main,
  report: report.main,
};

const [command = "", ...args] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
  console.error(`usage: main.ts <${Object.keys(COMMANDS).join("|")}> ...`);
  process.exit(2);
}
process.exit(await run(args));
