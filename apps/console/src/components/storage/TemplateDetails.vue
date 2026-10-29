<script setup lang="ts">
import { Database, Package, ExternalLink } from '@lucide/vue';
import type { Template } from './types';
defineProps<{ template: Template }>();
</script>
<template>
  <section class="panel" data-template-details>
    <div class="section-head">
      <div>
        <h2 class="flex items-center gap-2">
          <Database v-if="template.category === 'database'" class="size-5" /><Package
            v-else
            class="size-5"
          />{{ template.name }}
        </h2>
        <p class="meta mt-2">模板 {{ template.version }}</p>
      </div>
      <span class="badge">{{ template.persistent ? '持久化数据' : '无数据卷' }}</span>
    </div>
    <p>{{ template.description }}</p>
    <dl class="storage-facts mt-5">
      <div>
        <dt>工作负载</dt>
        <dd>{{ template.controller.kind }} · {{ template.controller.strategy }} · 单服务</dd>
      </div>
      <div>
        <dt>默认资源</dt>
        <dd>
          CPU {{ template.resources.requests.cpuMillis }}m /
          {{ template.resources.limits.cpuMillis }}m · 内存
          {{ template.resources.requests.memoryMiB }} /
          {{ template.resources.limits.memoryMiB }} MiB
        </dd>
      </div>
      <div v-if="template.image">
        <dt>已核验镜像</dt>
        <dd class="mono break-all">
          {{ template.image.reference }}
          <p class="meta mt-2">
            {{ template.image.version }} · {{ template.image.platforms.join(' / ') }}
          </p>
        </dd>
      </div>
      <div>
        <dt>来源与许可证</dt>
        <dd>
          <a
            :href="template.sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-link inline-flex items-center gap-1"
            >查看来源<ExternalLink class="size-3.5" /></a
          ><span class="meta ml-3">{{ template.license }}</span>
        </dd>
      </div>
    </dl>
    <ul v-if="template.notes.length" class="template-notes">
      <li v-for="note in template.notes" :key="note">{{ note }}</li>
    </ul>
  </section>
</template>
<style scoped>
.template-notes {
  margin-top: 1.25rem;
  padding: 1.25rem 0 0 1.125rem;
  border-top: 1px solid var(--border);
  list-style: disc;
  font-size: 0.875rem;
  color: var(--muted-foreground);
}
.template-notes li + li {
  margin-top: 0.625rem;
}
</style>
