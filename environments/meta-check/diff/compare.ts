// Where two types differ, live's (A) against the candidate's (A'), in how they encode.
//
// PAPI does not answer this. Its compatibility check grades two types, but its `Identical`
// treats u16 and u32 alike (both `number`), compact and plain integers alike, and
// AccountId32 and AccountId20 alike (both a string); it lists changes only one level
// down, from one side, and none where the receiving side has more than the sending one.
// Its type checksums erase the same widths, and field order and variant indexes too.
// So this walks the types polkadot-api builds its codecs from (`Var`), with an
// equality of its own: two types are equal when they encode alike, under the same names.

import type { Var } from "@polkadot-api/metadata-builders";
import type MetadataView from "../metadata-view/index.ts";
import type { TypeChange, TypePath } from "./types.ts";

type Variant = Extract<Var, { type: "enum" }>["value"][string];

// Past these, a type name stops being read.
const NAME_DEPTH = 2;
const MAX_NAME = 100;
const MAX_VARIANTS = 6;

/**
 * A type used all over (an XCM location, a call) can change under hundreds of paths. Past
 * this many, the walk stops: one comparison returns at most one more, to say there were more.
 */
export const MAX_TYPE_CHANGES = 100;

// Kept in front of where two cut texts differ.
const MAX_CONTEXT = 20;

const cut = (text: string, max = MAX_NAME): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Both texts cut to length; where that would cut off all they differ in, from just before where they do. */
function cutApart(before: string, after: string): [string, string] {
  if (before === after || cut(before) !== cut(after)) return [cut(before), cut(after)];
  let at = 0;
  while (before[at] === after[at]) at++;
  const around = (text: string) => `…${cut(text.slice(at - MAX_CONTEXT), MAX_NAME - 1)}`;
  return [around(before), around(after)];
}

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
function encodedText(view: MetadataView, type: Var): string {
  const name = (child: Var) => ("id" in child ? typeName(view, child.id as number, NAME_DEPTH - 1) : "…");
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
      // A module error's: how many bytes the variant takes, its pallet's index included.
      return `${variants(Object.keys(type.value))}${type.byteLength === undefined ? "" : ` in ${type.byteLength} bytes`}`;
  }
}

/** A type by its Rust name when it has an id; inline (a call's fields) by how it encodes. */
const fullName = (view: MetadataView, type: Var): string =>
  "id" in type ? typeName(view, type.id as number) : encodedText(view, type);

const describe = (view: MetadataView, type: Var): string => cut(fullName(view, type));

/** What a variant carries, as a type. */
const payload = (variant: Variant): Var => (variant.type === "lookupEntry" ? variant.value : variant);

/** The type itself, where PAPI's lookup left a copy of it with only its id; see `MetadataView.lookup`. */
const shaped = (view: MetadataView, type: Var): Var => ("type" in type ? type : view.lookup((type as { id: number }).id));

/**
 * PAPI makes `(T, T)`, or a tuple struct `Pair(T, T)`, an array `[T; 2]` unless an element
 * or field has doc comments, and a tuple otherwise: a doc comment can turn one into the
 * other. Both encode the elements one after the other, so they compare element by element.
 */
const arrayAndTuple = (a: Var, b: Var): boolean =>
  (a.type === "array" && b.type === "tuple") || (a.type === "tuple" && b.type === "array");

/** A type's children, by the path segment PAPI names them with; an array facing a tuple, by index. */
function children(type: Var, other: Var): Map<string, Var> {
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
function differsInItself(before: Var, after: Var): boolean {
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
function fieldOrder(before: Var, after: Var): [string, string] | null {
  if (before.type !== "struct" || after.type !== "struct") return null;
  const ours = Object.keys(before.value).filter((key) => key in after.value);
  const theirs = Object.keys(after.value).filter((key) => key in before.value);
  return ours.join() === theirs.join() ? null : [`{ ${ours.join(", ")} }`, `{ ${theirs.join(", ")} }`];
}

/** The variants both enums have whose index differs, with both indexes: SCALE encodes the index. */
function reindexed(before: Var, after: Var): Map<string, [number, number]> {
  if (before.type !== "enum" || after.type !== "enum") return new Map();
  return new Map(
    Object.entries(before.value).flatMap(([key, variant]): [string, [number, number]][] => {
      const other = after.value[key];
      return other && other.idx !== variant.idx ? [[key, [variant.idx, other.idx]]] : [];
    }),
  );
}

/**
 * Whether two types encode alike under the same field and variant names. Where the
 * comparison meets a pair it is already comparing, as a recursive type does, it assumes the
 * two equal. An unequal result is remembered. An equal one is remembered only when it rests
 * on no such assumption about a pair further up, which may yet turn out unequal; otherwise
 * it is compared again wherever it is met.
 */
function encodesAlike(live: MetadataView, candidate: MetadataView) {
  const settled = new Map<Var, Map<Var, boolean>>();
  const comparing = new Map<Var, Map<Var, number>>();

  /** `assumedAt`: the shallowest pair still being compared that the result leans on. */
  const visit = (onLive: Var, onCandidate: Var, depth: number): { equal: boolean; assumedAt: number } => {
    const a = shaped(live, onLive);
    const b = shaped(candidate, onCandidate);
    if (a === b) return { equal: true, assumedAt: Infinity };
    const known = settled.get(a)?.get(b);
    if (known !== undefined) return { equal: known, assumedAt: Infinity };
    const at = comparing.get(a)?.get(b);
    if (at !== undefined) return { equal: true, assumedAt: at };

    const open = comparing.get(a) ?? new Map<Var, number>();
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
      const known = settled.get(a) ?? new Map<Var, boolean>();
      settled.set(a, known.set(b, equal));
      return { equal, assumedAt: Infinity };
    }
    return { equal, assumedAt };
  };

  return (a: Var, b: Var) => visit(a, b, 0).equal;
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

  return function changes(path: TypePath, before: Var | null | undefined, after: Var | null | undefined): TypeChange[] {
    const found: TypeChange[] = [];
    // The pairs being walked: a recursive type meets itself again, already being compared.
    const walking = new Map<Var, Set<Var>>();
    const push = (change: TypeChange) => {
      if (found.length <= MAX_TYPE_CHANGES) found.push(change);
    };

    const walk = (at: TypePath, onLive: Var | null | undefined, onCandidate: Var | null | undefined): void => {
      if (found.length > MAX_TYPE_CHANGES) return;
      const from = onLive && shaped(live, onLive);
      const to = onCandidate && shaped(candidate, onCandidate);
      if (!from && !to) return;
      if (!from) return push({ path: at, status: "added", before: null, after: describe(candidate, to as Var) });
      if (!to) return push({ path: at, status: "removed", before: describe(live, from), after: null });
      if (alike(from, to) || walking.get(from)?.has(to)) return;
      if (differsInItself(from, to)) {
        let texts: [string, string] = [fullName(live, from), fullName(candidate, to)];
        // Same name, another encoding: the encodings say what changed.
        if (texts[0] === texts[1]) texts = [encodedText(live, from), encodedText(candidate, to)];
        const [beforeText, afterText] = cutApart(...texts);
        return push({ path: at, status: "changed", before: beforeText, after: afterText });
      }
      const order = fieldOrder(from, to);
      if (order) push({ path: at, status: "changed", before: order[0], after: order[1] });

      const pairs = walking.get(from) ?? new Set<Var>();
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
