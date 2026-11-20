// Every entry a runtime's metadata defines, with its types, the way polkadot-api
// compares them. A runtime (A, A') and an SDK descriptor (D) are both read through it:
// D is metadata too.

import { getLookupFn, type LookupEntry, type Var } from "@polkadot-api/metadata-builders";
import {
  enumValueEntryPointNode,
  mapLookupToTypedef,
  runtimeCallEntryPoint,
  singleValueEntryPoint,
  storageEntryPoint,
  voidEntryPointNode,
  type EntryPoint,
  type TypedefNode,
} from "@polkadot-api/metadata-compatibility";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { DIRECTION, parseSelector } from "../selector.ts";
import type { Encoding, Entry, Kind, Metadata, Pipelines, Selector } from "../types.ts";

type Variant = Extract<Var, { type: "enum" }>["value"][string];

// How many bare `{ id }`s in a row `lookup` follows before it gives up.
const MAX_HOPS = 8;

export default class MetadataView {
  readonly metadata: Metadata;
  readonly pipelines: Pipelines;
  readonly #lookup: ReturnType<typeof getLookupFn>;
  readonly #entries = new Map<Selector, Entry>();
  readonly #nodes = new Map<number, TypedefNode>();
  readonly #pallets: ReadonlySet<string>;
  readonly #apis: ReadonlySet<string>;

  /** `bytes`: SCALE-encoded metadata, as a `.scale` file or `Metadata_metadata_at_version` holds it. */
  constructor(bytes: Uint8Array) {
    const metadata = unifyMetadata(decAnyMetadata(bytes));
    this.metadata = metadata;
    this.#lookup = getLookupFn(metadata);
    this.#pallets = new Set(metadata.pallets.map((pallet) => pallet.name));
    this.#apis = new Set(metadata.apis.map((api) => api.name));
    this.pipelines = Object.fromEntries(
      Object.entries(metadata.extrinsic.extensionsByVersion).map(([version, list]) => [
        Number(version),
        list.map((extension) => extension.identifier),
      ]),
    );
    this.#collectEntries();
  }

  entries(): Entry[] {
    return [...this.#entries.values()];
  }

  entry(selector: Selector): Entry | undefined {
    return this.#entries.get(selector);
  }

  /** Whether the metadata has the group at all: the runtime API for `apis`, the pallet for any other kind. */
  hasGroup(kind: Kind, group: string): boolean {
    return (kind === "apis" ? this.#apis : this.#pallets).has(group);
  }

  /**
   * The type behind a type id as SCALE encodes it. PAPI's lookup can
   * hand out a bare `{ id }` with no shape: a newtype around a type still being built
   * copies that type before it is filled, as XCM's `Xcm(Vec<Instruction>)` does when the
   * lookup starts at `Vec<Instruction>`. The id is then the wrapped type's, filled by now,
   * so it is looked up again. A type nested in another can be such a copy too.
   */
  lookup(id: number): LookupEntry {
    let entry: LookupEntry | { id: number } = this.#lookup(id);
    for (let hops = 0; !("type" in entry); hops++) {
      if (hops === MAX_HOPS) throw new Error(`type ${id} has no shape in the metadata lookup`);
      entry = this.#lookup(entry.id);
    }
    return entry;
  }

  /** The type behind a type id in an entry's shape. Resolved on first use. */
  node(id: number): TypedefNode {
    let node = this.#nodes.get(id);
    if (!node) {
      // From the bare `{ id }`, PAPI would build no node, and grade what reads it Identical.
      node = mapLookupToTypedef(this.lookup(id));
      this.#nodes.set(id, node);
    }
    return node;
  }

  #collectEntries(): void {
    const add = (kind: Kind, group: string, name: string, shape: EntryPoint, encoding: Encoding) => {
      const selector = `${kind}:${group}.${name}` as const;
      this.#entries.set(selector, {
        selector,
        shape,
        encoding,
        get direction() {
          return DIRECTION[parseSelector(this.selector).kind];
        },
      });
    };
    const value = (id: number): Encoding => ({ input: null, output: this.lookup(id) });
    // A runtime call's inputs are encoded one after the other, as a tuple.
    const call = (fn: { inputs: { type: number }[]; output: number }): Encoding => ({
      input:
        fn.inputs.length > 0
          ? { type: "tuple", value: fn.inputs.map((input) => this.lookup(input.type)), innerDocs: fn.inputs.map(() => []) }
          : null,
      output: this.lookup(fn.output),
    });
    // Calls and events are the variants of the pallet's call and event enums.
    const variants = (ref: { type: number } | undefined) => {
      const entry = ref && this.lookup(ref.type);
      return entry?.type === "enum" ? Object.entries(entry.value) : [];
    };

    // What a call or an event carries: its one unnamed field's type, or its fields.
    const payload = (variant: Variant): Var | null =>
      variant.type === "lookupEntry" ? variant.value : variant.type === "void" ? null : variant;

    for (const pallet of this.metadata.pallets) {
      for (const item of pallet.storage?.items ?? []) {
        const { type } = item;
        add("query", pallet.name, item.name, storageEntryPoint(item), {
          input: type.tag === "map" ? this.lookup(type.value.key) : null,
          output: this.lookup(type.tag === "map" ? type.value.value : type.value),
        });
      }
      for (const [name, variant] of variants(pallet.calls)) {
        add("tx", pallet.name, name, { args: enumValueEntryPointNode(variant), values: voidEntryPointNode }, {
          input: payload(variant),
          output: null,
        });
      }
      for (const [name, variant] of variants(pallet.events)) {
        add("event", pallet.name, name, { args: voidEntryPointNode, values: enumValueEntryPointNode(variant) }, {
          input: null,
          output: payload(variant),
        });
      }
      for (const constant of pallet.constants) {
        add("constants", pallet.name, constant.name, singleValueEntryPoint(constant.type), value(constant.type));
      }
      for (const fn of pallet.viewFns) add("view", pallet.name, fn.name, runtimeCallEntryPoint(fn), call(fn));
    }
    for (const api of this.metadata.apis) {
      for (const method of api.methods) add("apis", api.name, method.name, runtimeCallEntryPoint(method), call(method));
    }
  }
}
