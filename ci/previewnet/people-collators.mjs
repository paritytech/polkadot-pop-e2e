// Extend this isolated snapshot's People authority set to two distinct dev keys.
// Uses the same storage layout as the pinned engine's fork/validators.ts.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('ppn/packages/cli/package.json'));
const { ApiPromise, WsProvider } = await import(pathToFileURL(require.resolve('@polkadot/api').replace('/cjs/', '/')));
const { Keyring } = await import(pathToFileURL(require.resolve('@polkadot/keyring').replace('/cjs/', '/')));
const { cryptoWaitReady } = await import(pathToFileURL(require.resolve('@polkadot/util-crypto').replace('/cjs/', '/')));
const { keyOf } = await import(pathToFileURL(resolve('ppn/packages/cli/dist/fork/codec.js')));
const { paraInjects } = await import(pathToFileURL(resolve('ppn/packages/cli/dist/fork/validators.js')));
const timer = setTimeout(() => { console.error('People collator setup/verification timed out'); process.exit(1); }, 180_000);
await cryptoWaitReady();
const keyring = new Keyring({ type: 'sr25519' });
const names = ['Collator-1502', 'Collator-1502-2'];
const keys = names.map(n => Buffer.from(keyring.addFromUri(`//${n}`).publicKey).toString('hex'));
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:10010'), noInitWarn: true });
const reportPath = 'network-out/people-collators.json';
const { Binary, createClient } = await import(pathToFileURL(require.resolve('polkadot-api')));
const { getWsProvider } = await import(pathToFileURL(require.resolve('polkadot-api/ws-provider/node')));
const { signerFromUri } = await import(pathToFileURL(resolve('ppn/packages/cli/dist/upgrade/signer.js')));
const { TX_OPTIONS, sudidError } = await import(pathToFileURL(resolve('ppn/packages/cli/dist/upgrade/upgrade.js')));
try {
  if (process.argv[2] === 'setup') {
    const authorities = await api.query.aura.authorities();
    if (authorities.length !== 1 || authorities[0].toHex() !== '0x' + keys[0]) {
      throw new Error('Snapshot People authority differs from the expected engine dev key');
    }
    // Change the active and queued sets together; keep both keys registered across sessions.
    const values = {
      [keyOf('CollatorSelection', 'Invulnerables')]: '08' + keys.join(''),
      [keyOf('AuraExt', 'Authorities')]: '08' + keys.join(''),
      [keyOf('Aura', 'Authorities')]: '08' + keys.join(''),
      [keyOf('Session', 'Validators')]: '08' + keys.join(''),
      [keyOf('Session', 'QueuedKeys')]: '08' + keys.map(k => k + k).join(''),
      ...paraInjects(keys[0]), ...paraInjects(keys[1]),
    };
    const entries = Object.entries(values).map(([k, v]) => ['0x' + k, '0x' + v]);
    // PJS's generic signing omits People-specific extension payloads. Reuse the
    // engine's metadata-driven signer and passthrough extension options instead.
    const client = createClient(getWsProvider('ws://127.0.0.1:10010'));
    let blockHash;
    try {
      const dynamic = client.getUnsafeApi();
      const call = dynamic.tx.System.set_storage({ items: entries.map(pair => pair.map(hex => Binary.fromHex(hex))) });
      const tx = dynamic.tx.Sudo.sudo({ call: call.decodedCall });
      blockHash = await new Promise((ok, fail) => {
        const sub = tx.signSubmitAndWatch(signerFromUri('//Alice').signer, TX_OPTIONS).subscribe({
          next(event) {
            if (event.type !== 'finalized') return;
            const inner = sudidError(event.events ?? []);
            if (!event.ok || inner) fail(new Error(inner ?? JSON.stringify(event.dispatchError)));
            else if (!(event.events ?? []).some(e => e.type === 'Sudo' && e.value.type === 'Sudid')) fail(new Error('Missing sudo dispatch result'));
            else ok(event.block.hash);
            sub.unsubscribe();
          },
          error: fail,
        });
      });
    } finally { client.destroy(); }
    const header = await api.rpc.chain.getHeader(blockHash);
    const at = await api.at(blockHash);
    const actual = (await at.query.aura.authorities()).map(k => k.toHex());
    if (JSON.stringify(actual) !== JSON.stringify(keys.map(k => '0x' + k))) throw new Error('Authority readback mismatch');
    const report = { names, keys: actual, setup_block: header.number.toNumber(), setup_hash: blockHash };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } else if (process.argv[2] === 'verify') {
    const report = JSON.parse(readFileSync(reportPath));
    const lastHash = await api.rpc.chain.getFinalizedHead();
    const last = (await api.rpc.chain.getHeader(lastHash)).number.toNumber();
    const counts = Object.fromEntries(names.map(n => [n, 0]));
    for (let n = report.setup_block + 1; n <= last; n++) {
      const hash = await api.rpc.chain.getBlockHash(n);
      const header = await api.rpc.chain.getHeader(hash);
      const digest = header.digest.logs.find(d => d.isPreRuntime && d.asPreRuntime[0].toHex() === '0x61757261');
      if (!digest) throw new Error(`No Aura slot in block ${n}`);
      const slot = Buffer.from(digest.asPreRuntime[1].toU8a(true)).readBigUInt64LE();
      // Read only the historical authority set; api.at decorates a full API for
      // every block and retains unnecessary metadata during long stress runs.
      const encoded = await api.rpc.state.getStorage(api.query.aura.authorities.key(), header.parentHash);
      if (encoded.isNone) throw new Error(`Missing Aura authorities before block ${n}`);
      const authorities = api.createType('Vec<AccountId32>', encoded.unwrap());
      const author = authorities[Number(slot % BigInt(authorities.length))].toHex();
      const index = report.keys.indexOf(author);
      if (index < 0) throw new Error(`Unexpected author ${author}`);
      counts[names[index]]++;
    }
    if (Object.values(counts).some(n => n === 0)) throw new Error(`Not both collators authored finalised blocks: ${JSON.stringify(counts)}`);
    report.authored_finalized_blocks = counts;
    report.last_verified_block = last;
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } else { throw new Error('Expected setup or verify'); }
} finally {
  await api.disconnect();
  clearTimeout(timer);
}
