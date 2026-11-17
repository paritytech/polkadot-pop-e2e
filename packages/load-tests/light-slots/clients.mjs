// Starts `count` light clients, each its own smoldot with its own network identity, against the
// chain spec at `specPath` with `bootNodes`, and prints how many have at least one peer and
// how many peers each has, 40 s and 80 s after the last one started.
// Usage: node clients.mjs <spec> <count> <bootnode multiaddr>...
import { readFileSync } from "node:fs";
import { start } from "smoldot";

const [specPath, countText, ...bootNodes] = process.argv.slice(2);
const count = Number(countText);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
spec.bootNodes = bootNodes;
const specText = JSON.stringify(spec);

const chains = [];
for (let index = 0; index < count; index++) {
  const client = start({ maxLogLevel: 1 });
  chains.push(await client.addChain({ chainSpec: specText }));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function readPeerCount(chain, id) {
  chain.sendJsonRpc(JSON.stringify({ jsonrpc: "2.0", id, method: "system_peers", params: [] }));
  for (;;) {
    const reply = JSON.parse(await chain.nextJsonRpcResponse());
    if (reply.id !== id) continue;
    if (reply.error) throw new Error(`system_peers: ${reply.error.message}`);
    return reply.result.length;
  }
}

for (const seconds of [40, 40]) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const peerCounts = await Promise.all(chains.map((chain, index) => readPeerCount(chain, index + 1)));
  const clientsByPeers = {};
  for (const peers of peerCounts) clientsByPeers[peers] = (clientsByPeers[peers] ?? 0) + 1;
  const clientsWithPeer = peerCounts.filter((peers) => peers > 0).length;
  console.log(`clients ${count}: with a peer ${clientsWithPeer}, without ${count - clientsWithPeer}; clients by number of peers ${JSON.stringify(clientsByPeers)}`);
}
process.exit(0);
