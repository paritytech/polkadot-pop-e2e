#!/usr/bin/env python3
"""Run independent Coinage case workflows one at a time and record every run.

Each case is its own workflow_dispatch run with its own URL, logs and artifacts. This script
only schedules them: it dispatches one case, waits for it to finish, records the run ID and
conclusion in a JSON ledger, then moves on. It never retries on its own. A failed case stays
failed until `retry` is called for that case, and earlier runs stay in its history.

The ledger is the resume point. If the script stops, run it again: a case with an unfinished
run is watched rather than dispatched again.

  coinage-case-queue.py add LEDGER --workflow coinage-burst-case.yml --ref BRANCH \\
      --title "Coinage burst · quota · 100-default" -f scenario=quota -f profile=100-default
  coinage-case-queue.py run LEDGER --preserve EVIDENCE_DIR
  coinage-case-queue.py retry LEDGER CASE_ID
  coinage-case-queue.py status LEDGER
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = 'paritytech/polkadot-pop-e2e'
CASE_WORKFLOWS = ('coinage-burst-case.yml', 'coinage-sustained-case.yml')
# Also wait for the retired coupled campaign, so old and new runs never overlap.
BUSY_WORKFLOWS = CASE_WORKFLOWS + ('coinage-lifecycle-campaign.yml',)
POLL_SECONDS = 60


def now():
    return datetime.now(timezone.utc)


def gh_json(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True, timeout=120))


def load(path):
    return json.loads(Path(path).read_text()) if Path(path).exists() else {'repo': REPO, 'cases': []}


def save(path, ledger):
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(json.dumps(ledger, indent=2) + '\n')
    tmp.replace(path)


def case_id(workflow, fields):
    return '-'.join([workflow.removesuffix('.yml')] + [fields[k] for k in sorted(fields)])


def active_case_runs():
    """Any queued or running case, whether dispatched by this queue or by hand."""
    runs = []
    for workflow in BUSY_WORKFLOWS:
        for status in ('queued', 'in_progress', 'waiting', 'pending'):
            # Fail closed when GitHub cannot establish whether another case is active.
            # An API error (including a missing workflow) is not an empty run list.
            runs += gh_json('run', 'list', '-R', REPO, '--workflow', workflow, '--status', status,
                            '--json', 'databaseId,displayTitle,status', '-L', '20')
    return runs


def find_dispatched(case, since):
    for _ in range(30):
        runs = gh_json('run', 'list', '-R', REPO, '--workflow', case['workflow'], '--branch', case['ref'],
                       '--event', 'workflow_dispatch', '-L', '20',
                       '--json', 'databaseId,displayTitle,createdAt,headSha,url')
        for run in runs:
            created = datetime.fromisoformat(run['createdAt'].replace('Z', '+00:00'))
            if run['displayTitle'] == case['title'] and created >= since - timedelta(seconds=5):
                return run
        time.sleep(10)
    raise RuntimeError(f"Dispatched {case['id']} but could not find its run")


def watch(path, ledger, case, attempt):
    while True:
        try:
            run = gh_json('run', 'view', str(attempt['runId']), '-R', REPO, '--json',
                          'status,conclusion,headSha,attempt,jobs')
        except subprocess.TimeoutExpired:
            # A read timeout says nothing about the workflow outcome. Keep watching
            # this run; never redispatch or advance the queue without a terminal result.
            print(f"status read timed out; still watching {attempt['runId']}", flush=True)
            time.sleep(POLL_SECONDS)
            continue
        attempt.update(status=run['status'], conclusion=run['conclusion'] or None, headSha=run['headSha'],
                       runAttempt=run['attempt'], observedAt=now().isoformat(),
                       jobs=[{'name': j['name'], 'conclusion': j['conclusion'] or None,
                              'url': j.get('url')} for j in run['jobs']])
        save(path, ledger)
        if run['status'] == 'completed':
            return
        time.sleep(POLL_SECONDS)


def preserve(directory, case, attempt):
    """Copy the run's final artifacts locally; GitHub deletes them after 30 days."""
    target = Path(directory) / f"{case['id']}-{attempt['runId']}"
    target.mkdir(parents=True, exist_ok=True)
    artifacts = gh_json('api', f"repos/{REPO}/actions/runs/{attempt['runId']}/artifacts?per_page=100")['artifacts']
    (target / 'artifact-manifest.json').write_text(json.dumps(artifacts, indent=2) + '\n')
    for artifact in artifacts:
        name = artifact['name']
        if artifact['expired'] or '-pilot-' not in name or (target / name / '.download-complete').exists():
            continue
        subprocess.run(['gh', 'run', 'download', str(attempt['runId']), '-R', REPO, '-n', name,
                        '-D', str(target / name)], check=True, timeout=7200)
        (target / name / '.download-complete').write_text(json.dumps(artifact, indent=2) + '\n')
    attempt['preservedAt'] = str(target)


def cmd_add(args):
    ledger = load(args.ledger)
    fields = dict(f.split('=', 1) for f in args.field)
    cid = case_id(args.workflow, fields)
    if any(c['id'] == cid for c in ledger['cases']):
        print('already queued', cid)
        return
    ledger['cases'].append({'id': cid, 'workflow': args.workflow, 'ref': args.ref, 'title': args.title,
                            'inputs': fields, 'runs': []})
    save(args.ledger, ledger)
    print('queued', cid)


def cmd_run(args):
    ledger = load(args.ledger)
    for case in ledger['cases']:
        last = case['runs'][-1] if case['runs'] else None
        if last and last.get('status') == 'completed':
            continue
        if last is None:
            while (busy := active_case_runs()):
                print('waiting for', [r['displayTitle'] for r in busy], flush=True)
                time.sleep(POLL_SECONDS)
            since = now()
            subprocess.run(['gh', 'workflow', 'run', case['workflow'], '-R', REPO, '--ref', case['ref'],
                            *[a for k, v in case['inputs'].items() for a in ('-f', f'{k}={v}')]], check=True)
            run = find_dispatched(case, since)
            last = {'runId': run['databaseId'], 'url': run['url'], 'dispatchedAt': since.isoformat(),
                    'status': 'queued'}
            case['runs'].append(last)
            save(args.ledger, ledger)
            print('dispatched', case['id'], last['url'], flush=True)
        watch(args.ledger, ledger, case, last)
        if args.preserve:
            preserve(args.preserve, case, last)
            save(args.ledger, ledger)
        print('finished', case['id'], last['conclusion'], last['url'], flush=True)
        if args.once:
            return


def cmd_retry(args):
    ledger = load(args.ledger)
    case = next(c for c in ledger['cases'] if c['id'] == args.case)
    last = case['runs'][-1] if case['runs'] else None
    if not last or last.get('status') != 'completed':
        sys.exit(f'{args.case} has no completed run to retry')
    # Keep the earlier run; a new entry is added when the queue reaches this case again.
    ledger['cases'].remove(case)
    case['retried'] = case.get('retried', []) + case['runs']
    case['runs'] = []
    ledger['cases'].append(case)
    save(args.ledger, ledger)
    print('will rerun', args.case, 'after the outstanding cases')


def cmd_status(args):
    for case in load(args.ledger)['cases']:
        last = case['runs'][-1] if case['runs'] else {}
        print(f"{case['id']:<60} {last.get('conclusion') or last.get('status') or 'not started':<12} {last.get('url', '')}")


parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = parser.add_subparsers(required=True)
add = sub.add_parser('add')
add.add_argument('ledger')
add.add_argument('--workflow', required=True, choices=CASE_WORKFLOWS)
add.add_argument('--ref', required=True)
add.add_argument('--title', required=True, help='Must equal the workflow run-name for these inputs')
add.add_argument('-f', '--field', action='append', default=[])
add.set_defaults(func=cmd_add)
run = sub.add_parser('run')
run.add_argument('ledger')
run.add_argument('--once', action='store_true', help='Stop after one case finishes')
run.add_argument('--preserve', help='Download each finished run\'s pilot artifacts into this directory')
run.set_defaults(func=cmd_run)
retry = sub.add_parser('retry')
retry.add_argument('ledger')
retry.add_argument('case')
retry.set_defaults(func=cmd_retry)
status = sub.add_parser('status')
status.add_argument('ledger')
status.set_defaults(func=cmd_status)

if __name__ == '__main__':
    args = parser.parse_args()
    args.func(args)
