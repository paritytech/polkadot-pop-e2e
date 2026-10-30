// Every entry a runtime's metadata defines, with its types, the way polkadot-api
// compares them. A runtime (A, A') and an SDK descriptor (D) are both read through it:
// D is metadata too.

import { getLookupFn } from "@polkadot-api/metadata-builders";
import {
  enumValueEntryPointNode,
  mapLookupToTypedef,
  runtimeCallEntryPoint,
  singleValueEntryPoint,
  storageEntryPoint,
  voidEntryPointNode,
  type TypedefNode,
} from "@polkadot-api/metadata-compatibility";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { DIRECTION } from "../selector.ts";
import type { Entry, Kind, Metadata, Pipelines, Selector, Shape } from "../types.ts";

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

  /** Whether the metadata has the group at all: the runtime API for `api`, the pallet for any other kind. */
  hasGroup(kind: Kind, group: string): boolean {
    return (kind === "api" ? this.#apis : this.#pallets).has(group);
  }

  /** The type behind a type id in an entry's shape. Resolved on first use. */
  node(id: number): TypedefNode {
    let node = this.#nodes.get(id);
    if (!node) {
      node = mapLookupToTypedef(this.#lookup(id));
      this.#nodes.set(id, node);
    }
    return node;
  }

  #collectEntries(): void {
    const add = (kind: Kind, group: string, name: string, shape: Shape) => {
      const selector = `${kind}:${group}.${name}` as const;
      this.#entries.set(selector, { selector, kind, group, name, shape, direction: DIRECTION[kind] });
    };
    // Calls and events are the variants of the pallet's call and event enums.
    const variants = (ref: { type: number } | undefined) => {
      const entry = ref && this.#lookup(ref.type);
      return entry?.type === "enum" ? Object.entries(entry.value) : [];
    };

    for (const pallet of this.metadata.pallets) {
      for (const item of pallet.storage?.items ?? []) add("query", pallet.name, item.name, storageEntryPoint(item));
      for (const [name, variant] of variants(pallet.calls)) {
        add("tx", pallet.name, name, { args: enumValueEntryPointNode(variant), values: voidEntryPointNode });
      }
      for (const [name, variant] of variants(pallet.events)) {
        add("event", pallet.name, name, { args: voidEntryPointNode, values: enumValueEntryPointNode(variant) });
      }
      for (const constant of pallet.constants) add("constant", pallet.name, constant.name, singleValueEntryPoint(constant.type));
      for (const fn of pallet.viewFns) add("view", pallet.name, fn.name, runtimeCallEntryPoint(fn));
    }
    for (const api of this.metadata.apis) {
      for (const method of api.methods) add("api", api.name, method.name, runtimeCallEntryPoint(method));
    }
  }
}
