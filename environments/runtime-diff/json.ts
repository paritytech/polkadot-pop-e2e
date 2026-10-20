// Parsed JSON and decoded SCALE values are `unknown` until a check says what they are.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readJson = (text: string): unknown => JSON.parse(text);

export const stringOr = <T>(value: unknown, fallback: T): string | T => (typeof value === "string" ? value : fallback);
