// The artifact summing the release gate's runtime-diff-summary job runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'runtime-diff', 'sum-reports.mjs');
const ARTIFACT = 'release-gate-runtime-diff-previewnet-target';
const DIFF = { network: 'previewnet', sdk: [], chains: [] };
const report = (summary) => ({ network: 'previewnet', chains: [], summary });
const BREAKING = report({ breaking: 1, unknown: 0, chains: [{ chain: 'people', breaking: 1 }] });

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const outFile = () => path.join(tmp('gh-out-'), 'out');

// Writes one artifact directory under `root`, one file per `files` key (keys may nest).
// A string body is written raw, anything else as JSON.
function artifact(root, name, files) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, name, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
}

// Runs the script with `args`. `out` is GITHUB_OUTPUT's file, or null for none.
function run(args, { out = null } = {}) {
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  if (out) env.GITHUB_OUTPUT = out;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  const written = out && fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, written };
}

const has = (text, part) => assert.ok(text.includes(part), text);

describe('sum-reports', () => {
  it('sums breaking and unknown over every artifact, walking into subdirectories', () => {
    const root = tmp('sum-reports-');
    artifact(root, ARTIFACT, {
      'nested/diff.json': DIFF,
      'nested/report.json': report({
        breaking: 2,
        unknown: 1,
        chains: [
          { chain: 'people', breaking: 2 },
          { chain: 'relay', breaking: 0, error: 'timeout' },
        ],
      }),
    });
    artifact(root, 'release-gate-runtime-diff-paseo-next-v2-target', { 'diff.json': DIFF });
    const result = run([root], { out: outFile() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, 'breaking=2\nunknown=2\n');
    has(result.stdout, '**2 breaking, 2 unknown** across 2 artifacts.');
    has(result.stdout, `#### ${ARTIFACT}`);
    has(result.stdout, '| people | 2 |');
    has(result.stdout, '| relay | 0 | not diffed: timeout |');
  });

  it('counts an artifact without a usable diff or summary as one unknown, and says why', () => {
    const cases = [
      ['no diff.json: the diff was not captured', {}],
      ['diff.json but no report.json: the report step did not run', { 'diff.json': DIFF }],
      ['report.json has no summary', { 'diff.json': DIFF, 'report.json': { network: 'previewnet', chains: [] } }],
      ['report.json has no summary', { 'diff.json': DIFF, 'report.json': '{ not json' }],
    ];
    for (const [why, files] of cases) {
      const root = tmp('sum-unknown-');
      artifact(root, ARTIFACT, files);
      const result = run([root], { out: outFile() });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.written, 'breaking=0\nunknown=1\n', why);
      has(result.stdout, why);
    }
  });

  it('reports zero for an empty directory or a missing one, and writes no output without GITHUB_OUTPUT', () => {
    const empty = tmp('sum-empty-');
    for (const dir of [empty, path.join(empty, 'missing')]) {
      const result = run([dir], { out: outFile() });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.written, 'breaking=0\nunknown=0\n');
      has(result.stdout, 'Found no runtime diff artifacts');
    }
    const unset = run([empty]);
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(unset.written, null);
  });

  it('counts planned candidates with no artifact directory as unknown, and never a negative count', () => {
    const root = tmp('sum-expected-');
    artifact(root, ARTIFACT, { 'diff.json': DIFF, 'report.json': BREAKING });
    artifact(root, 'release-gate-runtime-diff-paseo-next-v2-target', { 'diff.json': DIFF });
    const cases = [
      // [planned, unknown, note]. Two directories are present, one of them unknown.
      [4, 3, '2 planned candidates have no runtime diff artifact, so they are unknown.'],
      [3, 2, '1 planned candidate has no runtime diff artifact, so it is unknown.'],
      [2, 1, null],
      [1, 1, null],
    ];
    for (const [planned, unknown, note] of cases) {
      const result = run([root, '--expected', String(planned)], { out: outFile() });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.written, `breaking=1\nunknown=${unknown}\n`, `expected ${planned}`);
      if (note) has(result.stdout, note);
      else assert.doesNotMatch(result.stdout, /planned candidate/);
    }
    const none = run([path.join(root, 'missing'), '--expected', '2'], { out: outFile() });
    assert.equal(none.written, 'breaking=0\nunknown=2\n');
  });

  it('escapes pipes and newlines in table cells', () => {
    const root = tmp('sum-escape-');
    artifact(root, ARTIFACT, {
      'diff.json': DIFF,
      'report.json': report({ breaking: 0, unknown: 1, chains: [{ chain: 'a|b', breaking: 0, error: 'first\nsecond' }] }),
    });
    const result = run([root]);
    assert.equal(result.status, 0, result.stderr);
    has(result.stdout, '| a\\|b | 0 | not diffed: first second |');
  });

  it('notes an unreadable SDK on each chain row of its artifact, and counts that artifact unknown', () => {
    const root = tmp('sum-sdk-');
    artifact(root, ARTIFACT, {
      'diff.json': DIFF,
      'report.json': report({ breaking: 0, unknown: 1, sdkError: 'ENOENT: no such file', chains: [{ chain: 'people', breaking: 0 }] }),
    });
    const result = run([root], { out: outFile() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, 'breaking=0\nunknown=1\n');
    has(result.stdout, '| people | 0 | SDK not read: ENOENT: no such file |');
  });

  it('exits 2 on a missing or extra directory argument, an unknown flag, or a bad --expected', () => {
    const root = tmp('sum-args-');
    for (const args of [[], [root, root], [root, '--bogus'], [root, '--expected', '-1'], [root, '--expected', 'x'], [root, '--expected', '1.5']]) {
      assert.equal(run(args).status, 2, args.join(' '));
    }
  });
});
