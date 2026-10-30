// Selectors (`tx:Coinage.transfer`) and what their kind implies.

import type { ChainKey, Direction, Kind, Selector } from "./types.ts";

export const KINDS: readonly Kind[] = ["tx", "query", "event", "constant", "api", "view"];

/** The chain-client keys, in the order reports list them. */
export const CHAIN_KEYS: readonly ChainKey[] = ["individuality", "assetHub", "bulletin"];

/** Who encodes and who decodes, per kind: see `Direction`. */
export const DIRECTION: Record<Kind, Direction> = {
  tx: "encode",
  event: "decode",
  constant: "decode",
  query: "both",
  api: "both",
  view: "both",
};

export function parseSelector(selector: Selector): { kind: Kind; group: string; name: string } {
  const [, prefix, group, name] = /^(\w+):(\w+)\.(\w+)$/.exec(selector) ?? [];
  const kind = KINDS.find((k) => k === prefix);
  if (!kind || !group || !name) throw new Error(`not a selector: ${selector}`);
  return { kind, group, name };
}
