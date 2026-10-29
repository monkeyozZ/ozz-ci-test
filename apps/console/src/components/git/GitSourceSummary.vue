<script setup lang="ts">
import type { GitSourceRevision } from './types';
defineProps<{ revision: GitSourceRevision; commitSha?: string }>();
</script>
<template>
  <dl class="git-source-summary" data-git-source-summary>
    <div>
      <dt>仓库 / 分支</dt>
      <dd class="mono break-all">
        {{ revision.repository.fullNameAtCapture }}
        <p class="meta mt-1">{{ revision.branchRef }}</p>
      </dd>
    </div>
    <div>
      <dt>{{ commitSha ? '固定 commit' : '来源版本' }}</dt>
      <dd class="mono break-all">
        {{ commitSha || 'r' + revision.revision }}
        <p v-if="commitSha" class="meta mt-1">来源 r{{ revision.revision }} · {{ revision.id }}</p>
      </dd>
    </div>
    <div>
      <dt>Dockerfile / 上下文</dt>
      <dd class="mono break-all">
        {{ revision.dockerfilePath }}
        <p class="meta mt-1">{{ revision.contextPath }}</p>
      </dd>
    </div>
    <div>
      <dt>构建架构</dt>
      <dd>{{ revision.platforms.map((item) => item.os + '/' + item.architecture).join('、') }}</dd>
    </div>
    <div>
      <dt>产物去向</dt>
      <dd class="mono break-all">
        {{ revision.destination.authority }}/{{ revision.destination.repository }}
      </dd>
    </div>
    <div>
      <dt>Builder</dt>
      <dd class="mono break-all">
        {{ revision.builder.builderId }}
        <p class="meta mt-1">
          配置 r{{ revision.builder.profileRevision }} · BuildKit
          {{ revision.builder.buildkitVersion }}
        </p>
      </dd>
    </div>
  </dl>
</template>
<style scoped>
.git-source-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem 1.5rem;
}
dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  margin-bottom: 0.375rem;
}
dd {
  min-width: 0;
  font-size: 0.875rem;
}
@media (max-width: 640px) {
  .git-source-summary {
    grid-template-columns: 1fr;
  }
}
</style>
