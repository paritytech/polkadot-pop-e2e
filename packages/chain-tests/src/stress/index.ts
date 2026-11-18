import { serve } from "./protocol.js";

const fields = (types: Record<string, string>) => Object.fromEntries(
  Object.entries(types).map(([name, type]) => [name, { schema: { type } }]),
);
const operation = (description: string, inputs: Record<string, string>, outputs: Record<string, string>, read_only = false) =>
  ({ description, inputs: fields(inputs), outputs: fields(outputs), read_only });
const manifest = {
  id: "people", version: "0.1.0", protocol: 1,
  operations: {
    preflight: operation("Check People runtime without submitting", { target: "string" }, { identity: "json" }, true),
    recognize: operation("Prepare sudo recognition", { target: "string", credential: "string", members: "integer" }, { transactions: "json", members: "integer" }),
    "prepare-claims": operation("Prepare distinct claim and probe artifacts", { target: "string", members: "integer", slots: "integer", "probe-reserve": "integer" }, { flood: "json", probes: "json" }),
  },
};
// Install/describe/shutdown do not load PAPI, chain descriptors or WASM.
console.log = console.error;
await serve(manifest, async (op, inputs, context) => {
  if (!(op in manifest.operations)) throw new Error("unknown operation");
  return (await import("./people.js")).invoke(op, inputs, context);
});
