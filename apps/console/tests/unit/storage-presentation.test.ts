import { describe, expect, it } from 'vitest';
import {
  databaseState,
  maintenanceState,
  templateDraft,
  templateParameters,
  volumeState,
} from '../../src/components/storage/presentation';
import { formatStorageBytes, gibToBytes } from '../../src/components/storage/format';
import { makeDatabase, makeDeployment, makeTemplate, makeVolume } from '../fixtures/s5-data';
import { storageSnapshotComplete } from '../../src/components/storage/publication';
import {
  serviceOperationInput,
  volumeOperationInput,
} from '../../src/components/infrastructure/operation-presentation';
import type { Operation } from '../../src/lib/types';

describe('persistent data presentation keeps independent facts', () => {
  it('keeps a retained database readable without promoting it to a connectable provider', () => {
    const database = makeDatabase({ service: null });
    expect(databaseState(database)).toEqual({ label: '数据已保留', tone: 'neutral' });
    expect(database.originalService.name).toBe('应用数据库样本');
  });
  it('requires fresh authenticated database evidence', () => {
    const ready = makeDatabase();
    expect(databaseState(ready).tone).toBe('good');
    expect(databaseState({ ...ready, observationStale: true }).tone).toBe('warning');
    expect(databaseState({ ...ready, observation: null }).tone).toBe('warning');
    expect(
      databaseState({ ...ready, observation: { ...ready.observation!, state: 'failed' } }).tone,
    ).toBe('danger');
  });
  it('keeps a completed PVC creation pending while waiting for its first consumer', () => {
    const volume = makeVolume({ activeTask: null });
    expect(volume.locality).toBe('waiting_for_consumer');
    expect(volumeState(volume)).toEqual({ label: '等待绑定', tone: 'primary' });
    expect(volume.usage.usedBytes).toBeNull();
    expect(formatStorageBytes(volume.usage.usedBytes)).toBe('未知');
  });
  it('never treats maintenance expiry or the end of a task as release', () => {
    const record = {
      id: 'maintenance-fixture',
      purpose: 'backup' as const,
      state: 'active' as const,
      revision: 1,
      enteredAt: '2026-10-26T00:00:00Z',
      expiresAt: '2026-10-26T01:00:00Z',
      releasedAt: null,
      overdue: true,
      lastErrorCode: null,
      exitBlockers: [],
    };
    expect(maintenanceState(record)).toEqual({ label: '维护超时 · 仍锁定', tone: 'danger' });
    expect(maintenanceState({ ...record, state: 'closed' }).tone).toBe('neutral');
    expect(maintenanceState({ ...record, overdue: false, state: 'failed' }).label).toContain(
      '仍锁定',
    );
  });
});

describe('publication and operation identity boundaries', () => {
  it('requires complete v2 data references while preserving readable v1 history', () => {
    const snapshot = makeDeployment().snapshot;
    expect(storageSnapshotComplete(snapshot)).toBe(true);
    expect(storageSnapshotComplete({ ...snapshot, databaseBindings: undefined })).toBe(false);
    expect(storageSnapshotComplete({ ...snapshot, volumes: undefined })).toBe(false);
    expect(
      storageSnapshotComplete({
        ...snapshot,
        version: 1,
        controller: undefined,
        volumes: undefined,
        databaseBindings: undefined,
      }),
    ).toBe(true);
  });
  it('never identifies a fixed volume operation as a service workload operation', () => {
    const volume = makeVolume();
    const snapshot = makeDeployment().snapshot.volumes![0];
    const operation: Operation = {
      id: 'operation-fixture',
      kind: 'volume_destroy',
      scope: 'volume',
      serverId: null,
      clusterId: snapshot.target.clusterId,
      serviceId: null,
      status: 'cancelled',
      input: {
        volumeId: volume.id,
        volumeRevision: volume.revision,
        mutationRevision: 1,
        target: snapshot.target,
      },
      result: null,
      createdAt: volume.createdAt,
      updatedAt: volume.updatedAt,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      retryOfId: null,
      cancelRequestedAt: null,
      pollUrl: '',
    };
    expect(volumeOperationInput(operation)?.volumeId).toBe(volume.id);
    expect(serviceOperationInput(operation)).toBeNull();
    expect(volumeOperationInput({ ...operation, scope: 'service' })).toBeNull();
    expect(volumeOperationInput({ ...operation, kind: 'service_delete' })).toBeNull();
  });
});

describe('template inputs preserve byte precision and declared parameters', () => {
  it('converts integer GiB using decimal strings beyond Number precision', () => {
    const value = '9007199254740993';
    expect(gibToBytes(value)).toBe((9007199254740993n * 1024n ** 3n).toString());
    expect(formatStorageBytes('1536')).toBe('1.5 KiB');
    expect(formatStorageBytes('0')).toBe('0 B');
    expect(formatStorageBytes('not-a-size')).toBe('未知');
  });
  it.each(['0', '-1', '1.5', '1e3', ''])('rejects invalid GiB input %s', (value) => {
    expect(() => gibToBytes(value)).toThrow('整数 GiB');
  });
  it('sends only catalog parameter keys and retains numeric zero for Redis', () => {
    const template = makeTemplate('redis');
    const draft = { ...templateDraft(template), password: 'this-field-is-not-declared' };
    expect(templateParameters(template, draft)).toEqual({
      requestedBytes: '1073741824',
      redisDatabase: 0,
    });
    expect(() => templateParameters(template, { ...draft, redisDatabase: '16' })).toThrow(
      '整数范围',
    );
  });
  it('rejects a missing Docker image before requesting a preview', () => {
    const template = makeTemplate('docker');
    expect(() => templateParameters(template, templateDraft(template))).toThrow('镜像地址');
  });
});
