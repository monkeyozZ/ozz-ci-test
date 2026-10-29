<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, HardDrive, Info } from '@lucide/vue';
import type { Deployment } from '@/components/services/types';
import { formatStorageBytes } from './format';
import { databaseOutputLabel, storageSnapshotComplete } from './publication';

const props = defineProps<{ snapshot: Deployment['snapshot'] }>();
const complete = computed(() => storageSnapshotComplete(props.snapshot));
</script>

<template>
  <div data-deployment-storage-snapshot>
    <h3>固定控制器与数据引用</h3>
    <p v-if="snapshot.version === 1" class="meta mt-3">
      这条历史记录使用 v1 快照，没有独立的存储与数据库引用字段。重试保留原记录，不补入当前草稿引用。
    </p>
    <div v-else-if="!complete" class="notice notice-danger mt-3">
      <AlertCircle />
      <p>v{{ snapshot.version }} 快照的数据引用不完整，无法确认本次发布范围。请核对原部署记录。</p>
    </div>
    <template v-else>
      <dl class="storage-facts mt-4">
        <div>
          <dt>工作负载</dt>
          <dd>{{ snapshot.controller?.kind }} · {{ snapshot.controller?.strategy }}</dd>
        </div>
        <div>
          <dt>{{ snapshot.version === 3 ? '代码来源' : '来源模板' }}</dt>
          <dd v-if="snapshot.version === 3">
            GitHub · Dockerfile 构建
            <span class="block meta mt-1 mono break-all">{{
              snapshot.source.revision.dockerfilePath
            }}</span>
          </dd>
          <dd v-else>
            {{
              snapshot.template
                ? `${snapshot.template.id} · ${snapshot.template.version}`
                : '自定义镜像'
            }}
          </dd>
        </div>
      </dl>
      <div v-if="snapshot.controller?.strategy === 'Recreate'" class="notice notice-warning mt-4">
        <Info />
        <p>Recreate 会先停止旧实例，再启动使用同一数据卷的新实例；发布期间服务会中断。</p>
      </div>
      <h4 class="font-medium mt-6">持久卷 · {{ snapshot.volumes?.length ?? 0 }}</h4>
      <ul v-if="snapshot.volumes?.length" class="snapshot-reference-list mt-3">
        <li v-for="volume in snapshot.volumes" :key="volume.mountId">
          <RouterLink :to="`/volumes/${volume.volumeId}`" class="text-link mono">{{
            volume.volumeId
          }}</RouterLink>
          <dl class="storage-facts mt-3">
            <div>
              <dt>挂载位置</dt>
              <dd class="mono">{{ volume.mountPath }} · {{ volume.readOnly ? '只读' : '可写' }}</dd>
            </div>
            <div>
              <dt>PVC 身份</dt>
              <dd class="mono">
                {{ volume.pvcName
                }}<span class="block meta mt-1">UID {{ volume.pvcUid ?? '受理时尚未创建' }}</span>
              </dd>
            </div>
            <div>
              <dt>存储申请</dt>
              <dd>
                {{ volume.storageClassName }} · {{ formatStorageBytes(volume.requestedBytes) }} ·
                r{{ volume.volumeRevision }}
              </dd>
            </div>
          </dl>
        </li>
      </ul>
      <p v-else class="meta mt-2">原快照没有持久卷挂载。</p>
      <div v-if="snapshot.database" class="notice mt-5">
        <HardDrive />
        <div class="min-w-0">
          <strong
            >{{ snapshot.database.engine }} {{ snapshot.database.exactVersion }} ·
            数据身份受保护</strong
          >
          <RouterLink
            :to="`/databases/${snapshot.database.databaseInstanceId}`"
            class="text-link mono block mt-2"
            >{{ snapshot.database.databaseInstanceId }}</RouterLink
          >
          <p class="meta mono mt-2 break-all">
            凭证引用 {{ snapshot.database.credentialRefId }} · 内容 r{{
              snapshot.database.credentialContentRevision
            }}
          </p>
          <p class="meta mt-2">
            数据目录
            {{ snapshot.database.dataLayout }}。停止、部署失败和服务删除都保留既有数据保护。
          </p>
        </div>
      </div>
      <h4 class="font-medium mt-6">数据库连接 · {{ snapshot.databaseBindings?.length ?? 0 }}</h4>
      <ul v-if="snapshot.databaseBindings?.length" class="snapshot-reference-list mt-3">
        <li v-for="binding in snapshot.databaseBindings" :key="binding.bindingId">
          <RouterLink :to="`/databases/${binding.databaseInstanceId}`" class="text-link mono">{{
            binding.databaseInstanceId
          }}</RouterLink>
          <p class="meta mono mt-2 break-all">
            原提供方 Service UID {{ binding.providerServiceUid }}
          </p>
          <p class="meta mt-2">
            原提供方部署
            <RouterLink
              :to="`/deployments/${binding.providerDeploymentId}`"
              class="text-link mono"
              >{{ binding.providerDeploymentId }}</RouterLink
            >
          </p>
          <dl class="storage-facts mt-3">
            <div>
              <dt>连接范围</dt>
              <dd class="mono">{{ binding.namespace }} · {{ binding.host }}:{{ binding.port }}</dd>
            </div>
            <div>
              <dt>凭证身份</dt>
              <dd class="mono">
                {{ binding.credentialRefId }} · 内容 r{{ binding.credentialContentRevision }}
              </dd>
            </div>
            <div>
              <dt>变量映射</dt>
              <dd>
                <ul class="space-y-1">
                  <li v-for="(name, output) in binding.mapping" :key="output">
                    <code>{{ name }}</code> ← {{ databaseOutputLabel[output] ?? output }}
                  </li>
                </ul>
              </dd>
            </div>
          </dl>
        </li>
      </ul>
      <p v-else class="meta mt-2">原快照没有数据库连接引用。</p>
    </template>
  </div>
</template>

<style scoped>
.snapshot-reference-list {
  display: grid;
  gap: 1rem;
}
.snapshot-reference-list > li {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
