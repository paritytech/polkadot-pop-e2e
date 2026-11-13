/**
 * Game sign-up, end to end, on a fork: a fresh, funded account with no personhood signs up
 * for a game this suite schedules, through product-sdk's `registerForGame`. The account's
 * prize draw entry is then read back with `readGameSeat`.
 *
 * Fork only: the setup changes the Game's phases and schedules a game with //Alice's sudo key.
 * The gate is `testAccountUri`, which only a fork sets.
 */
import { createECDH } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { fromPapi, readGameSeat, registerForGame } from "@parity/product-sdk-individuality";
import { hostSubmitSignUp } from "@parity/product-sdk-individuality/host";
import { localAirdropVrfSigner } from "@parity/product-sdk-individuality/testing";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { createTestAccount } from "../lib/signer.js";
import {
  assertSudoKey,
  createFreshSr25519Account,
  fundAccount,
  playerFunding,
  prepareGameWithDraw,
  readPhases,
  restorePhases,
  type FreshAccount,
  type GameInfo,
  type GamePhases,
} from "../lib/game-fork.js";
import { getNetworkConfig } from "../config/networks.js";

describe.skipIf(!getNetworkConfig().testAccountUri || !getNetworkConfig().features.game)(
  "Game sign-up flow (fork)",
  () => {
    const tld = getNetworkConfig().tld;
    let peopleClient: PolkadotClient | undefined;
    let peopleApi: PeopleApi | undefined;
    let sudoSigner: CommonSignerTxCreator | undefined;
    let originalPhases: GamePhases | undefined;
    let game: GameInfo | undefined;
    let player: FreshAccount | undefined;

    beforeAll(async () => {
      assertChainHealthy("people");
      ({ client: peopleClient, api: peopleApi } = createPeopleClient(getNetworkConfig().people.ws));
      const sudo = await createTestAccount();
      sudoSigner = sudo.signer;

      // Before the first write: the root key must be //Alice, or the gate's assumption fails.
      await assertSudoKey(peopleApi, sudo.address);

      // Read before the setup changes anything, so afterAll can put them back even if the
      // setup fails part way.
      originalPhases = await readPhases(peopleApi);
      game = await prepareGameWithDraw(peopleApi, sudoSigner);

      player = createFreshSr25519Account();
      const funding = await playerFunding(peopleApi);
      await fundAccount(peopleApi, sudoSigner, player.address, funding);
      console.log(`[game-signup-flow] player ${player.address} funded ${funding} for game ${game.index}`);
    }, 900_000);

    afterAll(async () => {
      try {
        if (peopleApi && sudoSigner && originalPhases) {
          await restorePhases(peopleApi, sudoSigner, originalPhases);
        }
      } finally {
        peopleClient?.destroy();
      }
    }, 600_000);

    it(
      "signs a fresh account up for the running game, with its draw entered",
      async () => {
        if (!peopleApi || !peopleClient || !player || !game) throw new Error("setup did not finish");
        const chain = fromPapi(peopleClient, peopleApi);

        // A P-256 public key, uncompressed (65 bytes), that co-players reach this player with.
        const ecdh = createECDH("prime256v1");
        ecdh.generateKeys();
        const identifierKey = new Uint8Array(ecdh.getPublicKey(undefined, "uncompressed"));
        expect(identifierKey).toHaveLength(65);

        const outcome = await registerForGame(
          chain,
          {
            account: { address: player.address, publicKey: player.publicKey },
            signer: player.signer,
            submit: hostSubmitSignUp,
            signVrf: localAirdropVrfSigner(player.secret).signVrf,
          },
          { tld, identifierKey, drawWait: { maxMs: 90_000 } },
        );
        if (!outcome.ok) throw outcome.error;

        const value = outcome.value;
        console.log(`[game-signup-flow] outcome ${value.kind}: ${JSON.stringify(value.report)}`);
        if (value.kind !== "registered") {
          throw new Error(`sign-up ended as ${value.kind}, not registered`);
        }
        expect(value.route).toBe("deposit");
        expect(value.draws.scheduled, `draws scheduled for game ${game.index}`).toBe(
          game.airdropsScheduled,
        );
        expect(
          value.draws.entered,
          `draws entered ${value.draws.entered} of ${value.draws.scheduled}: ` +
            `kind=${value.draws.kind ?? "none"}, skipped=${value.draws.skipped ?? "none"}`,
        ).toBe(value.draws.scheduled);

        const seat = await readGameSeat(chain, { account: player.address, litePerson: false, tld });
        if (!seat.ok) throw seat.error;
        expect(seat.value.registered).toBe(true);
      },
      300_000,
    );
  },
);
