<script setup lang="ts">
import { computed } from 'vue';
import { BookOpen, ChevronDown, Info } from '@lucide/vue';

const props = defineProps<{
  kind: 'postgresql' | 'redis' | 'files';
  sourceLabel: string;
}>();
const guide = computed(
  () =>
    ({
      postgresql: {
        title: 'PostgreSQL 逻辑备份',
        method: '使用与源主版本兼容的 pg_dump，保存自定义归档及工具版本。',
        preparation: '核对源实例、库名、数据卷与凭证引用，记录一致性数据时间点。',
        restore:
          '在明确目标环境的新服务、新卷和新空库中导入。使用匹配主版本，以目标凭证恢复逻辑数据。',
        verification: '检查表结构、事务标记、行和约束，再验证应用读写。',
      },
      redis: {
        title: 'Redis RDB 备份',
        method: '通过认证导出 RDB 快照，记录快照标记、时间、引擎和格式版本。',
        preparation:
          '核对源实例和实际 AOF 状态。正常服务使用 AOF everysec，其间仍可能有尚未持久化的写入。',
        restore:
          '在维护保护下向新卷导入。受控临时实例先以 AOF 关闭方式加载 RDB，再开启 AOF，等待首次 rewrite 成功并正常停止。',
        verification: '检查键、值、绝对到期时间或 TTL 范围，以及恢复后的实际 AOF 状态。',
      },
      files: {
        title: '文件卷备份',
        method: '在维护保护内使用只读 helper 归档，保存文件内容与权限清单。',
        preparation: '停止所有写入服务，确认实际挂载已退出，再进入卷维护。',
        restore:
          '校验归档条目、总大小和 SHA256，仅向新卷解压。核对路径、链接、文件类型及目标 UID/GID 和权限。',
        verification: '比较文件内容和权限，确认 helper 已退出后，再解除维护并发布目标服务。',
      },
    })[props.kind],
);
</script>
<template>
  <details class="panel manual-guide" data-manual-data-guide>
    <summary>
      <BookOpen aria-hidden="true" /><span>手工备份与新目标恢复</span>
      <ChevronDown class="guide-chevron" aria-hidden="true" />
    </summary>
    <div class="guide-content">
      <p class="meta">{{ sourceLabel }} · {{ guide.title }}</p>
      <ol class="guide-steps">
        <li>
          <strong>核对源数据与保护状态</strong>
          <p>{{ guide.preparation }}</p>
        </li>
        <li>
          <strong>执行版本固定的手工导出</strong>
          <p>{{ guide.method }}</p>
        </li>
        <li>
          <strong>保存离机副本与完整性清单</strong>
          <p>
            将备份保存到源服务器之外，记录不可覆盖的备份 ID、大小、SHA256、数据时间点及副本位置。
          </p>
        </li>
        <li>
          <strong>恢复到新目标</strong>
          <p>{{ guide.restore }}</p>
        </li>
        <li>
          <strong>记录独立验证结果</strong>
          <p>{{ guide.verification }}</p>
        </li>
      </ol>
      <div class="notice notice-warning">
        <Info aria-hidden="true" />
        <p>
          恢复验证后保留源服务和源卷，另行审阅消费者连接变更。手工记录标明操作者提供的证据；平台运行观察继续单独显示。
        </p>
      </div>
      <p class="meta mt-4">
        本页提供指引与记录入口。导出、复制和导入通过手工操作工具完成，记录保存不会执行这些步骤。
      </p>
      <slot />
    </div>
  </details>
</template>
<style scoped>
.manual-guide > summary {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  cursor: pointer;
  list-style: none;
  font-size: 1rem;
  font-weight: 600;
  min-height: 2.75rem;
}
.manual-guide > summary::-webkit-details-marker {
  display: none;
}
.manual-guide > summary > svg {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
}
.guide-chevron {
  margin-left: auto;
  transition: transform 160ms ease-out;
}
.manual-guide[open] .guide-chevron {
  transform: rotate(180deg);
}
.guide-content {
  padding-top: 1.25rem;
}
.guide-steps {
  display: grid;
  gap: 1.25rem;
  list-style: decimal;
  padding-left: 1.5rem;
  margin: 1.5rem 0;
}
.guide-steps li {
  padding-left: 0.375rem;
  max-width: 72ch;
}
.guide-steps p {
  margin-top: 0.375rem;
  color: var(--muted-foreground);
  line-height: 1.75;
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  .guide-chevron {
    transition: none;
  }
}
</style>
