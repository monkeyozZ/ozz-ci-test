import type { Deployment, Service } from '@/components/services/types';
import type {
  BuildDetail,
  GitPreview,
  GitSource,
  GitSourceDraft,
  GitSourceInput,
  RegistryConnection,
} from './types';

export function sourceDraft(source?: GitSource, registry?: RegistryConnection): GitSourceDraft {
  const revision = source?.currentRevision;
  const repository = revision?.destination.repository ?? '';
  const prefix = registry ? registry.namespace + '/' : '';
  return {
    connectionId: revision?.githubConnectionId ?? '',
    repositoryId: revision?.repository.repositoryId ?? '',
    branchRef: revision?.branchRef ?? '',
    dockerfilePath: revision?.dockerfilePath ?? 'Dockerfile',
    contextPath: revision?.contextPath ?? '.',
    builderId: revision?.builder.builderId ?? '',
    registryConnectionId: revision?.destination.registryConnectionId ?? '',
    imageRepository:
      prefix && repository.startsWith(prefix) ? repository.slice(prefix.length) : repository,
    architectures: revision?.platforms.map((platform) => platform.architecture) ?? [],
    variants: Object.fromEntries(
      (revision?.platforms ?? [])
        .filter((platform) => platform.variant)
        .map((platform) => [platform.architecture, platform.variant]),
    ),
    buildArgs: Object.entries(revision?.buildArgs ?? {}).map(([name, value]) => ({
      rowId: crypto.randomUUID(),
      name,
      value,
    })),
    buildSecrets: (revision?.buildSecrets ?? []).map((secret) => ({
      rowId: crypto.randomUUID(),
      ...secret,
    })),
    autoDeploy: source?.autoDeploy ?? false,
  };
}
export function sourceInput(form: GitSourceDraft): GitSourceInput {
  const args = Object.create(null) as Record<string, string>;
  for (const row of form.buildArgs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name))
      throw new Error('构建参数名只能使用字母、数字和下划线，且不能以数字开头。');
    if (Object.hasOwn(args, row.name))
      throw new Error('构建参数 ' + row.name + ' 重复，请合并后保存。');
    args[row.name] = row.value;
  }
  const mountIds = new Set<string>();
  for (const secret of form.buildSecrets) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(secret.mountId))
      throw new Error('构建秘密挂载 ID 须以字母开头，只能使用字母、数字、点、短横线和下划线。');
    if (mountIds.has(secret.mountId)) throw new Error('构建秘密挂载 ID 重复。');
    mountIds.add(secret.mountId);
  }
  if (!form.architectures.length) throw new Error('请选择至少一种构建架构。');
  return {
    kind: 'github',
    repositoryId: form.repositoryId,
    branchRef: form.branchRef,
    dockerfilePath: form.dockerfilePath.trim(),
    contextPath: form.contextPath.trim(),
    builderId: form.builderId,
    registryConnectionId: form.registryConnectionId,
    imageRepository: form.imageRepository.trim(),
    platforms: [...new Set(form.architectures)].map((architecture) => ({
      os: 'linux',
      architecture,
      ...(form.variants[architecture] ? { variant: form.variants[architecture] } : {}),
    })),
    buildArgs: args,
    buildSecrets: form.buildSecrets.map(({ mountId, secretRefId, secretKey }) => ({
      mountId,
      secretRefId,
      secretKey: secretKey || 'value',
    })),
    autoDeploy: form.autoDeploy,
  };
}
export const reviewConfirmations = new Set([
  'DEPLOY_AND_START_REQUIRED',
  'CONFIGURATION_REPAIR_REQUIRED',
  'REVIEWING_RETAINED_SOURCE',
]);
export function previewBlockingIssues(preview: GitPreview) {
  return preview.issues.filter((issue) => !reviewConfirmations.has(issue.code));
}
export function previewIsCurrent(preview: GitPreview, revision: number, now: number) {
  return preview.serviceRevision === revision && Date.parse(preview.expiresAt) > now;
}
export function serviceSourceLabel(service: Service) {
  return service.source?.kind === 'github'
    ? service.source.currentRevision.repository.fullNameAtCapture +
        ' · ' +
        service.source.currentRevision.branchRef.replace(/^refs\/heads\//, '')
    : 'image' in service.configuration
      ? service.configuration.image
      : '来源尚未载入';
}
export function deploymentSourceLabel(deployment: Deployment) {
  return deployment.snapshot.version === 3
    ? deployment.snapshot.source.revision.repository.fullNameAtCapture +
        ' · ' +
        deployment.snapshot.source.commitSha
    : deployment.resolvedImage?.deployReference || deployment.snapshot.configuration.image;
}
export const targetStateLabels: Record<string, string> = {
  waiting: '等待受理',
  pending: '待审阅发布',
  ignored: '已忽略',
  orphaned: '原目标已不可用',
  enqueued: '已创建部署',
};
export const reasonLabels: Record<string, string> = {
  ready: '等待调度',
  service_busy: '等待当前服务任务完成',
  queue_capacity: '等待执行容量',
  service_stopped: '服务已停止，仅记录提交',
  configuration_changed: '运行配置已修改，需要重新审阅',
  source_changed: '来源配置已修改，需要审阅原来源',
  policy_changed: '自动发布策略已修改',
  publication_confirmation_required: '需要明确确认发布',
  auto_deploy_disabled: '未启用自动发布',
  branch_mismatch: '不是跟踪分支',
  unsupported_event: '不支持的事件',
  branch_deleted: '分支已删除',
  service_deleted: '原服务已删除',
  target_changed: '原发布目标已变化',
  invalid_signature: '验签失败',
};
export function reasonLabel(reason: string | null) {
  return reason ? (reasonLabels[reason] ?? reason) : '';
}
export function buildStillOpen(build: BuildDetail | null | undefined) {
  return !!build?.runs.some(
    (run) =>
      run.executionState === 'open' ||
      (!!run.submissionAttemptedAt && (!run.executionClosedAt || !run.proofVerifiedAt)),
  );
}
export function artifactRetryDescription(build: BuildDetail | null | undefined) {
  if (!build) return '构建资料尚未载入，无法确认原产物。';
  if (buildStillOpen(build)) return '远端执行尚未取得结束证明，暂不能创建新的重试。';
  const artifact = build.artifact;
  if (artifact.state === 'none')
    return '核对原执行已结束且确无产物后，按原 commit、来源配置、架构和构建秘密版本重新构建。';
  if (artifact.availability === 'missing' || artifact.availability === 'expired')
    return '原产物已缺失或过期，不能通过重试重新构建或替换它。';
  return artifact.state === 'oci'
    ? '校验并推送原 OCI 产物，保持原 digest；不会重新构建。'
    : '验证并使用原 Registry digest；产物缺失时明确失败，不重新构建或从缓存重推。';
}
export function decimalSequenceCompare(a: string, b: string) {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}
