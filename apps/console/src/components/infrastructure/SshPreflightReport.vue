<script setup lang="ts">
import { AlertCircle, Check, Info } from '@lucide/vue';
import { dateTime } from '@/lib/utils';
import { bytesLabel, cpuLabel } from './format';
import type { ServerPreflight } from './types';

defineProps<{ report: ServerPreflight }>();
const blockerLabels: Record<string, string> = {
  unsupported_os: '系统不在当前支持范围内',
  unsupported_architecture: 'CPU 架构不受支持',
  systemd_required: '需要 systemd 管理系统服务',
  privilege_required: '需要 root 或免密码 sudo 权限',
  memory_cgroup_required: '需要可用的内存 cgroup',
  insufficient_cpu: 'CPU 数量不足',
  insufficient_memory: '可用内存不足',
  insufficient_disk: '安装目录可用磁盘不足',
  ports_in_use: 'K3s 所需端口已被占用',
};
const warningLabels: Record<string, string> = {
  low_memory_headroom: '内存余量较低，需要为系统和应用预留空间。',
  low_disk_headroom: '磁盘余量较低，镜像和应用数据会继续占用空间。',
  firewall_requires_review: '本机防火墙已启用，请核对管理入口与所需端口规则。',
  cloud_firewall_unknown: '云防火墙或安全组无法通过主机预检确认，请在服务商控制台核对。',
  existing_k3s: '已检测到 K3s，使用已有集群接入。',
};
</script>

<template>
  <div data-preflight-report>
    <div class="section-head mb-4">
      <h3 class="font-medium">最近一次预检</h3>
      <time class="meta" :datetime="report.observedAt">{{ dateTime(report.observedAt) }}</time>
    </div>
    <div v-if="report.blockers.length" class="notice notice-danger mb-5" role="status">
      <AlertCircle aria-hidden="true" />
      <div>
        <strong>先处理以下问题，再重新预检</strong>
        <ul class="mt-2 list-disc pl-5 space-y-1">
          <li v-for="blocker in report.blockers" :key="blocker">
            {{ blockerLabels[blocker] ?? blocker }}
          </li>
        </ul>
      </div>
    </div>
    <div v-else-if="!report.k3s.installed" class="notice notice-good mb-5">
      <Check aria-hidden="true" />
      <p>基础运行条件已通过。初始化仍需单独确认，完成后会验证集群连接与节点状态。</p>
    </div>
    <dl class="preflight-facts">
      <div>
        <dt>系统</dt>
        <dd>{{ report.os }} {{ report.osVersion }}</dd>
      </div>
      <div>
        <dt>架构</dt>
        <dd class="mono">{{ report.architecture }}</dd>
      </div>
      <div>
        <dt>CPU</dt>
        <dd>{{ cpuLabel(report.cpuCount) }}</dd>
      </div>
      <div>
        <dt>内存容量 / 可用</dt>
        <dd>
          {{ bytesLabel(report.memoryBytes) }} / {{ bytesLabel(report.memoryAvailableBytes) }}
        </dd>
      </div>
      <div>
        <dt>根磁盘容量 / 可用</dt>
        <dd>
          {{ bytesLabel(report.rootDiskBytes) }} / {{ bytesLabel(report.rootDiskAvailableBytes) }}
        </dd>
      </div>
      <div>
        <dt>数据目录容量 / 可用</dt>
        <dd>
          {{ bytesLabel(report.dataDiskBytes) }} / {{ bytesLabel(report.dataDiskAvailableBytes) }}
        </dd>
      </div>
      <div>
        <dt>系统服务</dt>
        <dd>{{ report.systemdAvailable ? 'systemd 可用' : 'systemd 不可用' }}</dd>
      </div>
      <div>
        <dt>执行权限</dt>
        <dd>{{ report.privileged ? 'root / 免密码 sudo 可用' : '需要补充权限' }}</dd>
      </div>
      <div>
        <dt>K3s</dt>
        <dd>
          {{ report.k3s.installed ? report.k3s.version || '检测到已有安装' : '未检测到安装' }}
        </dd>
      </div>
      <div>
        <dt>主机防火墙</dt>
        <dd>
          {{
            report.firewall === 'active'
              ? '已启用，需核对规则'
              : report.firewall === 'inactive'
                ? '未启用'
                : '未知'
          }}
        </dd>
      </div>
    </dl>
    <p class="meta mt-3">
      CPU、内存与磁盘来自该次 SSH 采集；这里的可用空间不是持续更新的实时指标。
    </p>
    <details class="preflight-detail mt-5">
      <summary>端口与主机身份</summary>
      <div class="table-wrap mt-3" tabindex="0" aria-label="预检端口监听记录">
        <table class="data-table">
          <thead>
            <tr>
              <th>协议 / 端口</th>
              <th>本机监听</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="port in report.ports" :key="`${port.protocol}:${port.port}`">
              <td class="mono">{{ port.protocol.toUpperCase() }} / {{ port.port }}</td>
              <td>{{ port.listening ? '已监听' : '未监听' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="meta mt-3">
        监听记录仅说明该时刻的本机端口使用情况，公网可达性还取决于防火墙与云安全组。
      </p>
      <dl class="detail-list mt-3">
        <div>
          <dt>主机名</dt>
          <dd class="mono">{{ report.hostname }}</dd>
        </div>
        <div>
          <dt>机器身份</dt>
          <dd class="mono">{{ report.machineId }}</dd>
        </div>
        <div>
          <dt>内核</dt>
          <dd class="mono">{{ report.kernel }}</dd>
        </div>
        <div v-if="report.k3s.installed">
          <dt>Secret 静态加密</dt>
          <dd>
            {{
              report.k3s.secretsEncryption === 'enabled'
                ? '已验证启用'
                : report.k3s.secretsEncryption === 'disabled'
                  ? '未启用'
                  : '未知'
            }}
          </dd>
        </div>
      </dl>
    </details>
    <div v-if="report.warnings.length" class="notice mt-5">
      <Info aria-hidden="true" />
      <ul class="space-y-2">
        <li v-for="warning in report.warnings" :key="warning">
          {{ warningLabels[warning] ?? warning }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.preflight-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 1.5rem;
}
.preflight-facts > div {
  padding: 0.875rem 0;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.preflight-facts dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.preflight-facts dd {
  margin: 0.375rem 0 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.preflight-detail {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.preflight-detail summary {
  cursor: pointer;
  padding: 0.5rem 0;
}
@media (max-width: 639px) {
  .preflight-facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
