// Where two types differ, live's (A) against the candidate's (A'), in how they encode.
//
// PAPI does not answer this. Its compatibility check grades two types, but its `Identical`
// treats u16 and u32 alike (both `number`), compact and plain integers alike, and
// AccountId32 and AccountId20 alike (both a string); it lists changes only one level
// down, from one side, and none where the receiving side has more than the sending one.
// Its type checksums erase the same widths, and field order and variant indexes too.
// So this walks the types polkadot-api builds its codecs from (`EncodedType`), with an
// equality of its own: two types are equal when they encode alike, under the same names.

import type MetadataView from "../metadata-view/index.ts";
import type { EncodedType, TypeChange } from "../types.ts";

type Variant = Extract<EncodedType, { type: "enum" }>["value"][string];

// Past these, a type name stops being read.
const NAME_DEPTH = 2;
const MAX_NAME = 100;
const MAX_VARIANTS = 6;

/**
 * A type used all over (an XCM location, a call) can change under hundreds of paths. Past
 * this many, the walk stops: one comparison returns at most one more, to say there were more.
 */
export const MAX_TYPE_CHANGES = 100;

const cut = (text: string): string => (text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text);

/** `enum { Ok, Err }`; past a few, the count says the rest. */
const variants = (names: string[]): string =>
  `enum { ${names.slice(0, MAX_VARIANTS).join(", ")}${names.length > MAX_VARIANTS ? `, … (${names.length})` : ""} }`;

/** The type's Rust name, as its metadata gives it: `MultiAddress<AccountId32, ()>`, `Vec<u8>`, `[u8; 32]`. */
function typeName(view: MetadataView, id: number, depth = NAME_DEPTH): string {
  const type = view.metadata.lookup[id];
  if (type?.id !== id) return `#${id}`;
  const { path, params, def } = type;
  const typed = params.flatMap((param) => (param.type === undefined ? [] : [param.type]));
  const name = path.at(-1);
  // Past the depth, only what needs no more depth: a primitive, or a name without parameters.
  if (depth < 0 && !(name ? typed.length === 0 : def.tag === "primitive")) return "…";
  const inner = (other: number) => typeName(view, other, depth - 1);
  if (name) return typed.length > 0 ? `${name}<${typed.map(inner).join(", ")}>` : name;
  switch (def.tag) {
    case "primitive":
      return def.value.tag;
    case "compact":
      return `Compact<${inner(def.value)}>`;
    case "sequence":
      return `Vec<${inner(def.value)}>`;
    case "array":
      return `[${inner(def.value.type)}; ${def.value.len}]`;
    case "tuple":
      return `(${def.value.map(inner).join(", ")})`;
    case "bitSequence":
      return "BitVec";
    case "composite":
      return `{ ${def.value.map((field, index) => `${field.name ?? index}: ${inner(field.type)}`).join(", ")} }`;
    case "variant":
      return variants(def.value.map((variant) => variant.name));
  }
}

/** A type as it encodes, its children by name: `{ who: AccountId32, amount: u128 }`, `Compact<u32>`. */
function encodedText(view: MetadataView, type: EncodedType): string {
  const name = (child: EncodedType) => ("id" in child ? typeName(view, child.id as number, NAME_DEPTH - 1) : "…");
  switch (type.type) {
    case "primitive":
      return type.value;
    case "compact":
      return `Compact<${type.size}>`;
    case "void":
      return "()";
    case "bitSequence":
      return type.isLSB ? "BitVec<Lsb0>" : "BitVec<Msb0>";
    case "AccountId32":
    case "AccountId20":
      return type.type;
    case "sequence":
      return `Vec<${name(type.value)}>`;
    case "array":
      return `[${name(type.value)}; ${type.len}]`;
    case "option":
      return `Option<${name(type.value)}>`;
    case "result":
      return `Result<${name(type.value.ok)}, ${name(type.value.ko)}>`;
    case "tuple":
      return `(${type.value.map(name).join(", ")})`;
    case "struct":
      return `{ ${Object.entries(type.value).map(([key, child]) => `${key}: ${name(child)}`).join(", ")} }`;
    case "enum":
      return variants(Object.keys(type.value));
  }
}

/** A type by its Rust name when it has an id; inline (a call's fields) by how it encodes. */
const describe = (view: MetadataView, type: EncodedType): string =>
  cut("id" in type ? typeName(view, type.id as number) : encodedText(view, type));

/** What a variant carries, as a type. */
const payload = (variant: Variant): EncodedType => (variant.type === "lookupEntry" ? variant.value : variant);

// How many bare `{ id }`s in a row `shaped` follows before it gives up on the lookup.
const MAX_HOPS = 8;

/**
 * The type itself. PAPI's lookup can hand out a bare `{ id }` with no shape: a newtype
 * around a type still being built copies that type before it is filled, as XCM's
 * `Xcm(Vec<Instruction>)` does when the lookup starts at `Vec<Instruction>`. The id is the
 * wrapped type's, filled by now, so it is looked up again in the runtime it came from.
 */
function shaped(view: MetadataView, type: EncodedType): EncodedType {
  let current: EncodedType | { id: number } = type;
  for (let hops = 0; !("type" in current); hops++) {
    if (hops === MAX_HOPS) throw new Error(`type ${current.id} has no shape in the metadata lookup`);
    current = view.lookup(current.id);
  }
  return current;
}

/**
 * PAPI makes `(T, T)`, or a tuple struct `Pair(T, T)`, an array `[T; 2]` unless an element
 * or field has doc comments, and a tuple otherwise: a doc comment can turn one into the
 * other. Both encode the elements one after the other, so they compare element by element.
 */
const arrayAndTuple = (a: EncodedType, b: EncodedType): boolean =>
  (a.type === "array" && b.type === "tuple") || (a.type === "tuple" && b.type === "array");

/** A type's children, by the path segment PAPI names them with; an array facing a tuple, by index. */
function children(type: EncodedType, other: EncodedType): Map<string, EncodedType> {
  if (type.type === "array" && other.type === "tuple") {
    return new Map(Array.from({ length: type.len }, (_, index) => [String(index), type.value]));
  }
  switch (type.type) {
    case "struct":
      return new Map(Object.entries(type.value));
    case "enum":
      return new Map(Object.entries(type.value).map(([key, variant]) => [key, payload(variant)]));
    case "tuple":
      return new Map(type.value.map((child, index) => [String(index), child]));
    case "option":
      return new Map([["some", type.value]]);
    case "result":
      return new Map([
        ["ok", type.value.ok],
        ["ko", type.value.ko],
      ]);
    case "sequence":
    case "array":
      return new Map([["value", type.value]]);
    default:
      return new Map();
  }
}

/** Whether the two types differ in themselves, not only in their children: kind, width, length. */
function differsInItself(before: EncodedType, after: EncodedType): boolean {
  if (before.type !== after.type) return !arrayAndTuple(before, after);
  switch (before.type) {
    case "primitive":
      return before.value !== (after as typeof before).value;
    case "compact":
      return before.size !== (after as typeof before).size;
    case "bitSequence":
      return before.isLSB !== (after as typeof before).isLSB;
    case "array":
      return before.len !== (after as typeof before).len;
    case "enum":
      // A module error's: how many bytes the variant takes.
      return before.byteLength !== (after as typeof before).byteLength;
    default:
      return false;
  }
}

/** The fields both structs have, in each one's order, when the orders differ: SCALE encodes fields in order. */
function fieldOrder(before: EncodedType, after: EncodedType): [string, string] | null {
  if (before.type !== "struct" || after.type !== "struct") return null;
  const ours = Object.keys(before.value).filter((key) => key in after.value);
  const theirs = Object.keys(after.value).filter((key) => key in before.value);
  return ours.join() === theirs.join() ? null : [`{ ${ours.join(", ")} }`, `{ ${theirs.join(", ")} }`];
}

/** The variants both enums have whose index differs, with both indexes: SCALE encodes the index. */
function reindexed(before: EncodedType, after: EncodedType): Map<string, [number, number]> {
  if (before.type !== "enum" || after.type !== "enum") return new Map();
  return new Map(
    Object.entries(before.value).flatMap(([key, variant]): [string, [number, number]][] => {
      const other = after.value[key];
      return other && other.idx !== variant.idx ? [[key, [variant.idx, other.idx]]] : [];
    }),
  );
}

/**
 * Whether two types encode alike under the same names. A recursive type is assumed equal
 * where the comparison meets a pair it is already comparing; a result that leans on such an
 * assumption is remembered only once the pair it leans on is settled.
 */
function encodesAlike(live: MetadataView, candidate: MetadataView) {
  const settled = new Map<EncodedType, Map<EncodedType, boolean>>();
  const comparing = new Map<EncodedType, Map<EncodedType, number>>();

  /** `assumedAt`: the shallowest pair still being compared that the result leans on. */
  const visit = (onLive: EncodedType, onCandidate: EncodedType, depth: number): { equal: boolean; assumedAt: number } => {
    const a = shaped(live, onLive);
    const b = shaped(candidate, onCandidate);
    if (a === b) return { equal: true, assumedAt: Infinity };
    const known = settled.get(a)?.get(b);
    if (known !== undefined) return { equal: known, assumedAt: Infinity };
    const at = comparing.get(a)?.get(b);
    if (at !== undefined) return { equal: true, assumedAt: at };

    const open = comparing.get(a) ?? new Map<EncodedType, number>();
    comparing.set(a, open.set(b, depth));
    let equal = !differsInItself(a, b) && !fieldOrder(a, b) && reindexed(a, b).size === 0;
    let assumedAt = Infinity;
    const ours = children(a, b);
    const theirs = children(b, a);
    if (equal && ours.size !== theirs.size) equal = false;
    for (const [key, child] of equal ? ours : []) {
      const other = theirs.get(key);
      const result = other ? visit(child, other, depth + 1) : { equal: false, assumedAt: Infinity };
      assumedAt = Math.min(assumedAt, result.assumedAt);
      if (!result.equal) {
        equal = false;
        break;
      }
    }
    open.delete(b);

    // Unequal even when assuming equal is unequal; equal is settled once nothing above it was assumed.
    if (!equal || assumedAt >= depth) {
      const known = settled.get(a) ?? new Map<EncodedType, boolean>();
      settled.set(a, known.set(b, equal));
      return { equal, assumedAt: Infinity };
    }
    return { equal, assumedAt };
  };

  return (a: EncodedType, b: EncodedType) => visit(a, b, 0).equal;
}

/**
 * `changes(path, before, after)`: where `before` (a type on live) and `after` (one on the
 * candidate) differ, in walk order: the fields, variants and elements one side has and the
 * other does not, the places where a type was replaced by another (another kind, width or
 * length), fields that moved within a struct, and variants whose index changed. Either side
 * can be absent, for a type only the other runtime has. A type both sides use under several
 * paths is reported under each.
 */
export default function compareTypes(live: MetadataView, candidate: MetadataView) {
  const alike = encodesAlike(live, candidate);

  return function changes(path: string, before: EncodedType | null | undefined, after: EncodedType | null | undefined): TypeChange[] {
    const found: TypeChange[] = [];
    // The pairs being walked: a recursive type meets itself again, already being compared.
    const walking = new Map<EncodedType, Set<EncodedType>>();
    const push = (change: TypeChange) => {
      if (found.length <= MAX_TYPE_CHANGES) found.push(change);
    };

    const walk = (at: string, onLive: EncodedType | null | undefined, onCandidate: EncodedType | null | undefined): void => {
      if (found.length > MAX_TYPE_CHANGES) return;
      const from = onLive && shaped(live, onLive);
      const to = onCandidate && shaped(candidate, onCandidate);
      if (!from && !to) return;
      if (!from) return push({ path: at, status: "added", before: null, after: describe(candidate, to as EncodedType) });
      if (!to) return push({ path: at, status: "removed", before: describe(live, from), after: null });
      if (alike(from, to) || walking.get(from)?.has(to)) return;
      if (differsInItself(from, to)) {
        let [beforeText, afterText] = [describe(live, from), describe(candidate, to)];
        // Same name, another encoding: the encodings say what changed.
        if (beforeText === afterText) [beforeText, afterText] = [cut(encodedText(live, from)), cut(encodedText(candidate, to))];
        return push({ path: at, status: "changed", before: beforeText, after: afterText });
      }
      const order = fieldOrder(from, to);
      if (order) push({ path: at, status: "changed", before: order[0], after: order[1] });

      const pairs = walking.get(from) ?? new Set<EncodedType>();
      walking.set(from, pairs.add(to));
      const indexes = reindexed(from, to);
      const ours = children(from, to);
      const theirs = children(to, from);
      for (const key of new Set([...ours.keys(), ...theirs.keys()])) {
        const index = indexes.get(key);
        if (index) push({ path: `${at}.${key}`, status: "changed", before: `index ${index[0]}`, after: `index ${index[1]}` });
        walk(`${at}.${key}`, ours.get(key), theirs.get(key));
      }
      pairs.delete(to);
    };

    walk(path, before, after);
    return found;
  };
}
