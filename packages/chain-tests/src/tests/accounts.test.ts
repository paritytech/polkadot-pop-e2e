/**
 * Everyday account operations on Asset Hub that wallets and products build on: a balance
 * transfer, a call made through a proxy, and a 2-of-3 multisig call. Each signs, submits and
 * waits for finality on a real node. The extra accounts are derived from the test account
 * (`//pop-e2e-…`), so they stay the same across runs and the test account tops them up.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, Binary, type PolkadotClient, type SS58String } from "polkadot-api";
import { getMultisigAccountId, sortMultisigSignatories } from "@polkadot-api/substrate-bindings";
import { toHex } from "@polkadot-api/utils";
import { MultiAddress } from "@pop-e2e/papi";
import { createSystemAssetHubClient, type SystemAssetHubApi } from "../lib/client.js";
import { createTestAccount, type TestAccount } from "../lib/signer.js";
import { submitFinalized } from "../lib/finalized-tx.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

const accountId = AccountId();

/** Compares addresses whatever their SS58 prefix. */
const isSameAccount = (left: SS58String, right: SS58String) =>
  toHex(accountId.enc(left)) === toHex(accountId.enc(right));

describe.skipIf(!getNetworkConfig().features.systemFlows)("Accounts: Asset Hub transfers, proxy and multisig", () => {
  let client: PolkadotClient;
  let api: SystemAssetHubApi;
  let funder: TestAccount;
  let existentialDeposit: bigint;
  // The balance a derived account maintains to pay for a handful of extrinsics.
  let feeBudget: bigint;

  async function readFreeBalance(address: SS58String): Promise<bigint> {
    return (await api.query.System.Account.getValue(address)).data.free;
  }

  /** Tops `account` up from the test account when its free balance is below `minimum`. */
  async function fund(account: TestAccount, minimum: bigint): Promise<void> {
    const free = await readFreeBalance(account.address);
    if (free >= minimum) return;
    const transfer = api.tx.Balances.transfer_keep_alive({
      dest: MultiAddress.Id(account.address),
      value: minimum - free,
    });
    await submitFinalized(transfer, funder.signer);
    console.log(`[accounts] Funded ${account.address} with ${minimum - free}`);
  }

  beforeAll(async () => {
    assertChainHealthy("asset-hub");
    const network = getNetworkConfig();
    console.log(`[accounts] Network: ${network.name}`);
    console.log(`[accounts] Asset Hub: ${network.assetHub.ws}`);

    ({ client, api } = createSystemAssetHubClient(network.assetHub.ws));
    funder = await createTestAccount();
    existentialDeposit = await api.constants.Balances.ExistentialDeposit();
    const transferFee = await api.tx.Balances.transfer_keep_alive({
      dest: MultiAddress.Id(funder.address),
      value: existentialDeposit,
    }).getEstimatedFees(funder.signer);
    feeBudget = 20n * transferFee;
    console.log(`[accounts] Test account: ${funder.address}, ED ${existentialDeposit}, fee budget ${feeBudget}`);
  });

  afterAll(() => {
    client?.destroy();
  });

  it("transfers a balance between two accounts derived from the test account", async () => {
    const sender = await createTestAccount("//pop-e2e-transfer-sender");
    const recipient = await createTestAccount("//pop-e2e-transfer-recipient");
    const amount = 2n * existentialDeposit;
    await fund(sender, existentialDeposit + amount + feeBudget);
    const before = await readFreeBalance(recipient.address);

    const result = await submitFinalized(
      api.tx.Balances.transfer_keep_alive({ dest: MultiAddress.Id(recipient.address), value: amount }),
      sender.signer,
    );
    console.log(`[accounts] Transfer finalized in block #${result.block.number}`);

    const [{ payload: transfer }] = api.event.Balances.Transfer.filter(result.events);
    expect(isSameAccount(transfer.from, sender.address)).toBe(true);
    expect(isSameAccount(transfer.to, recipient.address)).toBe(true);
    expect(transfer.amount).toBe(amount);
    expect(await readFreeBalance(recipient.address)).toBe(before + amount);
  });

  it("adds a proxy, makes a call through it and removes it", async () => {
    const delegate = await createTestAccount("//pop-e2e-proxy");
    await fund(delegate, existentialDeposit + feeBudget);
    const proxyArgs = { delegate: MultiAddress.Id(delegate.address), proxy_type: { type: "Any" as const, value: undefined }, delay: 0 };

    // A run that failed between adding and removing leaves the proxy behind.
    const [existing] = await api.query.Proxy.Proxies.getValue(funder.address);
    if (existing.some((entry) => isSameAccount(entry.delegate, delegate.address))) {
      await submitFinalized(api.tx.Proxy.remove_proxy(proxyArgs), funder.signer);
    }

    const addProxyResult = await submitFinalized(api.tx.Proxy.add_proxy(proxyArgs), funder.signer);
    expect(api.event.Proxy.ProxyAdded.filter(addProxyResult.events)).toHaveLength(1);

    const remark = Binary.fromText(`pop-e2e-proxy-${Date.now()}`);
    const proxyCallResult = await submitFinalized(
      api.tx.Proxy.proxy({
        real: MultiAddress.Id(funder.address),
        force_proxy_type: undefined,
        call: api.tx.System.remark_with_event({ remark }).decodedCall,
      }),
      delegate.signer,
    );
    const [{ payload: proxyExecutionEvent }] = api.event.Proxy.ProxyExecuted.filter(proxyCallResult.events);
    expect(proxyExecutionEvent.result.success).toBe(true);
    // The call ran as the proxied account, not as the delegate that signed it.
    const [{ payload: remarkEvent }] = api.event.System.Remarked.filter(proxyCallResult.events);
    expect(isSameAccount(remarkEvent.sender, funder.address)).toBe(true);
    console.log(`[accounts] Proxy call finalized in block #${proxyCallResult.block.number}`);

    const removeProxyResult = await submitFinalized(api.tx.Proxy.remove_proxy(proxyArgs), funder.signer);
    expect(api.event.Proxy.ProxyRemoved.filter(removeProxyResult.events)).toHaveLength(1);
  });

  it("executes a call once two of three multisig signatories approve it", async () => {
    const second = await createTestAccount("//pop-e2e-multisig-2");
    const third = await createTestAccount("//pop-e2e-multisig-3");
    await fund(second, existentialDeposit + feeBudget);
    const threshold = 2;
    const signatories = [funder, second, third];
    const multisig = accountId.dec(
      getMultisigAccountId({ threshold, signatories: signatories.map((account) => account.signer.publicKey) }),
    );
    const getOtherSignatories = (signer: TestAccount) =>
      sortMultisigSignatories(signatories.filter((account) => account !== signer).map((account) => account.signer.publicKey))
        .map((publicKey) => accountId.dec(publicKey));

    // A distinct remark per run, so a pending operation from a failed run doesn't collide.
    const call = api.tx.System.remark_with_event({ remark: Binary.fromText(`pop-e2e-multisig-${Date.now()}`) });
    const callWeight = (await call.getPaymentInfo(funder.signer)).weight;

    const openMultisigResult = await submitFinalized(
      api.tx.Multisig.as_multi({
        threshold,
        other_signatories: getOtherSignatories(funder),
        maybe_timepoint: undefined,
        call: call.decodedCall,
        max_weight: callWeight,
      }),
      funder.signer,
    );
    const [{ payload: newMultisigEvent }] = api.event.Multisig.NewMultisig.filter(openMultisigResult.events);
    expect(isSameAccount(newMultisigEvent.multisig, multisig)).toBe(true);
    // The timepoint comes from storage: Asset Hub may count it in relay blocks, not its own.
    const pending = await api.query.Multisig.Multisigs.getValue(multisig, newMultisigEvent.call_hash);
    expect(pending).toBeDefined();

    const approveMultisigResult = await submitFinalized(
      api.tx.Multisig.as_multi({
        threshold,
        other_signatories: getOtherSignatories(second),
        maybe_timepoint: pending!.when,
        call: call.decodedCall,
        max_weight: callWeight,
      }),
      second.signer,
    );
    const [{ payload: multisigExecutionEvent }] = api.event.Multisig.MultisigExecuted.filter(approveMultisigResult.events);
    expect(multisigExecutionEvent.call_hash).toBe(newMultisigEvent.call_hash);
    expect(multisigExecutionEvent.result.success).toBe(true);
    const [{ payload: remarkEvent }] = api.event.System.Remarked.filter(approveMultisigResult.events);
    expect(isSameAccount(remarkEvent.sender, multisig)).toBe(true);
    console.log(`[accounts] Multisig ${multisig} executed in block #${approveMultisigResult.block.number}`);
  });
});
