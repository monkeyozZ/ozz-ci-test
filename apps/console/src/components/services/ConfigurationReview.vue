<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { ArrowRight, Info, LoaderCircle, ShieldCheck, RotateCcw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ServiceMutationError from './ServiceMutationError.vue';
import ServiceStorageReview from '@/components/storage/ServiceStorageReview.vue';
import DeploymentStorageSnapshot from '@/components/storage/DeploymentStorageSnapshot.vue';
import GitSourceSummary from '@/components/git/GitSourceSummary.vue';
import { storageSnapshotComplete } from '@/components/storage/publication';
import { invalidateStorage } from '@/components/storage/queries';
import { configurationChanges, taskLocation } from './presentation';
import type { Deployment, DeploymentDetail, DeployServiceInput, Service } from './types';
import type { GitPreview, GitPreviewInput } from '@/components/git/types';
import {
  artifactRetryDescription,
  buildStillOpen,
  previewBlockingIssues,
  previewIsCurrent,
} from '@/components/git/presentation';
import { invalidateGitService } from '@/components/git/queries';
import { api, request } from '@/lib/api';
import type { Envelope } from '@/lib/types';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useViewScope } from '@/composables/useViewScope';
import { useObservationClock } from '@/components/infrastructure/useObservationClock';
const props = defineProps<{
  service: Service;
  retryOf?: DeploymentDetail;
  pendingTargetId?: string;
}>();
const emit = defineEmits<{ submitted: [deployment: Deployment] }>();
const auth = useAuthStore();
const active = useViewScope();
const now = useObservationClock();
const reviewed = shallowRef(props.service);
const start = ref(false);
const repair = ref(false);
const storageReady = ref(false);
const selectionKind = ref<'branch_head' | 'commit'>('branch_head');
const commitSha = ref('');
const preview = shallowRef<GitPreview | null>(null);
let previewAbort: AbortController | null = null;
let previewGeneration = 0;
let key = idempotencyKey();
const isGit = computed(() =>
  props.retryOf ? props.retryOf.snapshot.version === 3 : reviewed.value.source?.kind === 'github',
);
const needsPreview = computed(() => isGit.value && !props.retryOf);
const selection = computed<GitPreviewInput['selection']>(() =>
  props.pendingTargetId
    ? { kind: 'pending_target', webhookTargetId: props.pendingTargetId }
    : selectionKind.value === 'commit'
      ? { kind: 'commit', commitSha: commitSha.value.trim() }
      : { kind: 'branch_head' },
);
const fingerprint = computed(() =>
  JSON.stringify({
    id: reviewed.value.id,
    revision: reviewed.value.revision,
    selection: selection.value,
  }),
);
const stale = computed(
  () =>
    reviewed.value.revision !== props.service.revision ||
    (!!preview.value && !previewIsCurrent(preview.value, props.service.revision, now.value)),
);
const previewExpired = computed(
  () => !!preview.value && Date.parse(preview.value.expiresAt) <= now.value,
);
const snapshot = computed(
  () =>
    props.retryOf?.snapshot.configuration ??
    preview.value?.configuration ??
    reviewed.value.configuration,
);
const fixedGitSource = computed(() =>
  props.retryOf?.snapshot.version === 3 ? props.retryOf.snapshot.source : preview.value?.source,
);
const changes = computed(() => {
  const rows = configurationChanges(
    reviewed.value.published?.configuration ?? null,
    snapshot.value,
  );
  const after = fixedGitSource.value;
  const before = reviewed.value.published?.source;
  if (after) {
    const previous = before?.kind === 'github' ? before : null;
    const sourceFields = [
      { key: 'commit', label: '固定 commit', before: previous?.commitSha, after: after.commitSha },
      {
        key: 'sourceRevision',
        label: '来源版本',
        before: previous?.revision.id,
        after: after.revision.id,
      },
      {
        key: 'repository',
        label: 'Git 仓库',
        before: previous?.revision.repository.fullNameAtCapture,
        after: after.revision.repository.fullNameAtCapture,
      },
      {
        key: 'branch',
        label: '跟踪分支',
        before: previous?.revision.branchRef,
        after: after.revision.branchRef,
      },
      {
        key: 'dockerfile',
        label: 'Dockerfile',
        before: previous?.revision.dockerfilePath,
        after: after.revision.dockerfilePath,
      },
      {
        key: 'context',
        label: '构建上下文',
        before: previous?.revision.contextPath,
        after: after.revision.contextPath,
      },
      {
        key: 'buildArgs',
        label: '普通构建参数',
        before: previous ? JSON.stringify(previous.revision.buildArgs) : undefined,
        after: JSON.stringify(after.revision.buildArgs),
      },
      {
        key: 'buildSecrets',
        label: '构建秘密引用与版本',
        before: previous ? JSON.stringify(previous.revision.buildSecrets) : undefined,
        after: JSON.stringify(after.revision.buildSecrets),
      },
      {
        key: 'platforms',
        label: '构建架构',
        before: previous ? JSON.stringify(previous.revision.platforms) : undefined,
        after: JSON.stringify(after.revision.platforms),
      },
      {
        key: 'builder',
        label: 'Builder 配置',
        before: previous ? JSON.stringify(previous.revision.builder) : undefined,
        after: JSON.stringify(after.revision.builder),
      },
      {
        key: 'destination',
        label: '产物去向',
        before: previous ? JSON.stringify(previous.revision.destination) : undefined,
        after: JSON.stringify(after.revision.destination),
      },
    ];
    rows.unshift(
      ...sourceFields
        .filter((field) => field.before !== field.after)
        .map((field) => ({
          ...field,
          before: field.before ?? '尚未发布',
        })),
    );
  }
  return rows;
});
const needsStart = computed(
  () => (preview.value?.desiredState ?? reviewed.value.desiredState) === 'stopped',
);
const needsRepair = computed(
  () =>
    ['partial', 'drifted', 'unknown'].includes(props.service.configurationState) ||
    !!preview.value?.issues.some((issue) => issue.code === 'CONFIGURATION_REPAIR_REQUIRED'),
);
const blockingIssues = computed(() => (preview.value ? previewBlockingIssues(preview.value) : []));
const retryBlocked = computed(() => {
  if (!props.retryOf || !isGit.value) return false;
  const build = props.retryOf.build;
  return (
    !build ||
    buildStillOpen(build) ||
    (build.artifact.state !== 'none' &&
      ['missing', 'expired'].includes(build.artifact.availability))
  );
});
watch(() => props.retryOf?.id, refreshReview);
watch(fingerprint, () => {
  previewGeneration++;
  previewAbort?.abort();
  preview.value = null;
  start.value = false;
  repair.value = false;
  key = idempotencyKey();
  prepare.reset();
});
function refreshReview() {
  previewGeneration++;
  previewAbort?.abort();
  reviewed.value = props.service;
  preview.value = null;
  start.value = false;
  repair.value = false;
  key = idempotencyKey();
  deploy.reset();
  prepare.reset();
}
const prepare = useMutation({
  mutationFn: async (input: { body: GitPreviewInput; fingerprint: string; generation: number }) => {
    previewAbort?.abort();
    const abort = new AbortController();
    previewAbort = abort;
    return (
      await request<Envelope<GitPreview>>(
        '/services/' + reviewed.value.id + '/git-source/preview',
        {
          method: 'POST',
          body: input.body,
          signal: abort.signal,
        },
      )
    ).data;
  },
  onSuccess: (value, input) => {
    if (
      !active() ||
      input.fingerprint !== fingerprint.value ||
      input.generation !== previewGeneration
    )
      return;
    preview.value = value;
    start.value = false;
    repair.value = false;
    key = idempotencyKey();
  },
});
function preparePreview() {
  if (
    auth.restoreMode ||
    props.service.activeTask ||
    reviewed.value.revision !== props.service.revision ||
    prepare.isPending.value
  )
    return;
  if (selection.value.kind === 'commit' && !/^[0-9a-f]{40}$/.test(selection.value.commitSha))
    return;
  prepare.mutate({
    body: { revision: reviewed.value.revision, selection: selection.value },
    fingerprint: fingerprint.value,
    generation: ++previewGeneration,
  });
}
const deploy = useMutation({
  mutationFn: (input: DeployServiceInput) =>
    api.create<Deployment>(
      props.retryOf
        ? '/deployments/' + props.retryOf.id + '/retry'
        : '/services/' + reviewed.value.id + '/deployments',
      input,
      key,
    ),
  onSuccess: async (value) => {
    queryClient.setQueryData(['deployment', value.id], value);
    await Promise.all([
      invalidateGitService(reviewed.value.id),
      invalidateStorage(reviewed.value.id),
    ]);
    if (active()) emit('submitted', value);
  },
});
const allowed = computed(
  () =>
    !stale.value &&
    !auth.restoreMode &&
    !props.service.activeTask &&
    !deploy.isPending.value &&
    !prepare.isPending.value &&
    !retryBlocked.value &&
    (!needsPreview.value || (!!preview.value && !blockingIssues.value.length)) &&
    (props.retryOf
      ? storageSnapshotComplete(props.retryOf.snapshot)
      : preview.value
        ? storageSnapshotComplete(preview.value.snapshot)
        : storageReady.value) &&
    (!needsStart.value || start.value) &&
    (!needsRepair.value || repair.value),
);
function submit() {
  if (
    !allowed.value ||
    (preview.value && !previewIsCurrent(preview.value, props.service.revision, Date.now()))
  )
    return;
  deploy.mutate({
    revision: reviewed.value.revision,
    deployAndStart: start.value,
    allowConfigurationRepair: repair.value,
    ...(needsPreview.value && preview.value ? { previewId: preview.value.id } : {}),
  });
}
onScopeDispose(() => previewAbort?.abort());
</script>
<template>
  <section class="panel" data-deployment-review>
    <div class="section-head">
      <div>
        <h2>{{ retryOf ? '审阅原部署重试' : '发布预览' }}</h2>
        <p class="meta mt-1">
          {{ reviewed.project.name }} / {{ reviewed.environment.name }} →
          {{ reviewed.cluster.name }}
        </p>
      </div>
      <span class="badge badge-primary"
        >{{ retryOf ? '固定原快照' : '已保存草稿' }} r{{
          retryOf?.configRevision ?? reviewed.configRevision
        }}</span
      >
    </div>
    <div v-if="stale" class="notice notice-warning mb-5">
      <Info />
      <div>
        <strong>{{
          previewExpired ? '提交预览已过期，需要重新审阅' : '服务资料已更新，需要重新审阅'
        }}</strong>
        <p>
          {{
            previewExpired
              ? '重新读取固定提交与配置快照后，才能确认发布。'
              : '预览仍保留你刚才看到的版本，发布按钮暂不可用。'
          }}
        </p>
        <Button variant="outline" class="mt-3" @click="refreshReview">载入最新预览</Button>
      </div>
    </div>
    <div v-if="service.activeTask" class="notice mb-5">
      <Info />
      <p>
        此服务已有正在执行的变更。<RouterLink
          :to="taskLocation(service.activeTask)"
          class="text-link"
          >查看当前任务</RouterLink
        >
      </p>
    </div>
    <div v-if="needsPreview" class="git-preview-selection mb-6">
      <div v-if="pendingTargetId" class="notice mb-4">
        <Info />
        <p>审阅所选待发布提交，使用该投递保留的来源版本与当前已保存运行配置。</p>
      </div>
      <template v-else>
        <fieldset
          class="git-commit-options"
          :disabled="prepare.isPending.value || deploy.isPending.value"
        >
          <legend class="font-medium mb-2">选择发布提交</legend>
          <label
            ><input
              v-model="selectionKind"
              type="radio"
              value="branch_head"
              :name="'commit-selection-' + reviewed.id"
            />读取跟踪分支的当前提交</label
          >
          <label
            ><input
              v-model="selectionKind"
              type="radio"
              value="commit"
              :name="'commit-selection-' + reviewed.id"
            />指定完整 commit</label
          >
        </fieldset>
        <div v-if="selectionKind === 'commit'" class="field mt-3">
          <label :for="'git-commit-' + reviewed.id">完整 commit SHA</label>
          <Input
            :id="'git-commit-' + reviewed.id"
            v-model="commitSha"
            class="mono"
            minlength="40"
            maxlength="40"
            pattern="[0-9a-f]{40}"
            autocomplete="off"
            :disabled="deploy.isPending.value"
          />
          <p class="field-hint">40 位小写十六进制，后端将核对它属于授权仓库。</p>
        </div>
      </template>
      <div class="flex flex-wrap items-center gap-3 mt-4">
        <Button
          variant="outline"
          :disabled="
            auth.restoreMode ||
            !!service.activeTask ||
            prepare.isPending.value ||
            deploy.isPending.value ||
            reviewed.revision !== service.revision ||
            (selection.kind === 'commit' && !/^[0-9a-f]{40}$/.test(selection.commitSha))
          "
          @click="preparePreview"
        >
          <LoaderCircle v-if="prepare.isPending.value" class="animate-spin" />{{
            preview ? '重新读取提交预览' : '读取固定提交预览'
          }}
        </Button>
        <span class="meta">此步骤只保存审阅快照，尚未开始构建。</span>
      </div>
      <ServiceMutationError class="mt-4" :error="prepare.error.value" />
      <div v-if="preview" class="mt-5">
        <GitSourceSummary
          :revision="preview.source.revision"
          :commit-sha="preview.source.commitSha"
        />
        <p class="meta mt-4">
          运行配置 r{{ preview.configRevision }} · 检查于 {{ dateTime(preview.checkedAt) }} ·
          预览有效至 {{ dateTime(preview.expiresAt) }}
        </p>
        <ul
          v-if="preview.issues.length"
          class="preview-issues mt-4"
          :class="{ 'text-destructive': blockingIssues.length }"
          aria-label="发布预览检查"
        >
          <li v-for="issue in preview.issues" :key="issue.code + ':' + (issue.field || '')">
            {{ issue.message }}<code class="meta ml-2">{{ issue.code }}</code>
          </li>
        </ul>
      </div>
    </div>
    <div v-if="retryOf" class="notice mb-5">
      <RotateCcw />
      <p>
        重试原记录
        {{
          retryOf.id
        }}，继续使用原目标、配置、数据卷、数据库连接引用和已解析的镜像摘要。当前草稿不会替换原快照。
      </p>
    </div>
    <div v-if="retryOf && isGit" class="notice mb-5" :class="{ 'notice-warning': retryBlocked }">
      <Info />
      <div>
        <p>{{ artifactRetryDescription(retryOf.build) }}</p>
        <p
          v-if="retryOf.build && retryOf.build.artifact.state !== 'none'"
          class="mono break-all mt-2"
        >
          {{ retryOf.build.artifact.rootDigest }}
        </p>
      </div>
    </div>
    <GitSourceSummary
      v-if="retryOf && fixedGitSource"
      class="mb-6"
      :revision="fixedGitSource.revision"
      :commit-sha="fixedGitSource.commitSha"
    />
    <p v-if="!needsPreview || preview" class="meta mb-4">
      比较基准：{{
        reviewed.published
          ? `最近完整应用的配置 r${reviewed.published.configRevision}`
          : '尚无已发布配置'
      }}。健康检查失败不代表配置没有应用。
    </p>
    <div
      v-if="changes.length && (!needsPreview || preview)"
      class="table-wrap"
      tabindex="0"
      role="region"
      aria-label="已发布配置与待发布配置差异"
    >
      <table class="data-table diff-table">
        <thead>
          <tr>
            <th>配置项</th>
            <th>已发布</th>
            <th>待发布</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="change in changes" :key="change.key">
            <th>{{ change.label }}</th>
            <td>
              <code>{{ change.before }}</code>
            </td>
            <td>
              <code>{{ change.after }}</code>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!needsPreview || preview" class="muted py-6">
      与最近完整应用的配置一致。继续发布会创建新的部署记录，并重新确认运行状态。
    </p>
    <div class="storage-review mt-6">
      <DeploymentStorageSnapshot v-if="retryOf" :snapshot="retryOf.snapshot" />
      <DeploymentStorageSnapshot v-else-if="preview" :snapshot="preview.snapshot" />
      <ServiceStorageReview
        v-else-if="!needsPreview"
        :key="`${reviewed.id}:${reviewed.revision}`"
        :service="reviewed"
        @ready="storageReady = $event"
      />
    </div>
    <div class="review-confirmations mt-6">
      <label v-if="needsStart" class="review-check"
        ><input v-model="start" type="checkbox" :disabled="stale || deploy.isPending.value" /><span
          ><strong>发布并启动这个已停止的服务</strong
          ><small>使用本次快照启动；单独“恢复运行”只恢复原已发布版本。</small></span
        ></label
      >
      <label v-if="needsRepair" class="review-check"
        ><input v-model="repair" type="checkbox" :disabled="stale || deploy.isPending.value" /><span
          ><strong>按此完整配置修复当前不一致状态</strong
          ><small>当前配置为部分应用、漂移或待核对。仅对已确认归属的资源执行修复。</small></span
        ></label
      >
    </div>
    <ServiceMutationError class="mt-5" :error="deploy.error.value" />
    <div class="form-footer">
      <span class="meta flex items-center gap-2"
        ><ShieldCheck class="size-4" />异步执行，可离开页面后查看结果</span
      ><Button :disabled="!allowed" @click="submit"
        ><LoaderCircle v-if="deploy.isPending.value" class="animate-spin" />{{
          deploy.isPending.value
            ? '正在受理…'
            : retryOf
              ? '确认创建重试部署'
              : needsStart
                ? '确认发布并启动'
                : '确认发布'
        }}<ArrowRight v-if="!deploy.isPending.value"
      /></Button>
    </div>
  </section>
</template>
<style scoped>
.git-commit-options {
  border: 0;
  padding: 0;
}
.git-commit-options label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
}
.preview-issues {
  list-style: disc;
  padding-left: 1.25rem;
  overflow-wrap: anywhere;
}
.preview-issues li + li {
  margin-top: 0.5rem;
}
.storage-review {
  border-top: 1px solid var(--border);
  padding-top: 1.5rem;
}
.diff-table {
  min-width: 42rem;
  table-layout: fixed;
}
.diff-table th:first-child {
  width: 23%;
}
.diff-table td,
.diff-table th {
  vertical-align: top;
}
.diff-table code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.review-check {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--secondary);
}
.review-check + .review-check {
  margin-top: 0.75rem;
}
.review-check input {
  margin-top: 0.3rem;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}
.review-check small {
  display: block;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}
</style>
