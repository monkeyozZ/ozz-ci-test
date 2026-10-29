<script setup lang="ts">
import type { TemplatePreview } from './types';
import StorageIssues from './StorageIssues.vue';
import { formatStorageBytes } from './format';
defineProps<{ preview: TemplatePreview; stale?: boolean }>();
</script>
<template>
  <section class="panel" data-template-preview aria-label="生成配置预览">
    <div class="section-head">
      <div>
        <h2>生成配置预览</h2>
        <p class="meta mt-2">{{ preview.template.id }} · {{ preview.template.version }}</p>
      </div>
      <span :class="['badge', stale ? 'badge-warning' : 'badge-primary']">{{
        stale ? '参数已变化，请重新预览' : '尚未创建服务'
      }}</span>
    </div>
    <StorageIssues :issues="preview.issues" title="模板检查" class="mb-5" />
    <dl class="storage-facts">
      <div>
        <dt>镜像</dt>
        <dd class="mono break-all">{{ preview.configuration.image }}</dd>
      </div>
      <div>
        <dt>控制器与副本</dt>
        <dd>
          {{ preview.controller.kind }} · {{ preview.controller.strategy }} ·
          {{ preview.configuration.replicas }} 副本
        </dd>
      </div>
      <div>
        <dt>端口</dt>
        <dd>
          <p v-for="port in preview.configuration.ports" :key="port.name" class="mono">
            {{ port.name }} · {{ port.containerPort }} → {{ port.servicePort }} /
            {{ port.protocol }}
          </p>
          <span v-if="!preview.configuration.ports.length">没有暴露端口</span>
        </dd>
      </div>
      <div>
        <dt>资源</dt>
        <dd>
          CPU {{ preview.configuration.resources.requests.cpuMillis }}m /
          {{ preview.configuration.resources.limits.cpuMillis }}m · 内存
          {{ preview.configuration.resources.requests.memoryMiB }} /
          {{ preview.configuration.resources.limits.memoryMiB }} MiB
        </dd>
      </div>
      <div>
        <dt>就绪探针</dt>
        <dd>
          {{
            preview.configuration.readiness
              ? `${preview.configuration.readiness.type} 检查`
              : '未配置'
          }}
        </dd>
      </div>
      <div>
        <dt>启动探针</dt>
        <dd>
          {{
            preview.configuration.startup ? `${preview.configuration.startup.type} 检查` : '未配置'
          }}
        </dd>
      </div>
      <div>
        <dt>数据卷计划</dt>
        <dd>
          <p v-for="(volume, index) in preview.plannedVolumes" :key="index">
            {{ formatStorageBytes(volume.requestedBytes) }} · {{ volume.storageClassName }} ·
            <span class="mono">{{ volume.mountPath }}</span>
          </p>
          <span v-if="!preview.plannedVolumes.length">不创建数据卷</span>
        </dd>
      </div>
      <div v-if="preview.plannedCredentials.length">
        <dt>凭证计划</dt>
        <dd>保存时生成 {{ preview.plannedCredentials.length }} 个数据库凭证引用</dd>
      </div>
    </dl>
    <p class="meta mt-5">预览尚未分配服务、卷或凭证身份。保存后进入统一发布预览。</p>
    <slot />
  </section>
</template>
