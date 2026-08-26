import { createClient, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  paseo,
  bulletin,
  people,
  paseoNextAssetHub,
  paseoNextBulletin,
  paseoNextPeople,
  previewAssetHub,
  previewBulletin,
  previewPeople,
} from "@pop-e2e/papi";
import { getNetworkConfig } from "../config/networks.js";

/**
 * Pallet matrix (verified by grepping each generated descriptor's .d.ts):
 *
 *   Bulletin variants (paseo / paseoNext / preview):
 *     `TransactionStorage` + `TransactionStorageApi` on all three.
 *     → uniform shape; one alias is honest.
 *
 *   People variants (paseo / paseoNext / preview):
 *     `Members` + `Resources` on all three.
 *     → uniform shape; one alias is honest.
 *
 *   AssetHub variants:
 *     `paseo`          — Revive + ReviveApi only.
 *     `paseoNext..` —    + Pgas, MembersSubscriber, PgasAllowance, ...
 *     `previewAssetHub`— + Pgas, MembersSubscriber, PgasAllowance, ...
 *     → NOT uniform. We keep the union as a discriminated type and force
 *       callers that need PGAS to assert via `assertRichAssetHub` so the
 *       cast is at one auditable site rather than scattered everywhere.
 */
export type BulletinApi = TypedApi<typeof previewBulletin>;
export type PeopleApi = TypedApi<typeof previewPeople>;

/** Asset Hub on networks WITH pallet-pgas (previewnet, paseo-next-v2). */
export type RichAssetHubApi = TypedApi<typeof previewAssetHub>;
/** Asset Hub on networks WITHOUT pallet-pgas (paseo-next). */
export type LegacyAssetHubApi = TypedApi<typeof paseo>;
/** Union returned by `createAssetHubClient` — narrow with `assertRichAssetHub`. */
export type AssetHubApi = RichAssetHubApi | LegacyAssetHubApi;

/**
 * Narrows `AssetHubApi` to `RichAssetHubApi` for downstream code that
 * touches Pgas/MembersSubscriber. Source of truth is `network.features.pgas`
 * in config/networks.ts — the same flag that gates the test in `it.skipIf`.
 *
 * Why not introspect `api.tx` at runtime? PAPI 2.x serves `tx` (and `query`,
 * `constants`, ...) through a lazy Proxy that returns a value for *any*
 * property name on access, so `"Pgas" in api.tx` is always false even on
 * Asset Hubs that have the pallet. The descriptor + network config are the
 * authoritative pair we picked at construction, so we route through them.
 */
export function assertRichAssetHub(api: AssetHubApi): asserts api is RichAssetHubApi {
  if (!getNetworkConfig().features.pgas) {
    throw new Error(
      "Asset Hub doesn't expose pallet-pgas — gate this code on `network.features.pgas`",
    );
  }
}

type AssetHubDescriptor =
  | typeof paseo
  | typeof paseoNextAssetHub
  | typeof previewAssetHub;
type BulletinDescriptor =
  | typeof bulletin
  | typeof paseoNextBulletin
  | typeof previewBulletin;
type PeopleDescriptor =
  | typeof people
  | typeof paseoNextPeople
  | typeof previewPeople;

export interface DescriptorTriple {
  assetHub: AssetHubDescriptor;
  bulletin: BulletinDescriptor;
  people: PeopleDescriptor;
}

export function descriptorsForNetwork(): DescriptorTriple {
  switch (process.env.NETWORK) {
    case "previewnet":
      return { assetHub: previewAssetHub, bulletin: previewBulletin, people: previewPeople };
    case "paseo-next-v2":
      return { assetHub: paseoNextAssetHub, bulletin: paseoNextBulletin, people: paseoNextPeople };
    default:
      return { assetHub: paseo, bulletin, people };
  }
}

export function createAssetHubClient(ws: string): {
  client: PolkadotClient;
  api: AssetHubApi;
} {
  const client = createClient(getWsProvider(ws));
  const descriptor = descriptorsForNetwork().assetHub;
  // The `as` is honest: we know which descriptor we picked but the union
  // in the return type forces callers to discriminate before reaching for
  // pallet-specific surface.
  const api =
    descriptor === paseo
      ? (client.getTypedApi(descriptor) as LegacyAssetHubApi)
      : (client.getTypedApi(descriptor) as RichAssetHubApi);
  return { client, api };
}

export function createBulletinClient(ws: string): {
  client: PolkadotClient;
  api: BulletinApi;
} {
  const client = createClient(getWsProvider(ws));
  // Pallet shape is identical across all three Bulletin variants.
  const api = client.getTypedApi(descriptorsForNetwork().bulletin) as BulletinApi;
  return { client, api };
}

export function createPeopleClient(ws: string): {
  client: PolkadotClient;
  api: PeopleApi;
} {
  const client = createClient(getWsProvider(ws));
  // Pallet shape is identical across all three People variants.
  const api = client.getTypedApi(descriptorsForNetwork().people) as PeopleApi;
  return { client, api };
}
