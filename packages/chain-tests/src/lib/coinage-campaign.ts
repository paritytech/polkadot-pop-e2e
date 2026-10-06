import assert from 'node:assert/strict';
export const scenarios = ['merchant', 'quota', 'offboard', 'full-flow'] as const;
export const configurations = [
  { actors: 100, mode: 'burst', pool: 'default', poolTransactions: null },
  { actors: 1000, mode: 'burst', pool: 'default', poolTransactions: null },
  { actors: 10000, mode: 'burst', pool: 'default', poolTransactions: null },
  { actors: 10000, mode: 'paced', pool: 'default', poolTransactions: null },
  { actors: 10000, mode: 'burst', pool: 'enlarged', poolTransactions: 11000 },
  { actors: 20000, mode: 'burst', pool: 'enlarged', poolTransactions: 22000 },
] as const;
export const campaign = scenarios.flatMap(scenario => configurations.map((configuration, i) =>
  ({ id: `${scenario}-${i + 1}`, scenario, ...configuration })));
export function groups(count: number, mode: string): number[][] {
  assert(Number.isInteger(count) && count > 0);
  assert(mode === 'burst' || mode === 'paced');
  assert(mode !== 'paced' || count === 10000);
  const ids = Array.from({ length: count }, (_, i) => i);
  return mode === 'paced' ? [ids.slice(0, 8000), ids.slice(8000)] : [ids];
}
/** Explicit test model of the documented native policy, not execution of native code. */
export function recyclingDecision(input: {
  platform: 'android' | 'ios'; limit: number; remaining: number;
  age: number; maximumAge: number; discretionary: boolean; readFailed?: boolean;
}) {
  const forcedAge = input.platform === 'ios' ? 14 : input.maximumAge - 2;
  if (input.readFailed && input.platform === 'ios') return { action: 'abort', forcedAge, low: null };
  const low = !input.readFailed && input.remaining * 5 <= input.limit;
  return { action: input.age >= forcedAge ? 'forced-load' : input.discretionary && !low ? 'discretionary-load' : 'retain', forcedAge, low };
}
