import { describe, expect, it } from 'vitest';
import {
  clearCreationSecrets,
  creationRequestKeys,
  creationServiceMatches,
} from '../../src/components/services/creation-state';
import type { CreateServiceInput } from '../../src/components/services/types';
import { makeGitService, s6Environment, s6Project } from '../fixtures/s6-data';

const context = { project: s6Project, environment: s6Environment };

describe('resuming a saved service creation', () => {
  it('requires the exact project, environment, cluster and source from the current flow', () => {
    const service = makeGitService();
    expect(creationServiceMatches(service, context, { kind: 'github' })).toBe(true);
    expect(creationServiceMatches(service, context, { kind: 'image' })).toBe(false);
    for (const mismatch of [
      { projectId: 'another-project' },
      { project: { ...service.project, id: 'another-project' } },
      { environmentId: 'another-environment' },
      { environment: { ...service.environment, slug: 'production' } },
      { clusterId: 'another-cluster' },
    ]) {
      expect(creationServiceMatches({ ...service, ...mismatch }, context, { kind: 'github' })).toBe(
        false,
      );
    }
  });

  it('does not resume a different template or replace a fixed template with an image form', () => {
    const service = makeGitService({
      source: { kind: 'image' },
      template: { id: 'postgresql', version: '1.0.0' },
    });
    expect(
      creationServiceMatches(service, context, {
        kind: 'template',
        id: 'postgresql',
        version: '1.0.0',
      }),
    ).toBe(true);
    expect(
      creationServiceMatches(service, context, { kind: 'template', id: 'redis', version: '1.0.0' }),
    ).toBe(false);
    expect(
      creationServiceMatches(service, context, {
        kind: 'template',
        id: 'postgresql',
        version: '2.0.0',
      }),
    ).toBe(false);
    expect(creationServiceMatches(service, context, { kind: 'image' })).toBe(false);
  });
});

describe('creation request recovery', () => {
  const input: CreateServiceInput = {
    projectId: s6Project.id,
    environmentId: s6Environment.id,
    name: '演示数据库',
    slug: 'database-stable',
    template: {
      id: 'postgresql',
      version: '1.0.0',
      parameters: { databaseName: 'app', requestedBytes: '1073741824' },
    },
  };

  it('reuses the request identity on retry and when returning to an earlier payload', async () => {
    const keyFor = creationRequestKeys();
    const original = await keyFor(input);
    expect(await keyFor(structuredClone(input))).toBe(original);
    expect(await keyFor({ ...input, name: '另一个数据库' })).not.toBe(original);
    expect(await keyFor(input)).toBe(original);
  });

  it('clears accepted plaintext secrets while preserving plain values and stored references', () => {
    const value: CreateServiceInput = {
      ...input,
      template: undefined,
      configuration: {
        ...makeGitService().configuration,
        environment: [
          { name: 'PASSWORD', value: 'test-only-value', secret: true },
          { name: 'NODE_ENV', value: 'production' },
          {
            name: 'TOKEN',
            secretRefId: '66000000-0000-4000-8000-000000000019',
            secretKey: 'value',
          },
        ],
      },
    };
    clearCreationSecrets(value);
    expect(value.configuration?.environment).toEqual([
      { name: 'PASSWORD', value: '', secret: true },
      { name: 'NODE_ENV', value: 'production' },
      { name: 'TOKEN', secretRefId: '66000000-0000-4000-8000-000000000019', secretKey: 'value' },
    ]);
  });
});
