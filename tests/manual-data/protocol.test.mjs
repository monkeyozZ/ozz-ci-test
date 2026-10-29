import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { copyBundle } from '../../scripts/manual-data-artifact.mjs';
import { writeNew } from '../../scripts/manual-data-core.mjs';
import { fixedCommand } from '../../scripts/manual-data-commands.mjs';
import { executeChannel } from '../../scripts/manual-data-exec.mjs';
import {
  backupManual,
  restoreManual,
  verifyRestored,
} from '../../scripts/manual-data-operations.mjs';
import { recordManual } from '../../scripts/manual-data-record.mjs';
import { removeRetainedHelper } from '../../scripts/manual-data-helper.mjs';
import {
  createHelper,
  deleteHelper,
  openManualSession,
  requestJson,
  verifyHelper,
} from '../../scripts/manual-data-runtime.mjs';
import { ManualFixture } from './protocol-fixture.mjs';

async function opened(test, fixture) {
  const session = await openManualSession(fixture.contextFile);
  test.after(() => session.close());
  return session;
}
async function backup(test, kind) {
  const fixture = await new ManualFixture(kind, kind === 'files' ? 'backup' : 'online').start(test);
  const result = await backupManual(fixture.contextFile, join(fixture.directory, 'backup'));
  const copy = await copyBundle(
    result.directory,
    join(fixture.directory, 'off-host'),
    'synthetic-independent-copy',
  );
  return { fixture, result, copy };
}

for (const kind of ['postgresql', 'redis', 'files'])
  test(
    `${kind}: complete operator workflow across HTTPS and binary WebSocket, without real engine/cluster execution`,
    { timeout: 30_000 },
    async (t) => {
      const source = await backup(t, kind),
        target = await new ManualFixture(kind, 'restore').start(t);
      target.createdAt = new Date().toISOString();
      target.expiry = source.fixture.expiry;
      if (kind === 'postgresql') {
        target.username = 'new_owner';
        target.databaseName = 'restored';
      }
      const prepared = await restoreManual(
        target.contextFile,
        source.copy.directory,
        source.copy.receiptPath,
        join(target.directory, 'restore'),
      );
      assert.equal(prepared.prepared.result, 'incomplete');
      assert.equal(prepared.prepared.maintenanceReleased, false);
      assert.equal(target.helpers.size, 0);
      await assert.rejects(
        verifyRestored(
          target.contextFile,
          source.copy.directory,
          prepared.report,
          source.copy.receiptPath,
        ),
        { code: 'MANUAL_SERVICE_NOT_RUNNING' },
      );
      target.mode = 'formal';
      const final = await verifyRestored(
        target.contextFile,
        source.copy.directory,
        prepared.report,
        source.copy.receiptPath,
      );
      assert.equal(final.result.result, 'passed');
      assert.ok(final.result.durationMs >= 0);
      assert.notEqual(final.result.target.volumeId, final.result.source.volumeId);
      assert.notEqual(final.result.target.pvcUid, final.result.source.pvcUid);
      assert.deepEqual(
        await readFile(join(source.result.directory, source.result.manifest.file)),
        await readFile(join(source.copy.directory, source.result.manifest.file)),
      );
      const writes = target.requests.filter((r) => r.kind === 'kube' && r.method !== 'GET');
      assert.equal(writes.length, 2);
      assert.ok(writes.every((r) => /\/pods(?:\/ozz-manual-[a-f0-9]+)?$/.test(r.path)));
      assert.ok(writes[1].body.preconditions.uid);
      assert.ok(writes[1].body.preconditions.resourceVersion);
      assert.ok(
        target.requests
          .filter((r) => r.path.includes('/secrets/'))
          .every((r) => r.accept.includes('as=PartialObjectMetadata')),
      );
      if (kind === 'redis') {
        const operations = target.commands.map((c) => c.operation);
        const load = operations.indexOf('redis-load-rdb'),
          enable = operations.indexOf('redis-enable-aof'),
          stop = operations.lastIndexOf('redis-stop');
        assert.ok(
          operations.indexOf('redis-start-empty') < operations.indexOf('redis-preserve-empty'),
        );
        assert.ok(
          operations.indexOf('redis-preserve-empty') < load && load < enable && enable < stop,
        );
        assert.equal(final.result.formal.data.status.aofEnabled, true);
      }
      if (kind === 'files') {
        const created = source.fixture.requests.find(
          (r) => r.kind === 'kube' && r.method === 'POST',
        );
        assert.equal(created.body.spec.volumes[0].persistentVolumeClaim.readOnly, true);
        assert.equal(created.body.spec.containers[0].volumeMounts[0].readOnly, true);
        assert.equal(created.body.spec.securityContext.fsGroup, undefined);
      }
    },
  );
test('product staleness, maintenance loss and parallel mutation block before remote writes', async (t) => {
  const fixture = await new ManualFixture('files', 'backup').start(t);
  const cases = [
    (v) => {
      v.volume.observation.stale = true;
    },
    (v) => {
      v.volume.mounts.truncated = true;
    },
    (v) => {
      v.volume.maintenance.state = 'closed';
    },
    (v) => {
      v.volume.maintenance.purpose = 'restore';
    },
    (v) => {
      v.volume.maintenance.overdue = true;
    },
    (v) => {
      v.service.activeTask = { id: randomUUID() };
    },
    (v) => {
      v.service.hasUnpublishedChanges = true;
    },
  ];
  for (const mutate of cases) {
    fixture.mutateProduct = mutate;
    const session = await openManualSession(fixture.contextFile);
    try {
      await assert.rejects(session.checkpoint('backup'));
    } finally {
      session.close();
    }
  }
  assert.equal(fixture.requests.filter((r) => r.kind === 'kube' && r.method !== 'GET').length, 0);
});
test('same-name Node replacement, changed PV binding and replaced runtime Secret fail closed', async (t) => {
  const fixture = await new ManualFixture('postgresql', 'online').start(t),
    session = await opened(t, fixture);
  await session.checkpoint('online');
  fixture.node.metadata.uid = randomUUID();
  await assert.rejects(session.checkpoint('online'), { code: 'MANUAL_NODE_IDENTITY' });
  fixture.node.metadata.uid = fixture.nodeUid;
  fixture.pv.spec.claimRef.uid = randomUUID();
  await assert.rejects(session.checkpoint('online'), { code: 'MANUAL_PV_IDENTITY' });
  fixture.pv.spec.claimRef.uid = fixture.identity.pvcUid;
  fixture.replacedSecret = true;
  await assert.rejects(session.checkpoint('online'), { code: 'MANUAL_RESOURCE_IDENTITY' });
});
test('typed Kubernetes lists may omit item TypeMeta but explicit wrong kinds are rejected', async (t) => {
  const fixture = await new ManualFixture('postgresql', 'online').start(t),
    session = await opened(t, fixture);
  fixture.omitListTypeMeta = true;
  const snapshot = await session.checkpoint('online');
  assert.equal(snapshot.pod.kind, 'Pod');
  assert.equal(snapshot.pod.apiVersion, 'v1');
  fixture.badListItemType = true;
  await assert.rejects(session.checkpoint('online'), { code: 'MANUAL_LIST_INCOMPLETE' });
});
test('truncated, forbidden and unrelated Pod mounts never become a zero-mount claim', async (t) => {
  const fixture = await new ManualFixture('files', 'backup').start(t),
    session = await opened(t, fixture);
  fixture.truncatedPods = true;
  await assert.rejects(session.checkpoint('backup'), { code: 'MANUAL_LIST_INCOMPLETE' });
  fixture.truncatedPods = false;
  fixture.failPath = `/api/v1/namespaces/${fixture.namespace}/pods`;
  await assert.rejects(session.checkpoint('backup'), { code: 'MANUAL_REQUEST_REJECTED' });
  fixture.failPath = null;
  fixture.extraPods.push({
    kind: 'Pod',
    metadata: { name: 'unrelated', uid: randomUUID(), labels: fixture.serviceLabels },
    spec: {
      volumes: [{ name: 'unexpected', persistentVolumeClaim: { claimName: fixture.pvcName } }],
    },
    status: { phase: 'Succeeded' },
  });
  await assert.rejects(session.checkpoint('backup'), { code: 'MANUAL_VOLUME_IN_USE' });
});
test('active attachment and stale controller fingerprint block helper creation', async (t) => {
  const fixture = await new ManualFixture('files', 'backup').start(t),
    session = await opened(t, fixture);
  fixture.attachments.push({
    spec: { source: { persistentVolumeName: fixture.pv.metadata.name } },
  });
  await assert.rejects(session.checkpoint('backup'), { code: 'MANUAL_VOLUME_ATTACHED' });
  fixture.attachments = [];
  fixture.controller.spec.template.spec.containers[0].image = 'unexpected:latest';
  await assert.rejects(session.checkpoint('backup'), { code: 'MANUAL_CONTROLLER_DRIFT' });
});
test('helper creation intent precedes POST; lost response recovers only matching nonce and UID', async (t) => {
  const fixture = await new ManualFixture('files', 'backup').start(t),
    session = await opened(t, fixture),
    snapshot = await session.checkpoint('backup');
  fixture.onCreate = async () => access(join(fixture.directory, 'helper-intent.json'));
  fixture.loseCreate = true;
  const helper = await createHelper(
    session,
    snapshot,
    'files',
    randomUUID(),
    fixture.directory,
    true,
  );
  assert.ok(helper.uid);
  assert.equal(fixture.helpers.size, 1);
  const pod = fixture.helpers.get(helper.name);
  const uid = pod.metadata.uid;
  pod.metadata.uid = randomUUID();
  await assert.rejects(deleteHelper(session, helper, 'backup'));
  assert.equal(fixture.requests.filter((r) => r.method === 'DELETE').length, 0);
  pod.metadata.uid = uid;
  await deleteHelper(session, helper, 'backup');
  assert.equal(fixture.helpers.size, 0);
});
test('admission-added sidecar/init container is never accepted as a helper', async (t) => {
  const fixture = await new ManualFixture('files', 'backup').start(t),
    session = await opened(t, fixture),
    snapshot = await session.checkpoint('backup');
  fixture.onCreate = (body) => {
    body.spec.initContainers = [{ name: 'unknown', image: 'unexpected:latest' }];
  };
  await assert.rejects(
    createHelper(session, snapshot, 'files', randomUUID(), fixture.directory, true),
    { code: 'MANUAL_HELPER_IDENTITY' },
  );
  assert.equal(fixture.helpers.size, 1);
  assert.equal(fixture.requests.filter((r) => r.method === 'DELETE').length, 0);
});
test('helper rejects added exec surfaces and subPath while accepting API omitted readOnly false', async (t) => {
  const fixture = await new ManualFixture('files', 'restore').start(t),
    session = await opened(t, fixture),
    snapshot = await session.checkpoint('restore');
  const helper = await createHelper(
    session,
    snapshot,
    'files',
    randomUUID(),
    fixture.directory,
    false,
  );
  const original = fixture.helpers.get(helper.name);
  const omitted = globalThis.structuredClone(original);
  delete omitted.spec.volumes[0].persistentVolumeClaim.readOnly;
  delete omitted.spec.containers[0].volumeMounts[0].readOnly;
  verifyHelper(omitted, helper);
  for (const mutate of [
    (pod) => {
      pod.spec.volumes[0].persistentVolumeClaim.readOnly = true;
    },
    (pod) => {
      pod.spec.containers[0].volumeMounts[0].readOnly = true;
    },
    (pod) => {
      delete pod.spec.automountServiceAccountToken;
    },
    (pod) => {
      delete pod.spec.enableServiceLinks;
    },
    (pod) => {
      delete pod.spec.containers[0].securityContext.allowPrivilegeEscalation;
    },
  ]) {
    const changed = globalThis.structuredClone(original);
    mutate(changed);
    assert.throws(() => verifyHelper(changed, helper), { code: 'MANUAL_HELPER_IDENTITY' });
  }
  for (const [key, value] of [
    ['lifecycle', { postStart: { exec: { command: ['unknown'] } } }],
    ['startupProbe', { exec: { command: ['unknown'] } }],
    ['livenessProbe', { exec: { command: ['unknown'] } }],
    ['readinessProbe', { exec: { command: ['unknown'] } }],
    ['stdin', true],
    ['tty', true],
    ['volumeDevices', [{ devicePath: '/dev/fake', name: 'data' }]],
    ['env', [{ name: 'LD_PRELOAD', value: '/unexpected' }]],
  ]) {
    const changed = globalThis.structuredClone(original);
    changed.spec.containers[0][key] = value;
    assert.throws(() => verifyHelper(changed, helper), { code: 'MANUAL_HELPER_IDENTITY' });
  }
  const subpath = globalThis.structuredClone(original);
  subpath.spec.containers[0].volumeMounts[0].subPath = 'other-data';
  assert.throws(() => verifyHelper(subpath, helper), { code: 'MANUAL_HELPER_IDENTITY' });
  await deleteHelper(session, helper, 'restore');
});
test('expired session and recovery lock are rechecked between remote phases', async (t) => {
  const fixture = await new ManualFixture('postgresql', 'online').start(t),
    session = await opened(t, fixture);
  await session.checkpoint('online');
  fixture.restoreMode = true;
  await assert.rejects(session.checkpoint('online'), { code: 'MANUAL_PLATFORM_LOCKED' });
  fixture.restoreMode = false;
  fixture.expiredSession = true;
  await assert.rejects(session.checkpoint('online'), { code: 'MANUAL_REQUEST_REJECTED' });
});
test('nonempty PostgreSQL restore retains the target/helper and never imports', async (t) => {
  const source = await backup(t, 'postgresql'),
    target = await new ManualFixture('postgresql', 'restore').start(t);
  target.createdAt = new Date().toISOString();
  target.nonempty = true;
  await assert.rejects(
    restoreManual(
      target.contextFile,
      source.copy.directory,
      source.copy.receiptPath,
      join(target.directory, 'restore'),
    ),
    { code: 'MANUAL_POSTGRES_NOT_EMPTY' },
  );
  assert.equal(target.helpers.size, 1);
  assert.equal(
    target.commands.some((c) => c.operation === 'pg-import'),
    false,
  );
  assert.equal(
    target.requests.some((r) => r.method === 'DELETE'),
    false,
  );
  const runs = await readdir(join(target.directory, 'restore'));
  await access(join(target.directory, 'restore', runs[0], 'restore-incomplete.json'));
});
test('Redis rewrite failure cannot publish a completed restore or start the formal StatefulSet', async (t) => {
  const source = await backup(t, 'redis'),
    target = await new ManualFixture('redis', 'restore').start(t);
  target.createdAt = new Date().toISOString();
  target.expiry = source.fixture.expiry;
  target.failOperation = 'redis-enable-aof';
  await assert.rejects(
    restoreManual(
      target.contextFile,
      source.copy.directory,
      source.copy.receiptPath,
      join(target.directory, 'restore'),
    ),
    { code: 'MANUAL_EXEC_FAILED' },
  );
  assert.equal(target.helpers.size, 1);
  assert.equal(target.mode, 'restore');
  assert.equal(
    target.requests.some((r) => r.method === 'DELETE'),
    false,
  );
  const runs = await readdir(join(target.directory, 'restore'));
  await assert.rejects(access(join(target.directory, 'restore', runs[0], 'restore-prepared.json')));
});
test('failed import helper can be gracefully removed under the original overdue lock without releasing maintenance', async (t) => {
  const source = await backup(t, 'postgresql'),
    target = await new ManualFixture('postgresql', 'restore').start(t);
  target.createdAt = new Date().toISOString();
  target.nonempty = true;
  await assert.rejects(
    restoreManual(
      target.contextFile,
      source.copy.directory,
      source.copy.receiptPath,
      join(target.directory, 'restore'),
    ),
    { code: 'MANUAL_POSTGRES_NOT_EMPTY' },
  );
  const runs = await readdir(join(target.directory, 'restore')),
    runDirectory = join(target.directory, 'restore', runs[0]);
  target.mutateProduct = ({ volume }) => {
    volume.maintenance.overdue = true;
    volume.maintenance.expiresAt = new Date(Date.now() - 1000).toISOString();
  };
  const result = await removeRetainedHelper(target.contextFile, runDirectory);
  assert.equal(target.helpers.size, 0);
  assert.equal(result.maintenanceReleased, false);
  assert.equal(result.restoreCompleted, false);
  assert.equal(target.mode, 'restore');
});
test('manual records use the source Volume route and remain operator_reported for incomplete restores', async (t) => {
  const source = await backup(t, 'postgresql'),
    recordRoot = join(source.fixture.directory, 'records');
  const first = await recordManual(
    source.fixture.contextFile,
    source.copy.directory,
    source.copy.receiptPath,
    recordRoot,
  );
  assert.equal(first.verificationSource, 'operator_reported');
  const target = await new ManualFixture('postgresql', 'restore').start(t);
  target.createdAt = new Date().toISOString();
  const restored = await restoreManual(
    target.contextFile,
    source.copy.directory,
    source.copy.receiptPath,
    join(target.directory, 'restore'),
  );
  const second = await recordManual(
    source.fixture.contextFile,
    source.copy.directory,
    source.copy.receiptPath,
    recordRoot,
    restored.report,
  );
  assert.equal(second.type, 'restore');
  assert.equal(second.result, 'incomplete');
  const calls = source.fixture.requests.filter(
    (r) => r.method === 'POST' && r.path.endsWith('/manual-data-records'),
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].path,
    `/api/volumes/${source.result.manifest.source.volumeId}/manual-data-records`,
  );
  assert.deepEqual(calls[1].body.target, target.identity);
  assert.equal(calls[1].body.platformVerified, undefined);
  assert.equal(calls[1].origin, source.fixture.apiOrigin);
  assert.equal(calls[1].csrf, 'synthetic-csrf');
});
test('WebSocket stdin sends the complete bounded artifact and an explicit v5 EOF', async (t) => {
  const fixture = await new ManualFixture('postgresql', 'online').start(t),
    input = join(fixture.directory, 'upload.bin'),
    bytes = Buffer.alloc(512 * 1024, 17);
  await writeNew(input, bytes);
  const result = await executeChannel(
    fixture.connection,
    { namespace: fixture.namespace, name: `${fixture.name}-0` },
    fixedCommand('upload', { operationId: randomUUID() }),
    { inputFile: input },
  );
  assert.equal(result.inputBytes, String(bytes.length));
  assert.deepEqual(fixture.uploaded, bytes);
});
test('WebSocket requires binary frames, bounded bytes and explicit successful process status', async (t) => {
  const fixture = await new ManualFixture('postgresql', 'online').start(t),
    selection = { namespace: fixture.namespace, name: `${fixture.name}-0` },
    command = fixedCommand('pg-stop');
  const cases = [
    [(socket) => socket.send('private text'), 'MANUAL_EXEC_PROTOCOL'],
    [(socket) => socket.close(), 'MANUAL_EXEC_STATUS_MISSING'],
    [
      (socket) => socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(100)])),
      'MANUAL_EXEC_TOO_LARGE',
    ],
    [
      (socket) =>
        socket.send(
          Buffer.concat([
            Buffer.from([3]),
            Buffer.from(
              '{"status":"Success","details":{"causes":[{"reason":"ExitCode","message":"5"}]}}',
            ),
          ]),
        ),
      'MANUAL_EXEC_FAILED',
    ],
  ];
  for (const [handler, code] of cases) {
    fixture.nextExec = handler;
    await assert.rejects(
      executeChannel(fixture.connection, selection, command, { maximum: 64, timeoutMs: 1000 }),
      (error) => {
        assert.equal(error.code, code);
        assert.ok(!error.message.includes('private'));
        return true;
      },
    );
  }
});
test('HTTP redirect responses do not forward authentication to another origin', async (t) => {
  const fixture = await new ManualFixture('files', 'backup').start(t);
  let redirectedRequests = 0;
  fixture.apiServer.removeAllListeners('request');
  fixture.apiServer.on('request', (_request, response) => {
    redirectedRequests++;
    response.writeHead(302, { Location: `${fixture.kubeOrigin}/capture` });
    response.end('fixture-sensitive-value-must-not-escape');
  });
  await assert.rejects(
    requestJson(fixture.apiOrigin, '/redirect', { headers: { Cookie: 'private-cookie' } }),
    (error) => {
      assert.equal(error.code, 'MANUAL_REDIRECT_REJECTED');
      assert.ok(!error.message.includes('sensitive'));
      return true;
    },
  );
  assert.equal(redirectedRequests, 1);
  assert.equal(fixture.requests.filter((r) => r.path === '/capture').length, 0);
});
