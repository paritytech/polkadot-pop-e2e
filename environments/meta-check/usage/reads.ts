// The chain entries one source file reads through a polkadot-api typed (or unsafe) API:
// `chain.individuality.query.Game.Players`, `api.tx.Coinage.transfer`, and the same
// through local aliases such as `const query = chain.individuality.query.Game` or
// `const { query } = chain.individuality`.
//
// It parses the file with TypeScript but checks no types: the program exists only so
// the checker can say which declaration a local name refers to.

import ts from "typescript";
import { CHAIN_KEYS } from "../selector.ts";
import type { ChainKey, Kind, Selector } from "../types.ts";

export interface Read {
  selector: Selector;
  /** The chain-client key the read goes through; null when the chain is not visible. */
  chain: ChainKey | null;
  /** Read with `?.` on the pallet or the entry: the code copes with the entry being absent. */
  optional: boolean;
  line: number;
}

/** One name in an access path, and whether it was reached with `?.`. */
interface Segment {
  name: string;
  optional: boolean;
}

/** The API word in an access chain, and the kind of entry it reads. */
const KIND: Record<string, Kind> = {
  query: "query",
  tx: "tx",
  constants: "constant",
  apis: "api",
  event: "event",
  view: "view",
};

// An alias of an alias of ... stops here, so a cycle cannot loop.
const MAX_ALIAS_DEPTH = 10;

/** A program over this one file alone: no libraries, no imports followed. */
function singleFileProgram(fileName: string, text: string): { program: ts.Program; file: ts.SourceFile } {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? file : undefined);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  return { program: ts.createProgram([fileName], options, host), file };
}

/** `a.b?.c!.d` -> its identifier root and the segments after it. Null when it starts at a call or similar. */
function accessChain(expression: ts.Expression): { root: ts.Identifier; segments: Segment[] } | null {
  const segments: Segment[] = [];
  let current = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift({ name: current.name.text, optional: current.questionDotToken !== undefined });
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      return { root: current, segments };
    } else {
      return null;
    }
  }
}

/** `{ query }` or `{ query: q }` in `const { query } = chain.individuality`: the names it takes, outermost first. */
function bindingNames(element: ts.BindingElement): { declaration: ts.VariableDeclaration; segments: Segment[] } | null {
  const segments: Segment[] = [];
  let node: ts.Node = element;
  while (ts.isBindingElement(node)) {
    if (!ts.isObjectBindingPattern(node.parent)) return null; // array destructuring
    const key = node.propertyName ?? node.name;
    if (!ts.isIdentifier(key)) return null;
    segments.unshift({ name: key.text, optional: false });
    node = node.parent.parent;
  }
  return ts.isVariableDeclaration(node) ? { declaration: node, segments } : null;
}

const isConst = (declaration: ts.VariableDeclaration): boolean =>
  (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;

/**
 * The full access path an identifier stands for: `query` declared as
 * `const query = chain.individuality.query` is `[chain, individuality, query]`. A name
 * that is not a const alias of an access chain stands for itself.
 */
function resolve(checker: ts.TypeChecker, root: ts.Identifier, depth = 0): Segment[] {
  const itself = [{ name: root.text, optional: false }];
  const declaration = checker.getSymbolAtLocation(root)?.declarations?.[0];
  if (!declaration || depth >= MAX_ALIAS_DEPTH) return itself;

  let source: ts.Expression | undefined;
  let taken: Segment[] = [];
  if (ts.isVariableDeclaration(declaration) && isConst(declaration)) {
    source = declaration.initializer;
  } else if (ts.isBindingElement(declaration)) {
    const binding = bindingNames(declaration);
    if (binding && isConst(binding.declaration)) {
      source = binding.declaration.initializer;
      taken = binding.segments;
    }
  }
  const chain = source && accessChain(source);
  if (!chain) return itself;
  return [...resolve(checker, chain.root, depth + 1), ...chain.segments, ...taken];
}

/** The first `<kind>.<Pallet>.<name>` in a path, and the chain key just before it. */
function match(path: Segment[]): Omit<Read, "line"> | null {
  for (let i = 0; i + 2 < path.length; i++) {
    const kind = KIND[path[i]?.name ?? ""];
    const group = path[i + 1];
    const name = path[i + 2];
    if (!kind || !group || !name || !/^[A-Z]/.test(group.name)) continue;
    const before = path[i - 1]?.name;
    return {
      selector: `${kind}:${group.name}.${name.name}`,
      chain: CHAIN_KEYS.find((key) => key === before) ?? null,
      optional: group.optional || name.optional,
    };
  }
  return null;
}

/** `if (import.meta.vitest) { ... }`: tests kept inside a source file. */
const isInSourceTest = (node: ts.Node): boolean =>
  ts.isIfStatement(node) && node.expression.getText() === "import.meta.vitest";

/** `a.b.c` inside `a.b.c.d`: only the outermost access of a chain is read. */
const isInnerAccess = (node: ts.PropertyAccessExpression): boolean =>
  ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;

export function readsIn(fileName: string, text: string): Read[] {
  const { program, file } = singleFileProgram(fileName, text);
  const checker = program.getTypeChecker();
  const reads: Read[] = [];

  const visit = (node: ts.Node): void => {
    if (isInSourceTest(node)) return;
    if (ts.isPropertyAccessExpression(node) && !isInnerAccess(node)) {
      const chain = accessChain(node);
      const found = chain && match([...resolve(checker, chain.root), ...chain.segments]);
      if (found) reads.push({ ...found, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reads;
}
