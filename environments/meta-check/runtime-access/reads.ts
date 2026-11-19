// The runtime accesses in one source file, found in two steps:
//
//   1. fullPath   what an expression stands for, with const aliases replaced by what they hold:
//                 `players.getValue` -> chain.individuality.query.Game?.Players.getValue
//   2. findEntry  the `<kind>.<Pallet>.<entry>` in that path:
//                 -> query:Game.Players on individuality, optional
//
// It parses the file with TypeScript but checks no types: the program exists only so
// the checker can say which declaration a local name refers to.

import ts from "typescript";
import { CHAIN_KEYS, KINDS } from "../selector.ts";
import type { RuntimeAccess } from "./types.ts";

/** An access before the folder scan adds the file path. */
export type Read = Omit<RuntimeAccess, "file">;

/** In `Game?.Players`, `Players` is marked optional. */
interface PathPart {
  name: string;
  optional: boolean;
}

type AccessPath = PathPart[];

// Limit alias expansion so circular references cannot loop.
const MAX_ALIAS_DEPTH = 10;

export function readsIn(fileName: string, text: string): Read[] {
  const { program, file } = singleFileProgram(fileName, text);
  const checker = program.getTypeChecker();
  const reads: Read[] = [];

  const visit = (node: ts.Node): void => {
    if (isInSourceTest(node)) return;
    if (ts.isPropertyAccessExpression(node) && !isInsideLongerAccess(node)) {
      const path = fullPath(checker, node);
      const entry = path && findEntry(path);
      if (entry) reads.push({ ...entry, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reads;
}

/**
 * Expand a dot path through local const aliases. If `players` is an alias for
 * `query.Game.Players`, then `players.getValue` stands for `query.Game.Players.getValue`.
 * Calls and bracket accesses cannot be expanded as paths.
 */
function fullPath(checker: ts.TypeChecker, expression: ts.Expression, aliasDepth = 0): AccessPath | null {
  if (ts.isPropertyAccessExpression(expression)) {
    const before = fullPath(checker, expression.expression, aliasDepth);
    return before && [...before, { name: expression.name.text, optional: expression.questionDotToken !== undefined }];
  }
  // Parentheses, non-null assertions, and casts don't change the path.
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression)) {
    return fullPath(checker, expression.expression, aliasDepth);
  }
  if (ts.isIdentifier(expression)) {
    return aliasedPath(checker, expression, aliasDepth) ?? [{ name: expression.text, optional: false }];
  }
  return null;
}

/**
 * Look up the value assigned to a const alias. Treat `const { query } = chain.individuality`
 * like `const query = chain.individuality.query`. Don't follow `let`: it can be reassigned.
 */
function aliasedPath(checker: ts.TypeChecker, name: ts.Identifier, aliasDepth: number): AccessPath | null {
  if (aliasDepth >= MAX_ALIAS_DEPTH) return null;
  const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0];
  if (!declaration) return null;

  if (ts.isVariableDeclaration(declaration)) {
    if (!isConst(declaration) || !declaration.initializer) return null;
    return fullPath(checker, declaration.initializer, aliasDepth + 1);
  }
  if (ts.isBindingElement(declaration)) {
    const destructured = destructuredNames(declaration);
    if (!destructured || !isConst(destructured.from) || !destructured.from.initializer) return null;
    const assigned = fullPath(checker, destructured.from.initializer, aliasDepth + 1);
    return assigned && [...assigned, ...destructured.names];
  }
  return null;
}

/**
 * Follow the properties picked out by object destructuring. In
 * `const { query: { Game: game } } = chain.individuality`, `game` picks out `query.Game`.
 * Also return the declaration so the caller can find the value being destructured.
 */
function destructuredNames(element: ts.BindingElement): { from: ts.VariableDeclaration; names: AccessPath } | null {
  const names: AccessPath = [];
  let node: ts.Node = element;
  while (ts.isBindingElement(node)) {
    if (!ts.isObjectBindingPattern(node.parent)) return null;
    const key = node.propertyName ?? node.name;
    if (!ts.isIdentifier(key)) return null;
    names.unshift({ name: key.text, optional: false });
    node = node.parent.parent;
  }
  return ts.isVariableDeclaration(node) ? { from: node, names } : null;
}

/**
 * Find the first PAPI-shaped access, such as `query.Game.Players`. The name just
 * before `query` gives the chain if it is a known key: `individuality.query` names
 * the chain, but `api.query` leaves it unknown.
 */
function findEntry(path: AccessPath): Omit<Read, "line"> | null {
  for (let i = 0; i + 2 < path.length; i++) {
    const kind = KINDS.find((k) => k === path[i]?.name);
    const pallet = path[i + 1];
    const entry = path[i + 2];
    if (!kind || !pallet || !entry || !/^[A-Z]/.test(pallet.name)) continue;
    const before = path[i - 1]?.name;
    return {
      selector: `${kind}:${pallet.name}.${entry.name}`,
      chain: CHAIN_KEYS.find((key) => key === before) ?? null,
      optional: pallet.optional || entry.optional,
    };
  }
  return null;
}

/** Give TypeScript just this file so it can resolve local names without following imports. */
function singleFileProgram(fileName: string, text: string): { program: ts.Program; file: ts.SourceFile } {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? file : undefined);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  return { program: ts.createProgram([fileName], options, host), file };
}

function isConst(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/** `if (import.meta.vitest) { ... }`: tests kept inside a source file. */
function isInSourceTest(node: ts.Node): boolean {
  return ts.isIfStatement(node) && node.expression.getText() === "import.meta.vitest";
}

/** Analyze `a.b.c` once, rather than also analyzing its `a.b` prefix. */
function isInsideLongerAccess(node: ts.PropertyAccessExpression): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
}
