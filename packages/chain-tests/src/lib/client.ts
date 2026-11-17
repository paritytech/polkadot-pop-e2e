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
  westendRelay,
  westendAssetHub,
  westendPeople,
} from "@pop-e2e/papi";
import { getNetworkConfig, networkKey } from "../config/networks.js";

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
 *   `westendPeople` has none of the Individuality pallets; the tests that
 *   touch them skip on westend through its features.
 *
 *   AssetHub variants:
 *     `paseo`          — no `Pgas`, no `MembersSubscriber`.
 *     `westendAssetHub`— no `Pgas`, no `MembersSubscriber`; the system-flow tests
 *                       type it on its own (`SystemAssetHubApi`).
 *     `paseoNext..` —    + Pgas, MembersSubscriber, PgasAllowance, ...
 *     `previewAssetHub`— + Pgas, MembersSubscriber, PgasAllowance, ...
 *     → NOT uniform. We keep the union as a discriminated type and force
 *       callers that need PGAS to assert via `assertRichAssetHub` so the
 *       cast is at one auditable site rather than scattered everywhere.
 *
 *   Relay: only `westendRelay`, for the networks with `features.systemFlows`.
 */
export type BulletinApi = TypedApi<typeof previewBulletin>;
export type PeopleApi = TypedApi<typeof previewPeople>;

/** Asset Hub on networks WITH pallet-pgas (previewnet, paseo-next-v2). */
export type RichAssetHubApi = TypedApi<typeof previewAssetHub>;
/** Asset Hub where the suite doesn't run the PGAS flows (`features.pgas` false: devnet, westend). */
export type LegacyAssetHubApi = TypedApi<typeof paseo>;
export type RelayApi = TypedApi<typeof westendRelay>;
/** Westend's Asset Hub, which the system-flow tests run on (`features.systemFlows`). */
export type SystemAssetHubApi = TypedApi<typeof westendAssetHub>;
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
  | typeof westendAssetHub
  | typeof paseoNextAssetHub
  | typeof previewAssetHub;
type BulletinDescriptor =
  | typeof bulletin
  | typeof paseoNextBulletin
  | typeof previewBulletin;
type PeopleDescriptor =
  | typeof people
  | typeof westendPeople
  | typeof paseoNextPeople
  | typeof previewPeople;

export interface DescriptorTriple {
  assetHub: AssetHubDescriptor;
  bulletin: BulletinDescriptor | null;
  people: PeopleDescriptor;
}

export function descriptorsForNetwork(): DescriptorTriple {
  switch (networkKey()) {
    case "previewnet":
      return { assetHub: previewAssetHub, bulletin: previewBulletin, people: previewPeople };
    case "paseo-next-v2":
      return { assetHub: paseoNextAssetHub, bulletin: paseoNextBulletin, people: paseoNextPeople };
    case "westend":
      return { assetHub: westendAssetHub, bulletin: null, people: westendPeople };
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
  const api = getNetworkConfig().features.pgas
    ? (client.getTypedApi(descriptor) as RichAssetHubApi)
    : (client.getTypedApi(descriptor) as LegacyAssetHubApi);
  return { client, api };
}

export function createSystemAssetHubClient(ws: string): {
  client: PolkadotClient;
  api: SystemAssetHubApi;
} {
  if (!getNetworkConfig().features.systemFlows) throw new Error(`${networkKey()} doesn't run the system flows`);
  const client = createClient(getWsProvider(ws));
  return { client, api: client.getTypedApi(westendAssetHub) };
}

export function createRelayClient(ws: string): {
  client: PolkadotClient;
  api: RelayApi;
} {
  if (!getNetworkConfig().features.systemFlows) throw new Error(`${networkKey()} doesn't run the system flows`);
  const client = createClient(getWsProvider(ws));
  return { client, api: client.getTypedApi(westendRelay) };
}

export function createBulletinClient(ws: string): {
  client: PolkadotClient;
  api: BulletinApi;
} {
  const descriptor = descriptorsForNetwork().bulletin;
  if (!descriptor) throw new Error(`${networkKey()} doesn't run Bulletin`);
  const client = createClient(getWsProvider(ws));
  // Pallet shape is identical across all three Bulletin variants.
  const api = client.getTypedApi(descriptor) as BulletinApi;
  return { client, api };
}

export function createPeopleClient(ws: string): {
  client: PolkadotClient;
  api: PeopleApi;
} {
  const client = createClient(getWsProvider(ws));
  // Members/Resources are identical across the PoP People variants; westend has neither.
  const api = client.getTypedApi(descriptorsForNetwork().people) as PeopleApi;
  return { client, api };
}
