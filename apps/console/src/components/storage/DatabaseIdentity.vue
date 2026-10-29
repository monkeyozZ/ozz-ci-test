<script setup lang="ts">
import { computed } from 'vue';
import {
  Database as DatabaseIcon,
  ShieldCheck,
  ArrowUpRight,
  LockKeyhole,
  HardDrive,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import CopyButton from '@/components/CopyButton.vue';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import NetworkObservationSection from '@/components/networking/NetworkObservationSection.vue';
import { dateTime } from '@/lib/utils';
import { formatStorageBytes } from './format';
import { databaseServiceLocation, databaseState, engineLabel } from './presentation';
import type { Database } from './types';

const props = defineProps<{ database: Database; compact?: boolean }>();
const serviceLocation = computed(() => databaseServiceLocation(props.database));
const databaseName = computed(() =>
  props.database.engine === 'postgresql'
    ? props.database.connection.database
    : props.database.connection.redisDatabase,
);
const lockLabels: Record<string, string> = {
  'configuration.image': '镜像版本',
  'configuration.replicas': '副本数',
  'configuration.command': '启动命令',
  'configuration.args': '启动参数',
  'configuration.ports': '端口',
  'configuration.environment': '环境变量',
  volumeMounts: '数据卷挂载',
  credential: '数据库凭证',
  image: '数据库镜像与主版本',
  majorVersion: '数据库主版本',
  username: '初始化用户名',
  databaseName: '初始化数据库名',
  credentialRefId: '数据库凭证身份',
  credentialContentRevision: '数据库凭证版本',
  dataVolumeId: '数据卷身份',
  dataLayout: '数据目录布局',
  templateVersion: '模板版本',
};
const knownLockedFields = computed(() =>
  props.database.protection.lockedFields.filter((field) => Object.hasOwn(lockLabels, field)),
);
const unknownLockedFields = computed(() =>
  props.database.protection.lockedFields.filter((field) => !Object.hasOwn(lockLabels, field)),
);
</script>
<template>
  <section class="panel database-identity" data-database-identity>
    <div class="section-head">
      <div class="min-w-0">
        <h2 class="flex items-center gap-2">
          <DatabaseIcon class="size-5" />{{ engineLabel(database.engine) }}
          {{ database.exactVersion }}
        </h2>
        <p class="meta mt-2">单实例 StatefulSet · 集群内私有连接</p>
      </div>
      <NetworkStateBadge v-bind="databaseState(database)" />
    </div>
    <div v-if="!database.service" class="notice notice-warning mb-6">
      <HardDrive />
      <div>
        <strong>原服务已删除，数据库数据与身份仍保留</strong>
        <p>
          {{ database.originalService.name }}
          的数据不会自动成为其他服务的数据库。需要恢复时，请按手工指引使用新卷和新服务验证数据。
        </p>
      </div>
    </div>
    <div class="database-summary">
      <dl class="storage-facts">
        <div>
          <dt>数据卷</dt>
          <dd>
            <RouterLink :to="`/volumes/${database.dataVolume.id}`" class="text-link">{{
              database.dataVolume.name
            }}</RouterLink
            ><span class="meta ml-2"
              >{{ formatStorageBytes(database.dataVolume.requestedBytes) }} 申请量</span
            >
          </dd>
        </div>
        <div>
          <dt>当前服务</dt>
          <dd>
            <RouterLink v-if="serviceLocation" :to="serviceLocation" class="text-link">{{
              database.service?.name
            }}</RouterLink
            ><span v-else>已删除 · {{ database.originalService.name }}</span>
          </dd>
        </div>
        <div>
          <dt>私有地址</dt>
          <dd class="mono connection-value">
            <span>{{ database.connection.host || '发布后由实际 Service 确认' }}</span
            ><CopyButton
              v-if="database.connection.host"
              :text="database.connection.host"
              label="复制数据库地址"
              compact
            />
          </dd>
        </div>
        <div>
          <dt>端口</dt>
          <dd class="mono connection-value">
            <span>{{ database.connection.port }}</span
            ><CopyButton :text="String(database.connection.port)" label="复制数据库端口" compact />
          </dd>
        </div>
        <div>
          <dt>{{ database.engine === 'postgresql' ? '数据库' : '逻辑库编号' }}</dt>
          <dd class="mono connection-value">
            <span>{{ databaseName ?? '未知' }}</span
            ><CopyButton
              v-if="databaseName !== null && databaseName !== undefined"
              :text="String(databaseName)"
              :label="database.engine === 'postgresql' ? '复制数据库名' : '复制逻辑库编号'"
              compact
            />
          </dd>
        </div>
        <div>
          <dt>用户</dt>
          <dd class="mono connection-value">
            <span>{{ database.connection.username }}</span
            ><CopyButton
              v-if="database.connection.username"
              :text="database.connection.username"
              label="复制数据库用户名"
              compact
            />
          </dd>
        </div>
      </dl>
      <div class="database-protection">
        <div class="flex items-center gap-2 font-semibold">
          <ShieldCheck class="size-4" /><span>{{
            database.protection.active ? '数据身份保护已生效' : '尚未建立首次写入保护'
          }}</span>
        </div>
        <p class="mt-3">{{ database.protection.reason }}</p>
        <p v-if="database.protection.fencedAt" class="meta mt-2">
          建立于 {{ dateTime(database.protection.fencedAt) }} · r{{ database.protection.revision }}
        </p>
        <ul
          v-if="knownLockedFields.length"
          class="protected-fields mt-3"
          data-database-protected-fields
        >
          <li v-for="field in knownLockedFields" :key="field">
            <LockKeyhole class="size-3.5" />{{ lockLabels[field] }}
          </li>
        </ul>
        <details
          v-if="unknownLockedFields.length"
          class="protection-details mt-4"
          data-database-protection-details
        >
          <summary>其他保护项的技术详情</summary>
          <ul class="protected-fields mt-3">
            <li v-for="field in unknownLockedFields" :key="field">
              <code>{{ field }}</code>
            </li>
          </ul>
        </details>
        <p class="meta mt-3">停止、发布失败或删除服务后，既有数据保护仍然有效。</p>
      </div>
    </div>
    <template v-if="!compact">
      <NetworkObservationSection
        class="mt-6"
        title="数据库认证与持久化检查"
        :status="databaseState(database)"
        :observed-at="database.observation?.observedAt"
        :stale="database.observationStale"
        :message="database.observation?.message"
      >
        <dl class="storage-facts mt-4">
          <div>
            <dt>认证验证</dt>
            <dd>
              {{
                database.observation?.authenticated ? '使用受控凭证完成认证' : '尚无有效认证结果'
              }}
            </dd>
          </div>
          <div>
            <dt>引擎版本</dt>
            <dd>{{ database.observation?.engineVersion ?? '尚未确认' }}</dd>
          </div>
          <div>
            <dt>持久化模式</dt>
            <dd>
              {{
                database.observation?.persistence === 'postgres_wal'
                  ? 'PostgreSQL WAL'
                  : database.observation?.persistence === 'redis_aof_everysec'
                    ? 'Redis AOF · 每秒同步'
                    : '尚未确认'
              }}
            </dd>
          </div>
          <div>
            <dt>初始化记录</dt>
            <dd>
              {{
                database.initialization.initializedAt
                  ? dateTime(database.initialization.initializedAt)
                  : '尚无确认记录'
              }}
            </dd>
          </div>
          <div>
            <dt>观察到的 PVC UID</dt>
            <dd class="mono">{{ database.observation?.pvcUid ?? '尚未确认' }}</dd>
          </div>
        </dl>
      </NetworkObservationSection>
      <details class="identity-details mt-6">
        <summary>查看非敏感身份记录</summary>
        <dl class="storage-facts mt-4">
          <div>
            <dt>数据库身份</dt>
            <dd class="mono">{{ database.id }}</dd>
          </div>
          <div>
            <dt>凭证引用</dt>
            <dd class="mono">
              {{ database.credential.refId }} · r{{ database.credential.contentRevision }}
            </dd>
          </div>
          <div>
            <dt>模板</dt>
            <dd>{{ database.template.id }} · {{ database.template.version }}</dd>
          </div>
          <div>
            <dt>固定 PVC UID</dt>
            <dd class="mono">{{ database.dataVolume.pvcUid ?? '尚未确认' }}</dd>
          </div>
        </dl>
        <p class="meta mt-4">
          页面仅显示凭证引用。将数据库连接保存到应用草稿后，发布应用时注入受控凭证。
        </p>
      </details>
    </template>
    <div v-else class="mt-5">
      <Button as-child variant="outline"
        ><RouterLink :to="`/databases/${database.id}`">查看数据库检查<ArrowUpRight /></RouterLink
      ></Button>
    </div>
  </section>
</template>
<style scoped>
.database-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, 0.85fr);
  gap: 2rem;
}
.database-protection {
  border-left: 1px solid var(--border);
  padding-left: 1.5rem;
  font-size: 0.875rem;
}
.protected-fields {
  display: flex;
  gap: 0.625rem;
  flex-direction: column;
  color: var(--muted-foreground);
}
.protected-fields li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  overflow-wrap: anywhere;
}
.identity-details {
  border-top: 1px solid var(--border);
  padding-top: 1.25rem;
}
.identity-details summary {
  cursor: pointer;
  font-weight: 550;
}
.protection-details summary {
  cursor: pointer;
  color: var(--muted-foreground);
}
.storage-facts dd {
  overflow-wrap: anywhere;
}
.connection-value {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
}
.connection-value > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 850px) {
  .database-summary {
    grid-template-columns: minmax(0, 1fr);
    gap: 1.5rem;
  }
  .database-protection {
    border-left: 0;
    border-top: 1px solid var(--border);
    padding: 1.25rem 0 0;
  }
}
</style>
