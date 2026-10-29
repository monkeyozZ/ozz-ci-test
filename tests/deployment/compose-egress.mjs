import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function proveComposeEgress({ root, directory, project, imagePrefix, compose, run }) {
  const backendName = `${project}_backend`;
  const egressName = `${project}_egress`;
  const network = JSON.parse(
    await run('egress-network', 'docker', ['network', 'inspect', egressName]),
  )[0];
  assert.equal(network.Internal, false);
  const gateway = network.IPAM.Config.find((entry) => isIP(entry.Gateway ?? '') === 4)?.Gateway;
  assert.ok(gateway, 'The dedicated egress network must have an IPv4 gateway');
  const members = {};
  for (const service of ['api', 'worker', 'postgres', 'redis']) {
    const id = await run(`egress-${service}-id`, 'docker', [...compose, 'ps', '-q', service]);
    const names = Object.keys(
      JSON.parse(
        await run(`egress-${service}-networks`, 'docker', [
          'inspect',
          '--format',
          '{{json .NetworkSettings.Networks}}',
          id,
        ]),
      ),
    ).sort();
    assert.deepEqual(
      names,
      service === 'api' || service === 'worker' ? [backendName, egressName].sort() : [backendName],
    );
    members[service] = { id, networks: names };
  }

  const fixtures = resolve(directory, 'egress-protocol-fixture');
  await mkdir(fixtures, { mode: 0o700 });
  const caKey = resolve(fixtures, 'ca.key');
  const ca = resolve(fixtures, 'ca.crt');
  const serverKey = resolve(fixtures, 'server.key');
  const serverCsr = resolve(fixtures, 'server.csr');
  const serverCert = resolve(fixtures, 'server.crt');
  const extensions = resolve(fixtures, 'server.ext');
  await run('egress-create-ca', 'openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    ca,
    '-days',
    '2',
    '-subj',
    '/CN=Ozz Compose Egress CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  await run('egress-create-csr', 'openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    serverKey,
    '-out',
    serverCsr,
    '-subj',
    '/CN=egress.ozz.invalid',
  ]);
  await writeFile(
    extensions,
    'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:egress.ozz.invalid\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n',
    { mode: 0o600 },
  );
  await run('egress-sign-cert', 'openssl', [
    'x509',
    '-req',
    '-in',
    serverCsr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    serverCert,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  await chmod(caKey, 0o600);
  await chmod(serverKey, 0o600);
  await chmod(serverCert, 0o644);
  const source = resolve(root, 'tests/deployment/egress-protocol-fixture.mjs');
  const sourceText = await readFile(source, 'utf8');
  const nonce = randomUUID();
  const fixtureNetwork = await run('egress-fixture-network', 'docker', [
    'network',
    'create',
    '--driver',
    'bridge',
    '--label',
    `dev.ozz.owner=${project}`,
    `${project}-egress-target`,
  ]);
  let fixtureId;
  const evidence = {
    scope:
      'Linux TCP/HTTPS egress boundary through a dedicated bridge gateway and isolated protocol fixtures; separate from product SSH/K3s/registry execution.',
    gateway,
    fixtureNetwork,
    members,
    protocols: ['ssh-banner', 'kubernetes-https-version', 'registry-https-challenge'],
    strictTls: true,
    realCredentialsSent: false,
    allowed: {},
    denied: {},
  };
  try {
    fixtureId = await run('egress-fixture-start', 'docker', [
      'run',
      '--detach',
      '--pull=never',
      '--name',
      `${project}-egress-target`,
      '--label',
      `dev.ozz.owner=${project}`,
      '--network',
      fixtureNetwork,
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--pids-limit',
      '32',
      '--memory',
      '96m',
      '--cpus',
      '0.25',
      '--log-driver',
      'json-file',
      '--log-opt',
      'max-size=1m',
      '--log-opt',
      'max-file=1',
      '--env',
      'OZZ_EGRESS_MODE=serve',
      '--env',
      `OZZ_EGRESS_NONCE=${nonce}`,
      '--publish',
      `${gateway}::2222`,
      '--publish',
      `${gateway}::6443`,
      '--publish',
      `${gateway}::50443`,
      '--volume',
      `${source}:/proof/fixture.mjs:ro`,
      '--volume',
      `${serverKey}:/proof/server.key:ro`,
      '--volume',
      `${serverCert}:/proof/server.crt:ro`,
      '--entrypoint',
      'node',
      `${imagePrefix}/api:0.1.0`,
      '/proof/fixture.mjs',
    ]);
    const ports = JSON.parse(
      await run('egress-fixture-ports', 'docker', [
        'inspect',
        '--format',
        '{{json .NetworkSettings.Ports}}',
        fixtureId,
      ]),
    );
    const target = { host: gateway, ports: {}, ca: await readFile(ca, 'utf8'), nonce };
    for (const [protocol, containerPort] of [
      ['ssh', 2222],
      ['kubernetes', 6443],
      ['registry', 50443],
    ]) {
      const mappings = ports[`${containerPort}/tcp`];
      assert.equal(mappings.length, 1);
      assert.equal(mappings[0].HostIp, gateway);
      target.ports[protocol] = Number(mappings[0].HostPort);
    }
    evidence.publishedOnlyOnDedicatedGateway = { host: gateway, ports: target.ports };
    const clientArgs = [
      '-e',
      'OZZ_EGRESS_MODE=probe',
      '-e',
      `OZZ_EGRESS_TARGET=${JSON.stringify(target)}`,
    ];
    for (const service of ['api', 'worker']) {
      let result;
      const deadline = Date.now() + 15_000;
      do {
        result = JSON.parse(
          await run(`egress-${service}-probe`, 'docker', [
            ...compose,
            'exec',
            '-T',
            ...clientArgs,
            service,
            'node',
            '--input-type=module',
            '--eval',
            sourceText,
          ]),
        );
        if (result.results.every((entry) => entry.tcpConnected && entry.verified)) break;
        await delay(200);
      } while (Date.now() < deadline);
      evidence.allowed[service] = result;
      assert.ok(
        result.results.every((entry) => entry.tcpConnected && entry.verified),
        `${service} cannot complete the external protocol connections`,
      );
    }
    for (const service of ['postgres', 'redis']) {
      const name = `${project}-egress-denied-${service}`;
      const result = JSON.parse(
        await run(`egress-${service}-denied`, 'docker', [
          'run',
          '--rm=false',
          '--pull=never',
          '--name',
          name,
          '--label',
          `dev.ozz.owner=${project}`,
          '--network',
          `container:${members[service].id}`,
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges:true',
          '--pids-limit',
          '24',
          '--memory',
          '96m',
          '--cpus',
          '0.25',
          ...clientArgs,
          '--entrypoint',
          'node',
          `${imagePrefix}/api:0.1.0`,
          '--input-type=module',
          '--eval',
          sourceText,
        ]),
      );
      evidence.denied[service] = {
        networkNamespace: members[service].id,
        probeContainer: name,
        ...result,
      };
      assert.ok(
        result.results.every((entry) => !entry.tcpConnected && !entry.verified),
        `${service} escaped its internal backend network`,
      );
    }
    evidence.status = 'passed';
    return evidence;
  } finally {
    if (fixtureId) {
      await run('egress-fixture-stop', 'docker', ['stop', '--time', '3', fixtureId]);
      evidence.fixtureContainer = fixtureId;
      evidence.fixtureState = 'stopped-and-retained';
    }
    await writeFile(resolve(fixtures, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {
      mode: 0o600,
    });
  }
}
