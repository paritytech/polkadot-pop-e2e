// Turn `artifact:<name>` pins into the file they mean.
//
// A caller that built a runtime in its own run pins the chain to the artifact it
// uploaded — `runtime_people: artifact:e2e-runtime-wasm`. Which file inside that
// artifact is the people runtime is decided by what each blob DECLARES, not by
// what it is called: every runtime carries its spec_name, and the chain we are
// gating reports the same one. So a caller may name its files anything.
//
// `artifact:<name>/<path>` names the file outright, for the rare artifact holding
// two runtimes that declare the same spec_name.

import fs from 'node:fs';
import path from 'node:path';
import { CHAINS, parseReleaseRef } from './release-map.mjs';
import { rpc } from './baseline-scan.mjs';
import { runtimeSpecOf, decompressRuntime } from './wasm-spec.mjs';

/**
 * @param manifest   the candidate manifest, mutated in place.
 * @param io.list    artifact name -> absolute paths of the files in it.
 * @param io.specOf  file -> { specName, compressed }.
 * @param io.liveSpecName  chain -> spec_name that chain reports, or null.
 * @returns notes describing each resolution, for the log.
 */
export async function resolveArtifactPins(manifest, io) {
  const notes = [];
  for (const [chain, entry] of Object.entries(manifest.chains ?? {})) {
    const pin = String(entry?.runtime ?? '');
    if (!pin.startsWith('artifact:')) continue;
    const { artifact, within } = parseReleaseRef(pin);
    const files = io.list(artifact);

    if (within) {
      const hit = files.find((f) => f.endsWith(within));
      if (!hit) {
        throw new Error(
          `${chain}: "${pin}" names ${within}, which is not in artifact ${artifact}. ` +
            `It holds: ${files.map((f) => path.basename(f)).join(', ') || '(nothing)'}`
        );
      }
      entry.runtime = `file:${hit}`;
      notes.push(`  ${chain.padEnd(14)} <- ${hit} (named outright)`);
      continue;
    }

    const expected = await io.liveSpecName(chain);
    if (!expected) {
      throw new Error(
        `${chain}: cannot tell which file in artifact ${artifact} is this chain's runtime, ` +
          `because the chain did not report its spec_name. Name the file with ` +
          `artifact:${artifact}/<path>.`
      );
    }

    const declared = files
      .filter((f) => f.endsWith('.wasm'))
      .map((f) => ({ file: f, ...safeSpec(io, f) }));
    const hits = declared.filter((d) => d.specName === expected);

    if (hits.length === 0) {
      throw new Error(
        `${chain}: nothing in artifact ${artifact} declares spec_name "${expected}", which is ` +
          `what this chain runs. Found: ${
            declared.map((d) => `${path.basename(d.file)} (${d.specName ?? 'unreadable'})`).join(', ') ||
            '(no .wasm files)'
          }`
      );
    }

    // Two files, one runtime: the upgrade takes the compressed blob.
    hits.sort((a, b) => Number(b.compressed) - Number(a.compressed));
    entry.runtime = `file:${hits[0].file}`;
    notes.push(
      `  ${chain.padEnd(14)} <- ${hits[0].file} (declares ${expected}${hits.length > 1 ? ', compressed' : ''})`
    );
  }
  return notes;
}

function safeSpec(io, file) {
  try {
    return io.specOf(file);
  } catch {
    return { specName: null, compressed: false };
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const [manifestPath] = process.argv.slice(2);
  const dirFlag = process.argv.indexOf('--dir');
  const dir = dirFlag === -1 ? null : process.argv[dirFlag + 1];
  const namesOnly = process.argv.includes('--names');
  if (!manifestPath || (!dir && !namesOnly)) {
    console.error('usage: artifact-pins.mjs <manifest.json> (--names | --dir <dir>)');
    process.exit(2);
  }

  // --names: the download pattern this manifest needs, empty when it needs none.
  // Braces because download-artifact takes one pattern and a caller may pin two
  // chains to two different artifacts.
  if (namesOnly) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const names = [
      ...new Set(
        Object.values(m.chains ?? {})
          .map((c) => String(c?.runtime ?? ''))
          .filter((pin) => pin.startsWith('artifact:'))
          .map((pin) => parseReleaseRef(pin).artifact)
      ),
    ];
    console.log(names.length > 1 ? `{${names.join(',')}}` : (names[0] ?? ''));
    process.exit(0);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const walk = (d) =>
    fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
          const full = path.join(d, e.name);
          return e.isDirectory() ? walk(full) : [full];
        })
      : [];

  const notes = await resolveArtifactPins(manifest, {
    // download-artifact unpacks each artifact under its own name; a caller that
    // merged them lands everything at the top, so fall back to the whole tree.
    list: (name) => {
      const own = walk(path.join(dir, name));
      return own.length ? own : walk(dir);
    },
    specOf: (file) => {
      const raw = fs.readFileSync(file);
      return {
        specName: runtimeSpecOf(raw).specName,
        compressed: decompressRuntime(raw).length !== raw.length,
      };
    },
    liveSpecName: async (chain) => {
      const ws = CHAINS[manifest.network]?.[chain]?.ws;
      if (!ws) return null;
      try {
        return (await rpc(ws, 'state_getRuntimeVersion')).specName;
      } catch {
        return null;
      }
    },
  });

  if (notes.length) {
    console.error('Supplied builds:');
    for (const note of notes) console.error(note);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}
