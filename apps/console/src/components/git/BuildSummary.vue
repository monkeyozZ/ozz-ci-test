<script setup lang="ts">
import { computed } from 'vue';
import { Info } from '@lucide/vue';
import { dateTime } from '@/lib/utils';
import { stageLabels } from '@/components/services/presentation';
import { artifactRetryDescription, buildStillOpen } from './presentation';
import type { BuildDetail } from './types';
const props = defineProps<{ build: BuildDetail | null }>();
const artifact = computed(() => props.build?.artifact);
const availability: Record<string, string> = {
  available: '已确认可用',
  unknown: '可用性待核对',
  missing: '原产物缺失',
  expired: '原产物已过期',
};
const execution: Record<string, string> = {
  prepared: '准备远端执行',
  open: '执行尚未确认结束',
  never_submitted: '未发送执行请求',
  ended: '执行已结束',
};
const observation: Record<string, string> = {
  reachable: '最近观察可达',
  unknown: '当前观察未知',
  unobserved: '尚无远端观察',
};
</script>
<template>
  <section class="panel" data-build-summary>
    <div class="section-head">
      <h2>构建与原产物</h2>
      <span v-if="build?.reuseArtifactId" class="badge">复用原产物</span>
    </div>
    <p v-if="!build" class="meta">构建资料尚未载入，不能推断原执行或产物状态。</p>
    <template v-else>
      <div
        v-if="buildStillOpen(build) && build.runs.some((run) => run.observationState === 'unknown')"
        class="notice notice-warning mb-5"
      >
        <Info />
        <p>
          Builder 观察未知，远端执行尚未确认结束。任务保留当前状态与占用，取消请求仍需取得结束证明。
        </p>
      </div>
      <p v-if="artifact?.state === 'none'" class="meta">
        尚无已登记产物。{{ artifactRetryDescription(build) }}
      </p>
      <template v-else-if="artifact">
        <p class="font-medium">
          {{
            artifact.state === 'oci'
              ? '已生成 OCI，尚未完成推送'
              : artifact.image
                ? '已推送并核验镜像'
                : '已推送，等待独立镜像核验'
          }}
        </p>
        <p class="meta mt-2">推送完成与应用健康分别记录，服务发布结果见配置应用和健康检查。</p>
        <dl class="artifact-fields mt-5">
          <div>
            <dt>原 digest</dt>
            <dd class="mono">{{ artifact.rootDigest }}</dd>
          </div>
          <div>
            <dt>可用性</dt>
            <dd>{{ availability[artifact.availability] || artifact.availability }}</dd>
          </div>
          <div>
            <dt>固定 commit</dt>
            <dd class="mono">{{ artifact.commitSha }}</dd>
          </div>
          <div>
            <dt>镜像去向</dt>
            <dd class="mono">
              {{ artifact.destination.authority }}/{{ artifact.destination.repository }}
            </dd>
          </div>
          <div>
            <dt>产物平台</dt>
            <dd>
              {{ artifact.platforms.map((item) => item.os + '/' + item.architecture).join('、') }}
            </dd>
          </div>
          <div v-if="artifact.state === 'oci'">
            <dt>OCI 保留期限</dt>
            <dd>{{ dateTime(artifact.archiveExpiresAt) }} · {{ artifact.archiveBytes }} 字节</dd>
          </div>
          <div v-if="artifact.pushedAt">
            <dt>推送确认</dt>
            <dd>{{ dateTime(artifact.pushedAt) }}</dd>
          </div>
          <div v-if="artifact.lastVerifiedAt">
            <dt>最近镜像核验</dt>
            <dd>{{ dateTime(artifact.lastVerifiedAt) }}</dd>
          </div>
        </dl>
        <p class="meta mt-5">{{ artifactRetryDescription(build) }}</p>
      </template>
      <details v-if="build.runs.length" class="mt-6">
        <summary>构建执行记录 · {{ build.runs.length }} 次</summary>
        <ol class="build-runs mt-4">
          <li v-for="run in build.runs" :key="run.id">
            <strong>执行 {{ run.runNumber }} · {{ stageLabels[run.phase] || run.phase }}</strong>
            <p class="meta mt-2">
              {{ execution[run.executionState] || run.executionState }} ·
              {{ observation[run.observationState] || run.observationState }}
            </p>
            <p class="meta mt-1">
              最近观察：{{ run.lastObservedAt ? dateTime(run.lastObservedAt) : '尚无观察' }}
            </p>
            <p v-if="run.cancelRequestedAt" class="meta mt-1">
              已请求取消：{{ dateTime(run.cancelRequestedAt) }}
            </p>
            <p v-if="run.proofVerifiedAt" class="meta mt-1">
              结束证明已核验：{{ dateTime(run.proofVerifiedAt) }}
            </p>
            <p v-if="run.lastErrorCode || run.closureReason" class="mono meta mt-2 break-all">
              {{ run.lastErrorCode }} {{ run.closureReason }}
            </p>
            <p class="mono meta mt-2 break-all">
              执行 {{ run.id }} · Builder {{ run.builderInstanceId }}
            </p>
          </li>
        </ol>
      </details>
    </template>
  </section>
</template>
<style scoped>
.artifact-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem 1.5rem;
}
dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  margin-bottom: 0.375rem;
}
dd {
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}
summary {
  cursor: pointer;
  min-height: 2.75rem;
}
.build-runs {
  padding: 0;
  list-style: none;
  display: grid;
  gap: 1rem;
}
.build-runs li {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
}
@media (max-width: 640px) {
  .artifact-fields {
    grid-template-columns: 1fr;
  }
}
</style>
