// The artifact summing the release gate's runtime-diff-summary job runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'runtime-diff', 'sum-reports.mjs');

const write = (root, rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};

const reportWith = (summary) => ({ network: 'previewnet', chains: [], summary });

// Runs the script on `root`. `output` is GITHUB_OUTPUT's file, or null for none.
function run(root, output, extra = []) {
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  if (output) env.GITHUB_OUTPUT = output;
  const out = spawnSync(process.execPath, [SCRIPT, root, ...extra], { encoding: 'utf8', env });
  const written = output && fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : null;
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, written };
}

describe('sum-reports', () => {
  it('sums breaking and unknown over every artifact, walking into subdirectories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-reports-'));
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-out-')), 'out');
    // Two breaking entries on people, one unknown chain; the report sits one level down.
    write(root, 'release-gate-runtime-diff-previewnet-target/nested/report.json', reportWith({
      breaking: 2,
      unknown: 1,
      chains: [
        { chain: 'people', breaking: 2 },
        { chain: 'relay', breaking: 0, error: 'timeout' },
      ],
    }));
    write(root, 'release-gate-runtime-diff-previewnet-target/nested/diff.json', { network: 'previewnet', sdk: [], chains: [] });
    // A diff.json with no report.json: the report step did not run. Unknown.
    write(root, 'release-gate-runtime-diff-paseo-next-v2-target/diff.json', { network: 'paseo-next-v2', sdk: [], chains: [] });
    // An artifact with nothing in it: no diff was captured. Unknown.
    fs.mkdirSync(path.join(root, 'release-gate-runtime-diff-devnet-target'));
    // A candidate whose report has no summary (an older report step). Unknown.
    write(root, 'release-gate-runtime-diff-paseo-next-v2-cross/diff.json', { network: 'paseo-next-v2', sdk: [], chains: [] });
    write(root, 'release-gate-runtime-diff-paseo-next-v2-cross/report.json', { network: 'paseo-next-v2', chains: [] });

    const result = run(root, out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, 'breaking=2\nunknown=4\n');
    assert.match(result.stdout, /\*\*2 breaking, 4 unknown\*\* across 4 artifacts/);
    assert.match(result.stdout, /#### release-gate-runtime-diff-previewnet-target/);
    assert.match(result.stdout, /\| people \| 2 \|/);
    assert.match(result.stdout, /\| relay \| 0 \| not diffed: timeout \|/);
    assert.match(result.stdout, /no diff\.json: the diff was not captured/);
    assert.match(result.stdout, /diff\.json but no report\.json/);
    assert.match(result.stdout, /report\.json has no summary/);
  });

  it('reports zero for an empty directory and when no directory exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-empty-'));
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-out-')), 'out');
    for (const dir of [root, path.join(root, 'missing')]) {
      const result = run(dir, out);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.written, 'breaking=0\nunknown=0\n');
      assert.match(result.stdout, /Found no runtime diff artifacts/);
      fs.rmSync(out);
    }
  });

  it('writes no output file when GITHUB_OUTPUT is unset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-noout-'));
    write(root, 'release-gate-runtime-diff-previewnet-target/report.json', reportWith({ breaking: 1, unknown: 0, chains: [{ chain: 'people', breaking: 1 }] }));
    write(root, 'release-gate-runtime-diff-previewnet-target/diff.json', { network: 'previewnet', sdk: [], chains: [] });
    const result = run(root, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, null);
    assert.match(result.stdout, /\*\*1 breaking, 0 unknown\*\* across 1 artifact\./);
  });

  it('counts a planned candidate with no artifact directory as unknown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-expected-'));
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-out-')), 'out');
    write(root, 'release-gate-runtime-diff-previewnet-target/report.json', reportWith({ breaking: 1, unknown: 0, chains: [{ chain: 'people', breaking: 1 }] }));
    write(root, 'release-gate-runtime-diff-previewnet-target/diff.json', { network: 'previewnet', sdk: [], chains: [] });
    // Four planned candidates, one uploaded: the other three never reached the upload.
    const result = run(root, out, ['--expected', '4']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, 'breaking=1\nunknown=3\n');
    assert.match(result.stdout, /\*\*1 breaking, 3 unknown\*\* across 1 artifact\./);
    assert.match(result.stdout, /3 planned candidates have no runtime diff artifact, so they are unknown\./);
  });

  it('counts nothing as missing when every planned candidate uploaded, or the plan was empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-expected-'));
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-out-')), 'out');
    write(root, 'release-gate-runtime-diff-previewnet-target/report.json', reportWith({ breaking: 0, unknown: 0, chains: [] }));
    write(root, 'release-gate-runtime-diff-previewnet-target/diff.json', { network: 'previewnet', sdk: [], chains: [] });
    // More directories than planned never goes negative.
    let result = run(root, out, ['--expected', '1']);
    assert.equal(result.written, 'breaking=0\nunknown=0\n');
    assert.doesNotMatch(result.stdout, /no runtime diff artifact, so/);
    // A failed or empty plan says zero candidates, and an absent directory then counts nothing.
    fs.rmSync(out);
    result = run(path.join(root, 'missing'), out, ['--expected', '0']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, 'breaking=0\nunknown=0\n');
    assert.match(result.stdout, /Found no runtime diff artifacts/);
  });

  it('never counts a negative number of missing candidates when --expected is lower than the artifacts found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-low-'));
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-out-')), 'out');
    write(root, 'release-gate-runtime-diff-previewnet-target/report.json', reportWith({ breaking: 1, unknown: 0, chains: [{ chain: 'people', breaking: 1 }] }));
    write(root, 'release-gate-runtime-diff-previewnet-target/diff.json', { network: 'previewnet', sdk: [], chains: [] });
    write(root, 'release-gate-runtime-diff-paseo-next-v2-target/diff.json', { network: 'paseo-next-v2', sdk: [], chains: [] });
    // Two directories, one planned: the second directory's unknown is counted once, nothing more.
    const result = run(root, out, ['--expected', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.written, 'breaking=1\nunknown=1\n');
    assert.doesNotMatch(result.stdout, /no runtime diff artifact, so/);
  });

  it('notes the unreadable SDK on each chain row of an artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-sdk-'));
    write(root, 'release-gate-runtime-diff-previewnet-target/report.json', {
      network: 'previewnet',
      chains: [],
      summary: { breaking: 0, unknown: 1, sdkError: 'ENOENT: no such file', chains: [{ chain: 'people', breaking: 0 }] },
    });
    write(root, 'release-gate-runtime-diff-previewnet-target/diff.json', { network: 'previewnet', sdk: [], chains: [] });
    const result = run(root, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| people \| 0 \| SDK not read: ENOENT: no such file \|/);
  });

  it('exits 2 with no directory argument, or a bad --expected', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-args-'));
    for (const bad of [['-1'], ['x'], ['1.5']]) {
      assert.equal(run(root, null, ['--expected', ...bad]).status, 2);
    }
  });
});
