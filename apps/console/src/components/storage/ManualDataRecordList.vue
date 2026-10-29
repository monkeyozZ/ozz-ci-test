<script setup lang="ts">
import { FileCheck2, ArrowUpRight } from '@lucide/vue';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import { dateTime } from '@/lib/utils';
import type { ManualDataRecord } from './types';
import { engineLabel } from './presentation';
import { formatStorageBytes } from './format';
defineProps<{ records: ManualDataRecord[] }>();
</script>
<template>
  <div class="manual-record-list" data-manual-record-list>
    <article v-for="record in records" :key="record.id" class="manual-record">
      <div class="record-heading">
        <div class="min-w-0">
          <h3 class="flex items-center gap-2">
            <FileCheck2 class="size-4" />{{
              record.type === 'backup' ? '手工备份记录' : '手工恢复记录'
            }}
          </h3>
          <p class="meta mt-2">
            {{ dateTime(record.completedAt) }} · {{ engineLabel(record.engine) }}
            {{ record.engineVersion }}
          </p>
        </div>
        <NetworkStateBadge
          :label="
            record.result === 'passed'
              ? '操作者报告通过'
              : record.result === 'failed'
                ? '操作者报告失败'
                : '操作者报告未完成'
          "
          :tone="
            record.result === 'passed' ? 'good' : record.result === 'failed' ? 'danger' : 'warning'
          "
        />
      </div>
      <p class="field-hint mt-4">操作者报告 · 不代表平台已经核验备份可用或恢复数据正确</p>
      <dl class="storage-facts mt-5">
        <div>
          <dt>备份清单 ID</dt>
          <dd class="mono">{{ record.backupId }}</dd>
        </div>
        <div>
          <dt>格式与大小</dt>
          <dd>{{ record.format }} · {{ formatStorageBytes(record.sizeBytes) }}</dd>
        </div>
        <div>
          <dt>离机副本</dt>
          <dd>{{ record.offHostLocationLabel }}</dd>
        </div>
        <div>
          <dt>数据时间点</dt>
          <dd>
            {{ record.dataTime.description }}
            <p v-if="record.dataTime.from || record.dataTime.to" class="meta mt-1">
              {{ record.dataTime.from ? dateTime(record.dataTime.from) : '起点未知' }} ～
              {{ record.dataTime.to ? dateTime(record.dataTime.to) : '终点未知' }}
            </p>
          </dd>
        </div>
        <div>
          <dt>完整性校验</dt>
          <dd>
            {{
              record.integrity === 'passed'
                ? '报告通过'
                : record.integrity === 'failed'
                  ? '报告失败'
                  : '尚未确认'
            }}
          </dd>
        </div>
        <div v-if="record.target">
          <dt>新目标卷</dt>
          <dd>
            <RouterLink
              :to="`/volumes/${record.target.volumeId}`"
              class="text-link inline-flex items-center gap-1"
              >查看目标卷<ArrowUpRight class="size-3.5"
            /></RouterLink>
          </dd>
        </div>
      </dl>
      <details class="record-evidence mt-5">
        <summary>查看清单与验证证据</summary>
        <dl class="storage-facts mt-4">
          <div>
            <dt>SHA256</dt>
            <dd class="mono">{{ record.sha256 }}</dd>
          </div>
          <div>
            <dt>工具版本</dt>
            <dd>{{ record.toolVersion }}</dd>
          </div>
          <div>
            <dt>数据布局</dt>
            <dd>{{ record.dataLayout }}</dd>
          </div>
          <div>
            <dt>源卷 UID</dt>
            <dd class="mono">{{ record.source.pvcUid }}</dd>
          </div>
          <div>
            <dt>执行区间</dt>
            <dd>{{ dateTime(record.startedAt) }} ～ {{ dateTime(record.completedAt) }}</dd>
          </div>
          <div>
            <dt>执行耗时</dt>
            <dd>{{ Math.round(record.durationMs / 1000) }} 秒</dd>
          </div>
          <div>
            <dt>记录人</dt>
            <dd class="mono">{{ record.actorId ?? '操作者身份未保留' }}</dd>
          </div>
        </dl>
        <h4 class="mt-5">验证步骤</h4>
        <ul class="evidence-lines">
          <li v-for="(step, index) in record.verificationSteps" :key="index">{{ step }}</li>
        </ul>
        <h4 class="mt-5">证据引用</h4>
        <ul class="evidence-lines mono">
          <li v-for="(reference, index) in record.evidenceReferences" :key="index">
            {{ reference }}
          </li>
        </ul>
        <p v-if="!record.evidenceReferences.length" class="meta mt-2">未附证据引用</p>
      </details>
    </article>
  </div>
</template>
<style scoped>
.manual-record + .manual-record {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}
.record-heading {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
}
.record-evidence summary {
  cursor: pointer;
  color: var(--primary);
  font-size: 0.875rem;
}
.evidence-lines {
  list-style: disc;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  margin-top: 0.625rem;
}
.evidence-lines li {
  overflow-wrap: anywhere;
}
.evidence-lines li + li {
  margin-top: 0.5rem;
}
</style>
