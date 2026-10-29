import { describe, expect, it } from 'vitest';
import {
  artifactRetryDescription,
  buildStillOpen,
  decimalSequenceCompare,
  previewBlockingIssues,
  previewIsCurrent,
  sourceDraft,
  sourceInput,
} from '../../src/components/git/presentation';
import {
  makeBuild,
  makeBuildRun,
  makeGitPreview,
  makeGitSource,
  makeRegistry,
  s6Ids,
} from '../fixtures/s6-data';

describe('Git publication identity', () => {
  it('rejects an expired or superseded persisted preview', () => {
    const preview = makeGitPreview();
    expect(previewIsCurrent(preview, 7, Date.parse(preview.checkedAt))).toBe(true);
    expect(previewIsCurrent(preview, 8, Date.parse(preview.checkedAt))).toBe(false);
    expect(previewIsCurrent(preview, 7, Date.parse(preview.expiresAt))).toBe(false);
  });
  it('keeps source failures blocking while retaining separate publication confirmations', () => {
    const preview = makeGitPreview({
      issues: [
        { code: 'DEPLOY_AND_START_REQUIRED', message: 'Explicit start is required.' },
        { code: 'CONFIGURATION_REPAIR_REQUIRED', message: 'Explicit repair is required.' },
        { code: 'REVIEWING_RETAINED_SOURCE', message: 'Review the source recorded at receipt.' },
        {
          code: 'GITHUB_PATH_NOT_FOUND',
          field: 'dockerfilePath',
          message: 'The selected commit has no Dockerfile.',
        },
      ],
    });
    expect(previewBlockingIssues(preview).map((issue) => issue.code)).toEqual([
      'GITHUB_PATH_NOT_FOUND',
    ]);
  });
  it('preserves the fixed platform variant and separates explicit build secrets from runtime fields', () => {
    const form = sourceDraft(makeGitSource(), makeRegistry());
    Object.assign(form, {
      runtimeVariables: [{ name: 'DATABASE_PASSWORD', secretRefId: 'runtime-only' }],
    });
    const input = sourceInput(form);
    expect(input.imageRepository).toBe('application');
    expect(input.platforms).toEqual([{ os: 'linux', architecture: 'arm64', variant: 'v8' }]);
    expect(input.buildSecrets).toEqual([
      { mountId: 'privatePackage', secretRefId: s6Ids.secret, secretKey: 'value' },
    ]);
    expect(input).not.toHaveProperty('image');
    expect(input).not.toHaveProperty('runtimeVariables');
  });
});

describe('original artifact retry', () => {
  it('keeps a pushed digest as a Registry artifact while image verification is incomplete', () => {
    const build = makeBuild('registry');
    expect(build.artifact.state !== 'none' && build.artifact.image).toBeNull();
    expect(artifactRetryDescription(build)).toContain('原 Registry digest');
    expect(artifactRetryDescription(build)).not.toContain('重新构建。');
  });
  it('pushes an existing OCI instead of rebuilding and blocks a missing archive', () => {
    const build = makeBuild('oci');
    expect(artifactRetryDescription(build)).toContain('推送原 OCI');
    if (build.artifact.state !== 'none') build.artifact.availability = 'expired';
    expect(artifactRetryDescription(build)).toContain('不能通过重试重新构建');
    expect(build.artifact.state).toBe('oci');
  });
  it('does not release an uncertain remote run just because a closure timestamp is present', () => {
    const build = makeBuild('none');
    build.runs = [makeBuildRun({ observationState: 'unknown', proofVerifiedAt: null })];
    expect(buildStillOpen(build)).toBe(true);
    expect(artifactRetryDescription(build)).toContain('暂不能创建新的重试');
    build.runs = [
      makeBuildRun({
        executionState: 'never_submitted',
        submissionAttemptedAt: null,
        proofVerifiedAt: null,
      }),
    ];
    expect(buildStillOpen(build)).toBe(false);
    expect(artifactRetryDescription(build)).toContain('按原 commit');
  });
});

it('orders BuildLog decimal sequence values without Number precision loss', () => {
  expect(['9007199254740993', '10', '9007199254740992', '9'].sort(decimalSequenceCompare)).toEqual([
    '9',
    '10',
    '9007199254740992',
    '9007199254740993',
  ]);
});
