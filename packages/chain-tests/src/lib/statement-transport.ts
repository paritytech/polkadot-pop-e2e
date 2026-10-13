/**
 * A `StatementTransport` for product-sdk's `StatementStoreClient` outside a
 * host. The client builds the statement (topics, channel, expiry, data); this
 * does the host's part, signing with the attested account's statement key and
 * submitting over the People chain RPC.
 */
import { fromHex } from "@polkadot-api/utils";
import { getWsProvider } from "polkadot-api/ws";
import {
  createLazyClient,
  createPapiStatementStoreAdapter,
  createSr25519Prover,
  deriveSr25519PublicKey,
  signWithSr25519Secret,
} from "@novasamatech/statement-store";
import type {
  StatementSignerWithKey,
  StatementTransport,
} from "@parity/product-sdk-statement-store";

export function createNodeStatementTransport(
  peopleWs: string,
  statementSecret: Uint8Array,
): { transport: StatementTransport; signer: StatementSignerWithKey } {
  const lazyClient = createLazyClient(getWsProvider(peopleWs));
  const adapter = createPapiStatementStoreAdapter(lazyClient);
  const prover = createSr25519Prover(statementSecret);

  const transport: StatementTransport = {
    subscribe(filter, onStatements) {
      const hostFilter =
        filter === "any"
          ? { matchAny: [] }
          : "matchAll" in filter
            ? { matchAll: filter.matchAll.map(fromHex) }
            : { matchAny: filter.matchAny.map(fromHex) };
      const stop = adapter.subscribeStatements(hostFilter, (page) =>
        onStatements(page.statements as Parameters<typeof onStatements>[0]),
      );
      return { unsubscribe: stop };
    },
    async signAndSubmit({ proof: _unsigned, ...statement }) {
      // The prover encodes every key present, so unset optional fields must be absent.
      const fields = Object.fromEntries(Object.entries(statement).filter(([, v]) => v !== undefined));
      const signed = await prover.generateMessageProof(fields);
      if (signed.isErr()) throw signed.error;
      const submitted = await adapter.submitStatement(signed.value);
      if (submitted.isErr()) throw submitted.error;
    },
    destroy() {
      // Let the unsubscribe RPC settle; destroying the client rejects it otherwise.
      setTimeout(() => lazyClient.disconnect(), 1_000);
    },
  };

  const signer: StatementSignerWithKey = {
    publicKey: deriveSr25519PublicKey(statementSecret),
    sign: (message) => signWithSr25519Secret(statementSecret, message),
  };
  return { transport, signer };
}
