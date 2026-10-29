import { describe, expect, it } from 'vitest';
import { configurationChanges } from '../../src/components/services/presentation';
import { makeGitPreview } from '../fixtures/s6-data';

describe('publication configuration review', () => {
  it('shows no changes when persisted JSON returns the same object keys in another order', () => {
    const before = makeGitPreview().configuration;
    before.readiness = {
      type: 'http',
      port: 'http',
      path: '/',
      initialDelaySeconds: 0,
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 3,
    };
    before.environment = [{ name: 'LOG_LEVEL', value: 'info' }];
    const after = {
      ...before,
      ports: [{ servicePort: 8080, containerPort: 8080, protocol: 'http' as const, name: 'http' }],
      resources: {
        limits: { memoryMiB: 128, cpuMillis: 250 },
        requests: { memoryMiB: 64, cpuMillis: 50 },
      },
      readiness: {
        failureThreshold: 3,
        timeoutSeconds: 2,
        periodSeconds: 5,
        initialDelaySeconds: 0,
        path: '/',
        port: 'http',
        type: 'http' as const,
      },
      environment: [{ value: 'info', name: 'LOG_LEVEL' }],
    };
    expect(configurationChanges(before, after)).toEqual([]);
  });

  it('still identifies changed nested values, argument order and secret references', () => {
    const before = makeGitPreview().configuration;
    before.args = ['first', 'second'];
    before.environment = [{ name: 'TOKEN', secretRefId: 'old-reference', secretKey: 'value' }];
    const after = structuredClone(before);
    after.args = ['second', 'first'];
    after.resources.limits.cpuMillis = 500;
    after.environment = [{ secretKey: 'value', secretRefId: 'new-reference', name: 'TOKEN' }];
    const changes = configurationChanges(before, after);
    expect(changes.map((change) => change.key)).toEqual(['args', 'resources', 'environment.TOKEN']);
    expect(changes.find((change) => change.key === 'environment.TOKEN')).toEqual({
      key: 'environment.TOKEN',
      label: '变量 TOKEN',
      before: '已加密的秘密引用',
      after: '已加密的秘密引用',
    });
  });

  it('keeps an unpublished field distinct from a published but unconfigured field', () => {
    const configuration = makeGitPreview().configuration;
    expect(
      configurationChanges(null, configuration).find((change) => change.key === 'readiness'),
    ).toEqual({ key: 'readiness', label: '就绪探针', before: '尚未发布', after: '未配置' });
    expect(configurationChanges(configuration, structuredClone(configuration))).toEqual([]);
  });
});
