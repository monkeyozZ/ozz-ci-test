<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertCircle, Info, Search, ShieldCheck } from '@lucide/vue';
import { Input } from '@/components/ui/input';
import { dateTime } from '@/lib/utils';
import type { ClusterObservation } from './types';

const props = defineProps<{ observation: ClusterObservation; current: boolean }>();
const search = ref('');
const namespace = ref('');
const namespaces = computed(() =>
  [...new Set(props.observation.workloads.items.map((item) => item.namespace))].sort(),
);
const workloads = computed(() =>
  props.observation.workloads.items.filter(
    (item) =>
      (!namespace.value || item.namespace === namespace.value) &&
      `${item.name} ${item.kind} ${item.namespace}`
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
  ),
);
const stateLabels: Record<string, string> = {
  available: '已发现',
  unavailable: '未发现',
  forbidden: '无权检查',
  unknown: '未知',
};
const workloadLabels: Record<string, string> = {
  ready: '已就绪',
  not_ready: '未就绪',
  scaled_to_zero: '副本为零',
  pending: '等待处理',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  scheduled: '已调度',
  suspended: '已暂停',
  terminating: '正在终止',
  unknown: '未知',
};
function capabilityLabel(state: string) {
  return stateLabels[state] ?? '未知';
}
function permissionLabel(value: boolean | null) {
  return value === true ? '允许' : value === false ? '拒绝' : '未知';
}
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="section-head">
        <h2>连接能力与权限</h2>
        <span v-if="!current" class="badge badge-warning">最后一次成功观察</span>
      </div>
      <p class="meta mb-5">
        采集于
        {{ dateTime(observation.observedAt) }}。配置已发现与公网入口、卷读写实际验证分别记录。
      </p>
      <dl class="capability-list">
        <div>
          <dt>IngressClass</dt>
          <dd>
            <span class="badge">{{ capabilityLabel(observation.capabilities.ingress.state) }}</span>
            <p
              v-for="item in observation.capabilities.ingress.classes"
              :key="item.name"
              class="meta mt-2"
            >
              <code>{{ item.name }}</code
              >{{ item.isDefault ? ' · 默认' : ''
              }}<span class="block break-all">{{ item.controller }}</span>
            </p>
          </dd>
        </div>
        <div>
          <dt>Traefik</dt>
          <dd>
            <span class="badge">{{
              observation.capabilities.traefik.state === 'available'
                ? observation.capabilities.traefik.ready === true
                  ? 'Deployment 已就绪'
                  : observation.capabilities.traefik.ready === false
                    ? 'Deployment 未就绪'
                    : '就绪状态未知'
                : capabilityLabel(observation.capabilities.traefik.state)
            }}</span>
            <p class="meta mt-2">检查 kube-system / traefik；其他命名的安装不在本项检查范围内。</p>
          </dd>
        </div>
        <div>
          <dt>StorageClass</dt>
          <dd>
            <span class="badge">{{ capabilityLabel(observation.capabilities.storage.state) }}</span>
            <p
              v-for="item in observation.capabilities.storage.classes"
              :key="item.name"
              class="meta mt-2"
            >
              <code>{{ item.name }}</code
              >{{ item.isDefault ? ' · 默认' : ''
              }}<span class="block break-all">{{ item.provisioner }}</span
              ><span class="block"
                >{{ item.volumeBindingMode || '绑定方式未知' }} ·
                {{ item.reclaimPolicy || '回收方式未知' }}</span
              >
            </p>
            <p class="meta mt-2">这里只发现存储配置，尚不能证明数据卷的读写和持久性。</p>
          </dd>
        </div>
        <div>
          <dt>Metrics API</dt>
          <dd>
            <span class="badge">{{
              observation.capabilities.metrics.state === 'available'
                ? '可读取'
                : capabilityLabel(observation.capabilities.metrics.state)
            }}</span>
            <p class="meta mt-2">各节点的采样结果与时间在节点列表单独显示。</p>
          </dd>
        </div>
        <div>
          <dt>Secret 静态加密</dt>
          <dd>
            <span class="badge">未知</span>
            <p class="meta mt-2">
              标准 Kubernetes API 无法确认静态加密；由 Ozz 初始化的主机可在 SSH 预检中查看安装证据。
            </p>
          </dd>
        </div>
      </dl>
      <div
        v-if="observation.permissions.clusterWideAdmin === true"
        class="notice notice-warning mt-5"
      >
        <ShieldCheck />
        <p>当前凭证具备广泛的集群权限。以下明细保留实际检查的资源、操作和范围。</p>
      </div>
      <div v-else-if="observation.permissions.clusterWideAdmin === null" class="notice mt-5">
        <Info />
        <p>尚无法确定当前凭证是否具备广泛集群权限；未检查的操作不能视为已经授权。</p>
      </div>
      <details class="report-details mt-5">
        <summary>查看权限检查明细</summary>
        <div class="table-wrap mt-3" tabindex="0" role="region" aria-label="集群权限检查明细">
          <table class="data-table permission-table">
            <thead>
              <tr>
                <th>资源 / 操作</th>
                <th>范围</th>
                <th>结果</th>
                <th>依据</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(check, index) in observation.permissions.checks" :key="index">
                <td>
                  <code>{{ check.apiGroup || 'core' }}/{{ check.resource }}</code>
                  <p class="mono meta mt-1">
                    {{ check.verb }}{{ check.resourceName ? ` · ${check.resourceName}` : '' }}
                  </p>
                </td>
                <td>{{ check.namespace || '集群 / 所有命名空间' }}</td>
                <td>{{ permissionLabel(check.allowed) }}</td>
                <td class="meta">
                  {{
                    check.evidence === 'successful_request'
                      ? '实际请求成功'
                      : check.evidence === 'self_subject_access_review'
                        ? '权限自检'
                        : '未确认'
                  }}
                  <p v-if="check.errorCode" class="mono mt-1">{{ check.errorCode }}</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
    <section data-workload-observation>
      <div class="section-head">
        <div>
          <h2>集群工作负载</h2>
          <p class="meta mt-1">
            已读取 {{ observation.workloads.items.length }} 条预览 ·
            {{ dateTime(observation.workloads.observedAt) }}
          </p>
        </div>
        <span v-if="!current" class="badge badge-warning">历史观察</span>
      </div>
      <div v-if="observation.workloads.state !== 'available'" class="notice notice-warning mb-5">
        <AlertCircle />
        <p>
          {{
            observation.workloads.state === 'partial'
              ? '部分资源类型未能读取，下面只显示本次已确认的预览。'
              : '当前凭证或连接未能读取工作负载，资源状态未知。'
          }}
        </p>
      </div>
      <div v-if="observation.workloads.items.length" class="workload-filters mb-4">
        <div class="relative min-w-0 flex-1">
          <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
            v-model="search"
            class="pl-10"
            aria-label="搜索工作负载预览"
            placeholder="搜索名称、类型或命名空间"
          />
        </div>
        <select v-model="namespace" class="input" aria-label="筛选工作负载命名空间">
          <option value="">全部命名空间</option>
          <option v-for="item in namespaces" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
      <div
        v-if="workloads.length"
        class="table-wrap workload-scroll"
        tabindex="0"
        role="region"
        aria-label="集群工作负载预览"
      >
        <table class="data-table workload-table">
          <thead>
            <tr>
              <th>工作负载</th>
              <th>命名空间</th>
              <th>观察状态</th>
              <th>归属线索</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in workloads" :key="`${item.kind}:${item.uid}`">
              <td>
                <strong class="break-all">{{ item.name }}</strong>
                <p class="meta mt-1">{{ item.kind }}</p>
              </td>
              <td class="mono">{{ item.namespace }}</td>
              <td>
                <span v-if="!current">当前未知</span
                ><span v-else>{{ workloadLabels[item.status] ?? '未知' }}</span>
                <p v-if="!current" class="meta mt-1">
                  上次：{{ workloadLabels[item.status] ?? '未知' }}
                </p>
                <p v-if="item.desiredReplicas !== null" class="meta mt-1">
                  就绪 {{ item.readyReplicas ?? '未知' }} / {{ item.desiredReplicas }}
                </p>
              </td>
              <td class="meta">
                <span>未确认平台归属</span>
                <p v-if="item.managedBy" class="mono mt-1 break-all">
                  managed-by: {{ item.managedBy }}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted py-5">
        {{
          search || namespace
            ? '没有匹配的已读取工作负载。'
            : observation.workloads.state === 'available'
              ? '本次读取未发现工作负载。'
              : '暂无可展示的工作负载观察。'
        }}
      </p>
      <p v-if="observation.workloads.collections.some((item) => item.truncated)" class="meta mt-3">
        部分类型的预览已达到数量上限，这里的条数不代表整个集群总量。
      </p>
      <p class="meta mt-3">
        工作负载是只读观察。managed-by 标签仅供核对，不能单独证明资源由 Ozz 管理。
      </p>
      <details
        v-if="
          observation.workloads.collections.some(
            (item) => item.state !== 'available' || item.truncated,
          )
        "
        class="report-details mt-4"
      >
        <summary>资源类型读取情况</summary>
        <ul class="space-y-2 mt-3">
          <li v-for="item in observation.workloads.collections" :key="item.kind" class="meta">
            <code>{{ item.kind }}</code> · {{ capabilityLabel(item.state) }} · 已读
            {{ item.listedCount ?? '未知' }} 条{{ item.truncated ? '（预览已截断）' : ''
            }}<span v-if="item.errorCode" class="mono ml-2">{{ item.errorCode }}</span>
          </li>
        </ul>
      </details>
    </section>
  </div>
</template>

<style scoped>
.capability-list > div {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border);
}
.capability-list > div:first-child {
  padding-top: 0;
}
.capability-list > div:last-child {
  border: 0;
  padding-bottom: 0;
}
.capability-list dt {
  color: var(--muted-foreground);
}
.capability-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.report-details {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.report-details summary {
  cursor: pointer;
  padding: 0.5rem 0;
}
.permission-table,
.workload-table {
  min-width: 42rem;
}
.workload-scroll {
  max-height: 34rem;
}
.workload-table th {
  position: sticky;
  top: 0;
  z-index: 1;
}
.workload-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.workload-filters select {
  width: auto;
  max-width: 18rem;
}
@media (max-width: 639px) {
  .capability-list > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem;
  }
  .workload-filters > * {
    width: 100%;
    flex-basis: 100%;
    max-width: none !important;
  }
}
</style>
