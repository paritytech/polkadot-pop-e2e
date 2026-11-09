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

type JsonRpcProvider = Parameters<typeof createLazyClient>[0];

/**
 * Wraps `provider` and resolves `settled()` once no statement_* request is
 * waiting for its answer, or after `timeoutMs`.
 */
function trackStatementRequests(provider: JsonRpcProvider) {
  const waiting = new Set<unknown>();
  const onSettled = new Set<() => void>();
  const tracked: JsonRpcProvider = (onMessage) => {
    const connection = provider((message) => {
      const answered = "id" in message && waiting.delete(message.id);
      // Delivered first: an answer to a subscribe the caller already left makes
      // polkadot-api send its unsubscribe from inside this call.
      onMessage(message);
      if (answered && waiting.size === 0) for (const resolve of onSettled) resolve();
    });
    return {
      send(message) {
        if ("id" in message && message.method.startsWith("statement_")) waiting.add(message.id);
        connection.send(message);
      },
      disconnect: () => connection.disconnect(),
    };
  };
  const settled = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      if (waiting.size === 0) return resolve();
      const done = () => {
        onSettled.delete(done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      onSettled.add(done);
    });
  return { tracked, settled };
}

export function createNodeStatementTransport(
  peopleWs: string,
  statementSecret: Uint8Array,
): { transport: StatementTransport; signer: StatementSignerWithKey } {
  const requests = trackStatementRequests(getWsProvider(peopleWs));
  const lazyClient = createLazyClient(requests.tracked);
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
      // polkadot-api sends the unsubscribe without handling its rejection, so
      // destroying the client before the node answers fails the test run.
      void requests.settled(30_000).then(() => lazyClient.disconnect());
    },
  };

  const signer: StatementSignerWithKey = {
    publicKey: deriveSr25519PublicKey(statementSecret),
    sign: (message) => signWithSr25519Secret(statementSecret, message),
  };
  return { transport, signer };
}
