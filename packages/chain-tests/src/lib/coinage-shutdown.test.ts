import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('shutdown deadline leaves clean exits alone and records leaked resources as failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'coinage-shutdown-'));
  const path = join(root, 'shutdown.json');
  const module = new URL('./coinage-shutdown.ts', import.meta.url).href;
  const run = (leak: boolean) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { armShutdownDeadline } from ${JSON.stringify(module)};
     armShutdownDeadline(${JSON.stringify(path)}, 50);
     ${leak ? 'setInterval(() => {}, 1000);' : ''}`], { timeout: 5000, encoding: 'utf8' });
  try {
    const clean = run(false);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(existsSync(path), false);
    const leaked = run(true);
    assert.equal(leaked.status, 1, leaked.stderr);
    const diagnostic = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(diagnostic.kind, 'harness-shutdown-timeout');
    assert(diagnostic.activeResources.includes('Timeout'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
