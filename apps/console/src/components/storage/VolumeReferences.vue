<script setup lang="ts">
import { AlertCircle } from '@lucide/vue';
import { dateTime } from '@/lib/utils';
import type { Volume, VolumeMount } from './types';
defineProps<{ volume: Volume }>();
const serviceLink = (volume: Volume, mount: VolumeMount) =>
  volume.project && mount.serviceId
    ? `/projects/${volume.project.id}/services/${mount.serviceId}?tab=storage`
    : null;
</script>
<template>
  <section class="panel" data-volume-references>
    <div class="section-head">
      <div>
        <h2>引用与实际挂载</h2>
        <p class="meta mt-2">草稿、已发布配置和实际 Pod 分别核对</p>
      </div>
    </div>
    <div v-if="volume.mounts.truncated" class="notice notice-warning mb-5">
      <AlertCircle />
      <p>这里只展示部分引用。不能据此判断卷已空闲；销毁和维护会重新核对完整记录。</p>
    </div>
    <div class="reference-section">
      <h3>
        草稿引用 <span class="meta">{{ volume.mounts.desired.length }}</span>
      </h3>
      <ul v-if="volume.mounts.desired.length" class="reference-list">
        <li v-for="mount in volume.mounts.desired" :key="mount.id">
          <RouterLink
            v-if="serviceLink(volume, mount)"
            :to="serviceLink(volume, mount)!"
            class="text-link font-medium"
            >{{ mount.service?.name ?? mount.serviceId }}</RouterLink
          ><span v-else>原服务已删除</span>
          <p class="mono mt-1">
            {{ mount.mountPath }} <span class="meta">· {{ mount.readOnly ? '只读' : '可写' }}</span>
          </p>
        </li>
      </ul>
      <p v-else class="meta mt-3">当前返回的草稿中没有引用。</p>
    </div>
    <div class="reference-section">
      <h3>
        已发布引用 <span class="meta">{{ volume.mounts.published.length }}</span>
      </h3>
      <ul v-if="volume.mounts.published.length" class="reference-list">
        <li v-for="mount in volume.mounts.published" :key="mount.id">
          <RouterLink
            v-if="serviceLink(volume, mount)"
            :to="serviceLink(volume, mount)!"
            class="text-link font-medium"
            >{{ mount.service?.name ?? mount.serviceId }}</RouterLink
          ><span v-else>原服务已删除</span>
          <p class="mono mt-1">
            {{ mount.mountPath }} <span class="meta">· {{ mount.readOnly ? '只读' : '可写' }}</span>
          </p>
          <RouterLink
            v-if="mount.lastPublishedDeploymentId"
            :to="`/deployments/${mount.lastPublishedDeploymentId}`"
            class="text-link text-sm mt-2 inline-block"
            >查看固定部署</RouterLink
          >
          <p v-if="!mount.desired" class="meta mt-2">草稿已解除，仍需发布并核对实际卸载。</p>
          <p v-if="mount.detachedAt" class="meta mt-2">卸载记录 {{ dateTime(mount.detachedAt) }}</p>
        </li>
      </ul>
      <p v-else class="meta mt-3">当前返回的已发布配置中没有引用。</p>
    </div>
    <div class="reference-section">
      <h3>
        实际 Pod 占用 <span class="meta">{{ volume.mounts.actual.length }}</span>
      </h3>
      <p class="meta mt-2">
        {{
          volume.observation.observedAt
            ? `观察于 ${dateTime(volume.observation.observedAt)}`
            : '尚无运行观察'
        }}{{ volume.observation.stale ? ' · 观察已过期' : '' }}
      </p>
      <ul v-if="volume.mounts.actual.length" class="reference-list">
        <li v-for="mount in volume.mounts.actual" :key="mount.podUid">
          <p class="mono">{{ mount.podName }}</p>
          <p class="meta mt-2">
            {{ mount.nodeName ?? '节点未知' }} · {{ mount.phase
            }}{{ mount.deleting ? ' · 删除中' : '' }} · {{ mount.readOnly ? '只读' : '可写' }}
          </p>
          <p class="mono text-sm mt-2">{{ mount.paths.join('、') || '路径待确认' }}</p>
          <p class="meta mt-2">
            {{
              mount.controller
                ? `${mount.controller.kind} / ${mount.controller.name}`
                : '归属控制器未确认'
            }}
          </p>
          <p class="mono meta mt-2">Pod UID {{ mount.podUid }}</p>
        </li>
      </ul>
      <p v-else class="meta mt-3">本次结果未列出 Pod 占用；操作前仍需检查观察时效与完整性。</p>
    </div>
  </section>
</template>
<style scoped>
.reference-section + .reference-section {
  border-top: 1px solid var(--border);
  margin-top: 1.5rem;
  padding-top: 1.5rem;
}
.reference-list {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}
.reference-list li {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow-wrap: anywhere;
}
</style>
