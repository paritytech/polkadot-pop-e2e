"""Launch Zombienet in its own process group so cleanup only stops this run."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('command', choices=['start', 'stop'])
args = parser.parse_args()
out = Path('network-out').resolve()
pidfile = out / 'spawn.pid'
if args.command == 'start':
    engine = Path('ppn').resolve()
    env = {**os.environ, 'BIN': str(engine / 'bin'), 'SCRIPTS': str(engine / 'scripts')}
    with (out / 'spawn.log').open('w') as log:
        proc = subprocess.Popen([str(engine / 'bin/zombie-cli'), 'spawn', '-p', 'native',
                                 '-d', str(out / 'data'), str(out / 'network.toml')],
                                env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    pidfile.write_text(str(proc.pid))
elif pidfile.exists():
    pid = int(pidfile.read_text())
    try:
        os.killpg(pid, signal.SIGINT)
        time.sleep(5)
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
