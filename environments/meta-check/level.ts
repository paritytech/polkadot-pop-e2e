// How the levels order. Grading keeps the worse of two levels; a verdict compares an
// entry's level on live with its level on the candidate.

import type { Level } from "./types.ts";

/** Missing and Incompatible are equally unusable; Present (name only) counts as a fit. */
export const RANK: Record<Level, number> = {
  Missing: 0,
  Incompatible: 0,
  Partial: 1,
  BackwardsCompatible: 2,
  Present: 2,
  Identical: 3,
};

export const worse = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);
