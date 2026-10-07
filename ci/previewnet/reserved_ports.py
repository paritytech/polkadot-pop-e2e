"""Keep Zombienet's bind(0) allocations away from configured node ports."""
import json
import subprocess


def reservation(value, config):
    ports = set()
    for item in value.strip().split(','):
        if not item:
            continue
        ends = item.split('-')
        assert len(ends) <= 2
        first, last = int(ends[0]), int(ends[-1])
        assert 1 <= first <= last <= 65535
        ports.update(range(first, last + 1))
    groups = [config['relaychain']['nodes']]
    groups += [para['collators'] for para in config['parachains']]
    fixed = set()
    for nodes in groups:
        for node in nodes:
            for key in ('rpc_port', 'p2p_port', 'prometheus_port'):
                port = node.get(key)
                if port is not None:
                    assert isinstance(port, int) and 1 <= port <= 65535
                    fixed.add(port)
    ports.update(fixed)
    ranges = []
    for port in sorted(ports):
        if ranges and port == ranges[-1][1] + 1:
            ranges[-1][1] = port
        else:
            ranges.append([port, port])
    merged = ','.join(str(a) if a == b else f'{a}-{b}' for a, b in ranges)
    return merged, sorted(fixed)


def reserve(config_path, evidence_path):
    import tomllib

    key = 'net.ipv4.ip_local_reserved_ports'
    before = subprocess.check_output(['sysctl', '-n', key], text=True).strip()
    merged, fixed = reservation(before, tomllib.loads(config_path.read_text()))
    subprocess.run(['sudo', '-n', 'sysctl', '-w', f'{key}={merged}'], check=True)
    after = subprocess.check_output(['sysctl', '-n', key], text=True).strip()
    assert reservation(after, {'relaychain': {'nodes': []}, 'parachains': []})[0] == merged
    evidence_path.write_text(json.dumps({'key': key, 'before': before, 'after': after,
        'configuredPorts': fixed,
        'purpose': 'Exclude fixed ports from automatic bind(0) allocation; explicit binds remain allowed.'}, indent=2) + '\n')
