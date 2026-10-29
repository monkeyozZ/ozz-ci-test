import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { matchesManualRecord, runRecordedCli } from '../probes/s5-recovery-local-lab.mjs';

const specification = () => ({
  id: randomUUID(),
  kind: 'restore',
  outputParent: '/virtual/new-restore-attempt',
  args: ['--context', '/virtual/current-session.json'],
});

for (const type of ['backup', 'restore'])
  test(`${type} ledger reconciliation requires both passed result and passed integrity`, () => {
    const source = Object.fromEntries(
      ['installationId', 'clusterId', 'kubeSystemUid', 'environmentId', 'volumeId', 'pvcUid'].map(
        (key) => [key, randomUUID()],
      ),
    );
    const target =
      type === 'restore' ? { ...source, volumeId: randomUUID(), pvcUid: randomUUID() } : null;
    const manifest = { backupId: randomUUID(), sha256: 'a'.repeat(64), sizeBytes: '1024' };
    const record = {
      ...manifest,
      type,
      source,
      target,
      result: 'passed',
      integrity: 'passed',
      verificationSource: 'operator_reported',
    };
    const expected = { manifest, source, target };
    assert.equal(matchesManualRecord(record, expected), true);
    for (const result of ['incomplete', 'failed', undefined])
      assert.equal(matchesManualRecord({ ...record, result }, expected), false);
    for (const integrity of ['unknown', 'failed', undefined])
      assert.equal(matchesManualRecord({ ...record, integrity }, expected), false);
    assert.equal(
      matchesManualRecord({ ...record, source: { ...source, pvcUid: randomUUID() } }, expected),
      false,
    );
  });

test('recovery journal persists the intent before a single import and verifies its receipt on re-entry', async () => {
  const journal = {},
    writes = [],
    spec = specification();
  let imported = false,
    executions = 0;
  const receipt = { operationId: randomUUID(), result: 'incomplete', helperRemoved: true };
  const invocation = {
    journal,
    label: 'restore:postgresql:owned-new-target',
    specification: spec,
    save: async () => writes.push(globalThis.structuredClone(journal)),
    recover: async () => (imported ? receipt : null),
    execute: async (intent) => {
      assert.equal(writes[0][invocation.label].state, 'planned');
      assert.equal(writes.at(-1)[invocation.label].state, 'started');
      assert.deepEqual(intent.args, spec.args);
      executions++;
      imported = true;
    },
  };
  assert.deepEqual(await runRecordedCli(invocation), receipt);
  assert.deepEqual(await runRecordedCli(invocation), receipt);
  assert.equal(executions, 1);
  assert.equal(journal[invocation.label].state, 'succeeded');
});

test('a completed import with a lost process response is recovered without another execution', async () => {
  const spec = specification(),
    journal = { restore: { ...spec, state: 'started' } },
    receipt = { operationId: randomUUID(), result: 'incomplete' };
  assert.deepEqual(
    await runRecordedCli({
      journal,
      label: 'restore',
      specification: spec,
      save: async () => {},
      recover: async () => receipt,
      execute: async () => assert.fail('An already completed import must never execute twice.'),
    }),
    receipt,
  );
  assert.equal(journal.restore.state, 'succeeded');
});

for (const state of ['started', 'failed', 'succeeded'])
  test(`an import in ${state} state without a valid completion receipt cannot be replayed`, async () => {
    const spec = specification();
    await assert.rejects(
      runRecordedCli({
        journal: { restore: { ...spec, state } },
        label: 'restore',
        specification: spec,
        save: async () => {},
        recover: async () => null,
        execute: async () => assert.fail('Missing evidence cannot authorize another import.'),
      }),
      { code: 'S5_RECOVERY_CLI_RECONCILIATION_REQUIRED' },
    );
  });

test('failed import evidence remains durable and an ordinary rerun cannot retry it', async () => {
  const journal = {},
    spec = specification();
  let executions = 0,
    durable;
  const invocation = {
    journal,
    label: 'restore',
    specification: spec,
    save: async () => {
      durable = globalThis.structuredClone(journal);
    },
    recover: async () => null,
    execute: async () => {
      executions++;
      throw Object.assign(new Error('Sensitive remote diagnostics must not be retained.'), {
        code: 'MANUAL_POSTGRES_NOT_EMPTY',
      });
    },
  };
  await assert.rejects(runRecordedCli(invocation), { code: 'MANUAL_POSTGRES_NOT_EMPTY' });
  assert.equal(durable.restore.state, 'failed');
  assert.equal(durable.restore.failure.code, 'MANUAL_POSTGRES_NOT_EMPTY');
  assert.equal(JSON.stringify(durable).includes('Sensitive remote'), false);
  await assert.rejects(runRecordedCli(invocation), {
    code: 'S5_RECOVERY_CLI_RECONCILIATION_REQUIRED',
  });
  assert.equal(executions, 1);
});

test('a never-started intent can renew its session but cannot change its retained output directory', async () => {
  const spec = specification(),
    journal = { restore: { ...spec, state: 'planned' } };
  let executed = false;
  const renewed = { ...spec, args: ['--context', '/virtual/renewed-session.json'] };
  await runRecordedCli({
    journal,
    label: 'restore',
    specification: renewed,
    save: async () => {},
    recover: async () => (executed ? { valid: true } : null),
    execute: async (intent) => {
      assert.deepEqual(intent.args, renewed.args);
      executed = true;
    },
  });
  await assert.rejects(
    runRecordedCli({
      journal,
      label: 'restore',
      specification: { ...renewed, outputParent: '/virtual/other-target' },
      save: async () => {},
      recover: async () => assert.fail('A changed intent must not even consult another receipt.'),
      execute: async () => assert.fail('A changed intent must never execute.'),
    }),
    { code: 'S5_RECOVERY_CLI_INTENT_CHANGED' },
  );
});
