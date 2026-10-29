<script setup lang="ts">
import { AlertCircle, Check, CircleHelp, Info } from '@lucide/vue';
import { dateTime } from '@/lib/utils';
import { bytesLabel, cpuLabel, sampleFreshness, usagePercent } from './format';
import type { ClusterNode } from './types';
import { useObservationClock } from './useObservationClock';

const props = defineProps<{
  nodes: ClusterNode[];
  reachable: boolean;
  observedAt: string | null;
  metricsState?: string;
}>();
const now = useObservationClock();
function current(node: ClusterNode) {
  return (
    props.reachable && node.present && sampleFreshness(node.lastObservedAt, now.value) === 'fresh'
  );
}
function metricState(node: ClusterNode) {
  if (node.metrics.state !== 'available') return 'unknown';
  if (!current(node)) return node.metrics.observedAt ? 'stale' : 'unknown';
  return sampleFreshness(node.metrics.observedAt, now.value);
}
function percentage(used: number | null, capacity: number | null) {
  const value = usagePercent(used, capacity);
  return value === null ? '比例未知' : `占容量 ${value}%`;
}
</script>

<template>
  <section data-node-inventory>
    <div class="section-head">
      <div>
        <h2>节点</h2>
        <p class="meta mt-1">
          已载入 {{ nodes.length }} 条节点记录 · 最近成功观察 {{ dateTime(observedAt) }}
        </p>
      </div>
      <slot name="actions" />
    </div>
    <div v-if="!reachable && nodes.length" class="notice notice-warning mb-5" role="status">
      <CircleHelp aria-hidden="true" />
      <p>当前连接或观察已过期。下面保留最后一次成功采集的节点资料，当前运行状态与资源用量未知。</p>
    </div>
    <div v-if="metricsState && metricsState !== 'available' && nodes.length" class="notice mb-5">
      <Info aria-hidden="true" />
      <p>
        {{
          metricsState === 'forbidden'
            ? '当前凭证无权读取 Metrics API。'
            : '当前没有可用的 Metrics API 采样。'
        }}CPU 与内存用量保留为未知，节点容量单独展示。
      </p>
    </div>
    <div
      v-if="nodes.length"
      class="table-wrap node-scroll"
      tabindex="0"
      role="region"
      aria-label="节点状态与资源，宽表可横向滚动"
    >
      <table class="data-table node-table">
        <thead>
          <tr>
            <th>节点 / 状态</th>
            <th>CPU</th>
            <th>内存</th>
            <th>临时存储</th>
            <th>关联服务器</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in nodes" :key="`${node.clusterId}:${node.uid}`">
            <td>
              <strong class="break-all">{{ node.name }}</strong>
              <p class="meta mono mt-1">
                {{ node.architecture || '架构未知' }} · {{ node.kubeletVersion || '版本未知' }}
              </p>
              <div class="actions mt-3">
                <span v-if="!current(node)" class="badge badge-warning"
                  ><CircleHelp />{{ node.present ? '当前状态未知' : '最近同步未发现' }}</span
                >
                <span v-else-if="node.conditions.ready === 'true'" class="badge badge-good"
                  ><Check />Ready</span
                >
                <span v-else-if="node.conditions.ready === 'false'" class="badge badge-danger"
                  ><AlertCircle />NotReady</span
                >
                <span v-else class="badge badge-warning"><CircleHelp />Ready 未知</span>
                <span v-if="node.unschedulable" class="badge"
                  >已暂停调度{{ current(node) ? '' : '（历史）' }}</span
                >
              </div>
              <details class="node-identity mt-3">
                <summary class="meta">节点身份与时间</summary>
                <dl class="mt-2 space-y-2 meta">
                  <div>
                    <dt>UID</dt>
                    <dd class="mono break-all">{{ node.uid }}</dd>
                  </div>
                  <div>
                    <dt>系统</dt>
                    <dd>{{ node.osImage || '未知' }}</dd>
                  </div>
                  <div>
                    <dt>节点观察</dt>
                    <dd>{{ dateTime(node.lastObservedAt) }}</dd>
                  </div>
                  <div>
                    <dt>指标采样</dt>
                    <dd>{{ dateTime(node.metrics.observedAt) }}</dd>
                  </div>
                </dl>
              </details>
            </td>
            <td>
              <p class="resource-value">
                {{ metricState(node) === 'unknown' ? '未知' : cpuLabel(node.metrics.cpuCores)
                }}<span v-if="metricState(node) === 'stale'" class="badge ml-2">历史</span>
              </p>
              <p class="meta mt-1">
                {{
                  metricState(node) === 'unknown'
                    ? '暂无可信采样'
                    : percentage(node.metrics.cpuCores, node.capacity.cpuCores)
                }}
              </p>
              <p class="meta mt-3">容量 {{ cpuLabel(node.capacity.cpuCores) }}</p>
              <p class="meta">可分配 {{ cpuLabel(node.allocatable.cpuCores) }}</p>
            </td>
            <td>
              <p class="resource-value">
                {{ metricState(node) === 'unknown' ? '未知' : bytesLabel(node.metrics.memoryBytes)
                }}<span v-if="metricState(node) === 'stale'" class="badge ml-2">历史</span>
              </p>
              <p class="meta mt-1">
                {{
                  metricState(node) === 'unknown'
                    ? '暂无可信采样'
                    : percentage(node.metrics.memoryBytes, node.capacity.memoryBytes)
                }}
              </p>
              <p class="meta mt-3">容量 {{ bytesLabel(node.capacity.memoryBytes) }}</p>
              <p class="meta">可分配 {{ bytesLabel(node.allocatable.memoryBytes) }}</p>
            </td>
            <td>
              <p class="resource-value">{{ bytesLabel(node.capacity.ephemeralStorageBytes) }}</p>
              <p class="meta mt-1">节点报告的容量</p>
              <p class="meta mt-3">
                可分配 {{ bytesLabel(node.allocatable.ephemeralStorageBytes) }}
              </p>
              <p
                :class="[
                  'meta mt-1',
                  { 'text-destructive': current(node) && node.conditions.diskPressure === 'true' },
                ]"
              >
                {{
                  !current(node)
                    ? '磁盘压力未知'
                    : node.conditions.diskPressure === 'true'
                      ? '存在磁盘压力'
                      : node.conditions.diskPressure === 'false'
                        ? '无磁盘压力'
                        : '磁盘压力未知'
                }}
              </p>
            </td>
            <td>
              <RouterLink v-if="node.serverId" :to="`/servers/${node.serverId}`" class="text-link"
                >查看 SSH 主机</RouterLink
              >
              <span v-else class="meta">未关联 SSH 主机</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted py-5">
      {{
        observedAt ? '本次观察尚无节点记录。' : '验证集群连接后，会在这里显示 API 实际返回的节点。'
      }}
    </p>
    <p v-if="nodes.length" class="meta mt-3">
      临时存储列显示 Kubernetes 节点报告的容量，不代表磁盘实时使用量。DiskPressure
      是节点压力状态，不能换算为已用空间。
    </p>
    <slot name="pagination" />
  </section>
</template>

<style scoped>
.node-table {
  min-width: 58rem;
}
.node-scroll {
  max-height: 40rem;
}
.node-table th {
  position: sticky;
  top: 0;
  z-index: 1;
}
.node-table td {
  vertical-align: top;
}
.node-table td:first-child {
  min-width: 15rem;
  max-width: 24rem;
}
.resource-value {
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.node-identity summary {
  cursor: pointer;
  padding: 0.25rem 0;
}
.node-identity dd {
  margin: 0.25rem 0 0;
}
</style>
