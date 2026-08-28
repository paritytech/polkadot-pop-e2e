// A parachain's runtime must fit the relay's max_code_size. Over it, cumulus
// parachain_system rejects the code as TooBig before any migration runs — the
// upgrade fails for a reason that has nothing to do with the runtime's logic.
//
// Read over a raw WebSocket: the gate upgrades before `pnpm install`, so no
// chain library is available yet. max_code_size is the first u32 (LE) of
// ParachainSystem::HostConfiguration.

const HOST_CONFIGURATION =
  '0x45323df7cc47150b3930e2666b0aa313c522231880238a0c56021b8744a00743';

// Same defaults as packages/chain-tests/src/config/networks.ts local-fork.
// The relay has no parachain_system, so it has no cap of this kind.
const ENDPOINTS = {
  'asset-hub': process.env.FORK_ASSET_HUB_WS ?? 'ws://127.0.0.1:10020',
  people: process.env.FORK_PEOPLE_WS ?? 'ws://127.0.0.1:10010',
  bulletin: process.env.FORK_BULLETIN_WS ?? 'ws://127.0.0.1:10030',
};

async function maxCodeSize(url) {
  const ws = new WebSocket(url);
  try {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 20_000);
      ws.onerror = () => { clearTimeout(timer); reject(new Error('connect failed')); };
      ws.onopen = () =>
        ws.send(JSON.stringify({
          id: 1, jsonrpc: '2.0',
          method: 'state_getStorage', params: [HOST_CONFIGURATION],
        }));
      ws.onmessage = (event) => {
        clearTimeout(timer);
        const body = JSON.parse(event.data);
        if (body.error) return reject(new Error(body.error.message));
        resolve(body.result);
      };
    });
    // Absent on a chain without the pallet, and on a parachain before the first
    // validation-data inherent of the session.
    if (!value) return null;
    return Buffer.from(value.slice(2, 10), 'hex').readUInt32LE(0);
  } finally {
    ws.close();
  }
}

// Reads the gate's `chain=wasm` plan on stdin. Exits 1 naming every chain whose
// runtime cannot fit, so one run reports all of them rather than the first.
const plan = await new Promise((resolve) => {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buffer += chunk; });
  process.stdin.on('end', () => resolve(buffer));
});

const { statSync } = await import('node:fs');
let overCap = false;

for (const line of plan.split('\n')) {
  const [chain, wasm] = line.trim().split('=');
  if (!chain || !wasm || !ENDPOINTS[chain]) continue;

  const size = statSync(wasm).size;
  let cap;
  try {
    cap = await maxCodeSize(ENDPOINTS[chain]);
  } catch (error) {
    console.log(`  ${chain.padEnd(14)} ${size} bytes — cap unknown (${error.message})`);
    continue;
  }
  if (cap === null) {
    console.log(`  ${chain.padEnd(14)} ${size} bytes — cap unavailable`);
    continue;
  }

  const verdict = size <= cap ? 'fits' : `OVER BY ${size - cap}`;
  console.log(`  ${chain.padEnd(14)} ${size} bytes, cap ${cap} — ${verdict}`);
  if (size > cap) {
    overCap = true;
    console.log(
      `::error::${chain}: the runtime is ${size} bytes, over the relay's ` +
      `max_code_size of ${cap}. The chain will reject it as TooBig without ` +
      `running any of it, so this is a build-size problem, not a migration or ` +
      `a logic problem. A runtime built with the production profile (lto, ` +
      `codegen-units=1) is far smaller than one built with --release.`,
    );
  }
}

process.exit(overCap ? 1 : 0);
