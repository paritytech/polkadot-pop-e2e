import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { metadata } from "@polkadot-api/substrate-bindings";
import { entryLevel } from "../check/grade.ts";
import type { Requirement, Selector } from "../types.ts";
import MetadataView from "./index.ts";

// ── A small metadata, encoded here: one pallet's storage items, read in their order ──

type V14 = Extract<Parameters<typeof metadata.enc>[0]["metadata"], { tag: "v14" }>["value"];
type LookupType = V14["lookup"][number];

const type = (id: number, path: string[], def: LookupType["def"]): LookupType => ({ id, path, params: [], def, docs: [] });
const field = (id: number) => ({ name: undefined, type: id, typeName: undefined, docs: [] });

/**
 * XCM's shape: 0: Vec<Instr>, 1: Instr = A(the primitive) | B(Xcm), 2: Xcm(Vec<Instr>),
 * 3: the primitive. `items`: the storage items, each a type id, in the order PAPI meets them.
 */
function encoded(primitive: "u32" | "str", items: Record<string, number>): Uint8Array {
  const lookup = [
    type(0, [], { tag: "sequence", value: 1 }),
    type(1, ["Instr"], {
      tag: "variant",
      value: [
        { name: "A", fields: [field(3)], index: 0, docs: [] },
        { name: "B", fields: [field(2)], index: 1, docs: [] },
      ],
    }),
    type(2, ["Xcm"], { tag: "composite", value: [field(0)] }),
    type(3, [], { tag: "primitive", value: { tag: primitive, value: undefined } }),
  ];
  const storage = Object.entries(items).map(([name, id]) => ({
    name,
    modifier: 0,
    type: { tag: "plain" as const, value: id },
    fallback: "0x00" as const,
    docs: [],
  }));
  const pallet = { name: "P", storage: { prefix: "P", items: storage }, calls: undefined, events: undefined, constants: [], errors: undefined, index: 0, docs: [] };
  const value: V14 = { lookup, pallets: [pallet], extrinsic: { type: 0, version: 4, signedExtensions: [] }, type: 0, apis: [] };
  return metadata.enc({ magicNumber: 0x6174656d, metadata: { tag: "v14", value } });
}

describe("MetadataView on a newtype PAPI's lookup met while building the type it wraps", () => {
  // Reading Vec<Instr> first meets Xcm inside it, before Vec<Instr> is built.
  const XCM_SECOND = { Instrs: 0, Xcm: 2 };
  const XCM_FIRST = { Xcm: 2, Instrs: 0 };

  it("looks the type up whole: the wrapped Vec<Instr>, as when Xcm is met first", () => {
    for (const items of [XCM_SECOND, XCM_FIRST]) {
      const view = new MetadataView(encoded("u32", items));
      assert.equal(view.lookup(2).type, "sequence");
      assert.deepEqual(view.node(2), { type: "array", value: { typeRef: 1 } });
    }
  });

  it("grades what reads it, rather than calling a changed type Identical", () => {
    const grade = (items: Record<string, number>) => {
      const selector: Selector = "query:P.Xcm";
      const descriptor = new MetadataView(encoded("u32", items));
      const runtime = new MetadataView(encoded("str", items));
      const requirement = { selector, direction: "both", expected: descriptor.entry(selector) ?? null } as Requirement;
      return entryLevel(requirement, descriptor, runtime, new Map());
    };
    assert.equal(grade(XCM_FIRST), "Partial");
    assert.equal(grade(XCM_SECOND), "Partial");
  });
});
