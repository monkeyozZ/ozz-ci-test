import { describe, expect, it } from 'vitest';
import type { WorkloadObservation } from '../../packages/infrastructure/src/workload/contracts.js';
import { workloadFailureObservation } from '../../packages/control-plane/src/services/diagnostics.js';

const sensitive = 'synthetic-runtime-value-must-not-enter-failure-evidence';

function observation(): WorkloadObservation {
  return {
    observedAt: '2026-10-25T17:14:47.000Z',
    configurationState: 'drifted',
    drift: [{ kind: 'Pod', name: 'service-pod', reason: 'unowned_pod_matches_service_selector' }],
    resources: [
      {
        kind: 'Deployment',
        name: 'service',
        namespace: 'environment',
        expectedUid: 'deployment-uid',
        observedUid: 'deployment-uid',
        resourceVersion: '12',
        state: 'verified',
        reason: null,
      },
    ],
    deployment: {
      uid: 'deployment-uid',
      resourceVersion: '12',
      generation: 6,
      observedGeneration: 6,
      replicas: 1,
      currentReplicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      snapshotId: 'snapshot-id',
      configRevision: 3,
      mutationRevision: 6,
      rolloutId: 'rollout-id',
      image: sensitive,
      templateFingerprint: 'a'.repeat(64),
      workloadFingerprint: 'b'.repeat(64),
      progressDeadlineExceeded: false,
      deleting: false,
    },
    pods: [
      {
        uid: 'pod-uid',
        name: 'service-pod',
        namespace: 'environment',
        nodeName: sensitive,
        createdAt: '2026-10-25T17:14:46.000Z',
        deletionTimestamp: null,
        phase: 'Running',
        ready: true,
        snapshotId: 'snapshot-id',
        configRevision: 3,
        rolloutId: 'rollout-id',
        replicaSetUid: 'replica-set-uid',
        matchesDeploymentTemplate: true,
        containers: [],
      },
    ],
    podsTruncated: false,
    events: [
      {
        uid: 'event-uid',
        reason: 'Unhealthy',
        type: 'Warning',
        objectUid: 'pod-uid',
        objectKind: 'Pod',
        objectName: 'service-pod',
        count: 1,
        firstObservedAt: null,
        lastObservedAt: null,
        message: sensitive,
      },
    ],
    eventsState: 'available',
    eventsTruncated: false,
    metrics: {
      state: 'unknown',
      cpuCores: null,
      memoryBytes: null,
      observedAt: null,
      windowSeconds: null,
    },
    metricsErrorCode: null,
    serviceDns: 'service.environment.svc',
  };
}

const failure = {
  attempt: 2,
  errorCode: 'WORKLOAD_CONFIGURATION_DRIFT' as const,
  capturedAt: '2026-10-25T17:14:48.000Z',
};

describe('failed publication evidence', () => {
  it('retains StatefulSet identity and Pod ancestry without manufacturing a Deployment or ReplicaSet', () => {
    const live = observation();
    live.controller = {
      ...live.deployment!,
      kind: 'StatefulSet',
      strategy: 'RollingUpdate',
      currentRevision: 'before',
      updateRevision: 'after',
    };
    live.deployment = null;
    live.resources[0]!.kind = 'StatefulSet';
    live.pods[0]!.owner = { kind: 'StatefulSet', uid: live.controller.uid };
    live.pods[0]!.replicaSetUid = null;
    live.pods[0]!.matchesControllerTemplate = false;
    live.pods[0]!.matchesDeploymentTemplate = false;
    const saved = workloadFailureObservation(live, failure);
    expect(saved.deployment).toBeNull();
    expect(saved.controller).toMatchObject({
      kind: 'StatefulSet',
      currentRevision: 'before',
      updateRevision: 'after',
    });
    expect(saved.pods[0]).toMatchObject({
      replicaSetUid: null,
      owner: { kind: 'StatefulSet', uid: live.controller.uid },
      matchesControllerTemplate: false,
    });
    expect(JSON.stringify(saved)).not.toContain(sensitive);
    live.pods[0]!.owner.uid = 'later-controller';
    expect(saved.pods[0]!.owner!.uid).not.toBe('later-controller');
  });
  it('copies the failed observation identity and controlled states without raw runtime fields', () => {
    const live = observation();
    Object.assign(live, { rawSpec: { environment: { PASSWORD: sensitive } } });
    Object.assign(live.resources[0]!, { data: { PASSWORD: sensitive } });
    Object.assign(live.pods[0]!, { spec: { environment: { PASSWORD: sensitive } } });
    const failedAttempt = { ...failure, rawError: sensitive };
    const saved = workloadFailureObservation(live, failedAttempt);
    expect(saved).toMatchObject({
      ...failure,
      observedAt: live.observedAt,
      configurationState: 'drifted',
    });
    expect(saved.drift).toEqual(live.drift);
    expect(saved.deployment).toMatchObject({ snapshotId: 'snapshot-id', generation: 6 });
    expect(saved.pods[0]).toMatchObject({ uid: 'pod-uid', replicaSetUid: 'replica-set-uid' });
    expect(JSON.stringify(saved)).not.toContain(sensitive);
    expect(saved).not.toHaveProperty('events');
    expect(saved.pods[0]?.containers).toEqual([]);
    live.configurationState = 'consistent';
    live.drift[0]!.reason = 'later_read';
    live.resources[0]!.state = 'missing';
    live.pods[0]!.snapshotId = 'later-snapshot';
    expect(saved.configurationState).toBe('drifted');
    expect(saved.drift[0]!.reason).toBe('unowned_pod_matches_service_selector');
    expect(saved.resources[0]!.state).toBe('verified');
    expect(saved.pods[0]!.snapshotId).toBe('snapshot-id');
  });

  it('bounds retained evidence and keeps anomalous resources ahead of verified history', () => {
    const live = observation();
    live.drift = Array.from({ length: 200 }, (_, index) => ({
      ...live.drift[0]!,
      name: `pod-${index}`,
    }));
    live.resources = Array.from({ length: 200 }, (_, index) => ({
      ...live.resources[0]!,
      name: `resource-${index}`,
    }));
    live.resources[199]!.state = 'drifted';
    live.resources[199]!.reason = 'ownership_mismatch';
    live.pods = Array.from({ length: 100 }, (_, index) => ({
      ...live.pods[0]!,
      uid: `pod-${index}`,
    }));
    const saved = workloadFailureObservation(live, failure);
    expect(saved.drift).toHaveLength(128);
    expect(saved.resources).toHaveLength(64);
    expect(saved.resources[0]).toMatchObject({
      name: 'resource-199',
      state: 'drifted',
      reason: 'ownership_mismatch',
    });
    expect(saved.pods).toHaveLength(32);
    expect(saved.truncated).toEqual({
      drift: true,
      resources: true,
      pods: true,
      containers: false,
    });
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(128 * 1024);
  });

  it('retains the incomplete-read marker even when the evidence is below its size caps', () => {
    const live = observation();
    live.podsTruncated = true;
    expect(workloadFailureObservation(live, failure).truncated).toEqual({
      drift: false,
      resources: false,
      pods: true,
      containers: false,
    });
  });

  it('retains bounded OOM diagnostics without untrusted reason text or raw container details', () => {
    const live = observation();
    const container = {
      name: 'app',
      image: sensitive,
      imageId: sensitive,
      ready: false,
      restartCount: 2,
      state: 'waiting' as const,
      reason: 'CrashLoopBackOff',
      lastTerminationReason: 'OOMKilled',
      oomKilled: true,
      exitCode: null,
      requests: { cpuCores: null, memoryBytes: null },
      limits: { cpuCores: null, memoryBytes: null },
      metrics: { ...live.metrics },
      message: sensitive,
    };
    live.pods[0]!.containers = Array.from({ length: 20 }, (_, index) => ({
      ...container,
      name: `app-${index}`,
    }));
    live.pods[0]!.containers[1]!.reason = sensitive;
    live.pods[0]!.containers[1]!.lastTerminationReason = sensitive;
    const saved = workloadFailureObservation(live, failure);
    expect(saved.pods[0]!.containers).toHaveLength(16);
    expect(saved.pods[0]!.containers![0]).toEqual({
      name: 'app-0',
      ready: false,
      restartCount: 2,
      state: 'waiting',
      reason: 'CrashLoopBackOff',
      lastTerminationReason: 'OOMKilled',
      oomKilled: true,
      exitCode: null,
    });
    expect(saved.pods[0]!.containers![1]).toMatchObject({
      reason: null,
      lastTerminationReason: null,
    });
    expect(saved.truncated.containers).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(sensitive);
    live.pods[0]!.containers[0]!.oomKilled = false;
    expect(saved.pods[0]!.containers![0]!.oomKilled).toBe(true);
  });
});
