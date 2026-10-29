<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, HardDrive } from '@lucide/vue';
import NetworkObservationSection from '@/components/networking/NetworkObservationSection.vue';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import type { Volume } from './types';
import { formatStorageBytes } from './format';
import { volumeState } from './presentation';
const props = defineProps<{ volume: Volume }>();
const localityLabel = computed(
  () =>
    ({
      waiting_for_consumer: '等待首次使用后确认节点',
      verified: '已核对本地数据所在节点',
      unavailable: '数据所在节点不可用',
      unknown: '本地数据位置待确认',
    })[props.volume.locality],
);
</script>
<template>
  <section class="panel" data-volume-observations>
    <NetworkObservationSection
      title="PVC 与本地存储"
      :status="volumeState(volume)"
      :observed-at="volume.observation.observedAt"
      :stale="volume.observation.stale"
      :message="volume.observation.message"
    >
      <div class="volume-capacities mt-6">
        <div>
          <span class="meta">申请容量</span
          ><strong>{{ formatStorageBytes(volume.requestedBytes) }}</strong>
        </div>
        <div>
          <span class="meta">PV 报告容量</span
          ><strong>{{ formatStorageBytes(volume.pv?.capacityBytes) }}</strong>
        </div>
        <div>
          <span class="meta">实际用量</span
          ><strong>{{ formatStorageBytes(volume.usage.usedBytes) }}</strong>
        </div>
        <div>
          <span class="meta">节点可用空间</span
          ><strong>{{ formatStorageBytes(volume.usage.nodeAvailableBytes) }}</strong>
        </div>
      </div>
      <p class="field-hint mt-4">
        {{
          volume.hardQuotaSupport === 'unsupported'
            ? 'local-path 不提供写入硬配额，申请容量不能限制实际写入量。'
            : '当前未确认硬配额能力。'
        }}
        未采集的用量和节点空间显示为未知。
      </p>
      <dl class="storage-facts mt-6">
        <div>
          <dt>PVC</dt>
          <dd class="mono">
            {{ volume.pvc.name }}<span class="badge ml-2">{{ volume.pvc.phase }}</span
            ><span v-if="volume.pvc.deleting" class="meta ml-2">删除中</span>
          </dd>
        </div>
        <div>
          <dt>PVC UID</dt>
          <dd class="mono">{{ volume.pvc.uid ?? '尚未确认' }}</dd>
        </div>
        <div>
          <dt>PV</dt>
          <dd class="mono">{{ volume.pv?.name ?? '尚未绑定' }}</dd>
        </div>
        <div>
          <dt>PV UID</dt>
          <dd class="mono">{{ volume.pv?.uid ?? '尚未确认' }}</dd>
        </div>
        <div>
          <dt>StorageClass</dt>
          <dd>
            {{ volume.storageClassName
            }}<span v-if="!volume.storageClass" class="meta ml-2">尚无真实属性观察</span>
          </dd>
        </div>
        <div>
          <dt>绑定模式</dt>
          <dd>{{ volume.storageClass?.bindingMode ?? '尚未确认' }}</dd>
        </div>
        <div>
          <dt>实际回收策略</dt>
          <dd>
            {{ volume.pv?.reclaimPolicy ?? '尚未确认'
            }}<span class="meta ml-2">以 PV 实际观察为准</span>
          </dd>
        </div>
        <div>
          <dt>Provisioner</dt>
          <dd class="mono">
            {{ volume.pv?.provisioner ?? volume.storageClass?.provisioner ?? '尚未确认' }}
          </dd>
        </div>
        <div>
          <dt>Namespace</dt>
          <dd class="mono">{{ volume.namespace }}</dd>
        </div>
      </dl>
    </NetworkObservationSection>
    <NetworkObservationSection
      title="数据所在节点"
      :status="{
        label: localityLabel,
        tone:
          volume.locality === 'verified'
            ? 'good'
            : volume.locality === 'unavailable'
              ? 'danger'
              : 'warning',
      }"
      :observed-at="volume.observation.observedAt"
      :stale="volume.observation.stale"
    >
      <div v-if="volume.locality === 'waiting_for_consumer'" class="notice mt-4">
        <HardDrive />
        <p>
          这个 StorageClass 使用 WaitForFirstConsumer。PVC 创建任务完成后仍可能为
          Pending；可保存挂载草稿并发布第一个消费者。
        </p>
      </div>
      <ul v-if="volume.nodes.length" class="node-list mt-4">
        <li v-for="node in volume.nodes" :key="node.uid">
          <span class="mono">{{ node.name }}</span
          ><NetworkStateBadge
            :label="
              node.ready === true
                ? '节点就绪'
                : node.ready === false
                  ? '节点不可用'
                  : '节点状态未知'
            "
            :tone="node.ready === true ? 'good' : node.ready === false ? 'danger' : 'warning'"
          /><small class="mono meta">UID {{ node.uid }}</small>
        </li>
      </ul>
      <p v-else-if="volume.locality !== 'waiting_for_consumer'" class="meta mt-4">
        尚无可确认的节点身份。
      </p>
      <div class="notice mt-5">
        <AlertCircle />
        <p>本地卷的数据位于固定节点。重新调度到其他节点不会自动迁移这些文件。</p>
      </div>
    </NetworkObservationSection>
  </section>
</template>
<style scoped>
.volume-capacities {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1.25rem;
}
.volume-capacities strong {
  display: block;
  font-size: 1.5rem;
  margin-top: 0.375rem;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.node-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.node-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  padding: 1rem;
  background: var(--secondary);
  border-radius: 0.5rem;
}
.node-list small {
  flex-basis: 100%;
  overflow-wrap: anywhere;
}
@media (max-width: 850px) {
  .volume-capacities {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
