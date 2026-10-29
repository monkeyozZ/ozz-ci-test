import { describe, expect, it } from 'vitest';
import { matchesManifest } from '../../packages/infrastructure/dist/workload/resources.js';
import type { Resource } from '../../packages/infrastructure/dist/workload/names.js';

describe('Kubernetes writable volume defaults', () => {
  it.each(['Deployment', 'StatefulSet'])(
    'compares omitted false values for %s without erasing read-only drift',
    (kind) => {
      const desired = {
        apiVersion: 'apps/v1',
        kind,
        metadata: { name: 'controlled-workload' },
        spec: {
          selector: { matchLabels: { app: 'fixture' } },
          template: {
            metadata: { labels: { app: 'fixture' } },
            spec: {
              containers: [
                {
                  name: 'app',
                  image: 'fixture/image:1',
                  volumeMounts: [{ name: 'data', mountPath: '/data', readOnly: false }],
                },
              ],
              volumes: [
                {
                  name: 'data',
                  persistentVolumeClaim: { claimName: 'fixed-pvc', readOnly: false },
                },
              ],
            },
          },
        },
      };
      const actual = structuredClone(desired);
      Reflect.deleteProperty(actual.spec.template.spec.containers[0]!.volumeMounts[0]!, 'readOnly');
      Reflect.deleteProperty(
        actual.spec.template.spec.volumes[0]!.persistentVolumeClaim,
        'readOnly',
      );
      expect(matchesManifest(actual as Resource, desired as Resource)).toBe(true);
      const claimChanged = structuredClone(actual);
      claimChanged.spec.template.spec.volumes[0]!.persistentVolumeClaim.readOnly = true;
      expect(matchesManifest(claimChanged as Resource, desired as Resource)).toBe(false);
      const mountChanged = structuredClone(actual);
      mountChanged.spec.template.spec.containers[0]!.volumeMounts[0]!.readOnly = true;
      expect(matchesManifest(mountChanged as Resource, desired as Resource)).toBe(false);
      const replacedClaim = structuredClone(actual);
      replacedClaim.spec.template.spec.volumes[0]!.persistentVolumeClaim.claimName = 'foreign-pvc';
      expect(matchesManifest(replacedClaim as Resource, desired as Resource)).toBe(false);
    },
  );
});
