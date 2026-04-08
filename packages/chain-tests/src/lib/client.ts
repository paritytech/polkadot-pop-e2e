import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { paseo, bulletin, people } from "@polkadot-api/descriptors";

export function createAssetHubClient(ws: string) {
  const client = createClient(getWsProvider(ws));
  const api = client.getTypedApi(paseo);
  return { client, api };
}

export function createBulletinClient(ws: string) {
  const client = createClient(withPolkadotSdkCompat(getWsProvider(ws)));
  const api = client.getTypedApi(bulletin);
  return { client, api };
}

export function createPeopleClient(ws: string) {
  const client = createClient(getWsProvider(ws));
  const api = client.getTypedApi(people);
  return { client, api };
}
