<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import {
  Search,
  CornerDownLeft,
  FolderKanban,
  Layers3,
  Server,
  Activity,
  Plus,
  Package,
  Globe,
  HardDrive,
  Database,
} from '@lucide/vue';
import { Dialog } from '@/components/ui/dialog';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { queryClient } from '@/lib/query';
import { serviceLocation } from '@/components/services/presentation';
import type { Service } from '@/components/services/types';
import type { Database as DatabaseResource } from '@/components/storage/types';
import type { Component } from 'vue';
interface Entry {
  id: string;
  label: string;
  detail: string;
  path: RouteLocationRaw;
  icon: Component;
}
const ui = useUiStore();
const auth = useAuthStore();
const router = useRouter();
const search = ref('');
const selected = ref(0);
const composing = ref(false);
const input = ref<HTMLInputElement>();
const cacheVersion = ref(0);
const unsubscribe = queryClient.getQueryCache().subscribe(() => cacheVersion.value++);
onScopeDispose(unsubscribe);
const entries = computed<Entry[]>(() => {
  void cacheVersion.value;
  const collected: Entry[] = auth.restoreMode
    ? []
    : [
        {
          id: 'create-project',
          label: '创建项目',
          detail: '工作台操作',
          path: '/projects/new',
          icon: Plus,
        },
        {
          id: 'register-cluster',
          label: '登记集群',
          detail: '基础设施操作',
          path: '/clusters/new',
          icon: Plus,
        },
        {
          id: 'register-server',
          label: '登记服务器',
          detail: '基础设施操作',
          path: '/servers/new',
          icon: Plus,
        },
        {
          id: 'create-volume',
          label: '创建持久卷',
          detail: '项目环境中的本地数据',
          path: '/volumes/new',
          icon: Plus,
        },
      ];
  collected.push(
    {
      id: 'templates',
      label: '服务模板',
      detail: 'Docker、Node.js、静态站点、PostgreSQL、Redis',
      path: '/templates',
      icon: Layers3,
    },
    {
      id: 'volumes',
      label: '持久卷',
      detail: '挂载、保留数据与手工记录',
      path: '/volumes',
      icon: HardDrive,
    },
    {
      id: 'databases',
      label: '数据库',
      detail: '认证检查与数据保护',
      path: '/databases',
      icon: Database,
    },
    { id: 'projects', label: '项目列表', detail: '工作台', path: '/projects', icon: FolderKanban },
    {
      id: 'services',
      label: '服务列表',
      detail: '所有项目与环境',
      path: '/services',
      icon: Package,
    },
    {
      id: 'infrastructure',
      label: '基础设施',
      detail: '服务器与集群',
      path: '/infrastructure',
      icon: Server,
    },
    {
      id: 'domains',
      label: '域名与网络',
      detail: 'DNS、路由与证书',
      path: '/domains',
      icon: Globe,
    },
    {
      id: 'operations',
      label: '操作任务',
      detail: '服务操作、接入与集群诊断记录',
      path: '/operations',
      icon: Activity,
    },
    {
      id: 'deployments',
      label: '部署与 Git 事件',
      detail: '固定提交、构建产物与逐服务投递',
      path: '/deployments',
      icon: Activity,
    },
  );
  const resourceKinds: Record<string, { prefix: string; label: string; icon: Component }> = {
    '/projects': { prefix: '/projects/', label: '项目', icon: FolderKanban },
    '/clusters': { prefix: '/clusters/', label: '集群', icon: Layers3 },
    '/servers': { prefix: '/servers/', label: '服务器', icon: Server },
    '/operations': { prefix: '/operations/', label: '操作任务', icon: Activity },
    '/volumes': { prefix: '/volumes/', label: '持久卷', icon: HardDrive },
    '/templates': { prefix: '/templates/', label: '服务模板', icon: Layers3 },
  };
  for (const [key, data] of queryClient.getQueriesData({ queryKey: ['collection'] })) {
    if (key[1] === '/databases' && data) {
      for (const database of (data as { pages?: { data: DatabaseResource[] }[] }).pages?.flatMap(
        (page) => page.data,
      ) ?? [])
        collected.push({
          id: `database:${database.id}`,
          label: database.service?.name ?? database.originalService.name,
          detail: `${database.engine} · ${database.service ? '数据库' : '已保留的数据身份'}`,
          path: `/databases/${database.id}`,
          icon: Database,
        });
      continue;
    }
    if (key[1] === '/domains' && data) {
      for (const domain of (
        data as { pages?: { data: { id: string; hostname: string; serviceName: string }[] }[] }
      ).pages?.flatMap((page) => page.data) ?? [])
        collected.push({
          id: `domain:${domain.id}`,
          label: domain.hostname,
          detail: `域名 · ${domain.serviceName}`,
          path: `/domains/${domain.id}`,
          icon: Globe,
        });
      continue;
    }
    if (key[1] === '/services' && data) {
      for (const service of (data as { pages?: { data: Service[] }[] }).pages?.flatMap(
        (page) => page.data,
      ) ?? [])
        collected.push({
          id: `service:${service.id}`,
          label: service.name,
          detail: `服务 · ${service.project.name} / ${service.environment.name} · ${service.cluster.name}`,
          path: serviceLocation(service),
          icon: Package,
        });
      continue;
    }
    const config = resourceKinds[String(key[1])];
    if (!config || !data) continue;
    const pages =
      (
        data as {
          pages?: {
            data: {
              id: string;
              name?: string;
              slug?: string;
              status?: string;
              cluster?: { name: string };
            }[];
          }[];
        }
      ).pages ?? [];
    for (const resource of pages.flatMap((page) => page.data))
      collected.push({
        id: `${key[1]}:${resource.id}`,
        label: resource.name ?? resource.id,
        detail: [config.label, resource.cluster?.name ?? resource.slug ?? resource.status]
          .filter(Boolean)
          .join(' · '),
        path: config.prefix + resource.id,
        icon: config.icon,
      });
  }
  return [...new Map(collected.map((item) => [item.id, item])).values()];
});
const matches = computed(() => {
  const text = search.value.trim().toLocaleLowerCase();
  return entries.value
    .filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(text))
    .slice(0, 30);
});
watch(search, () => (selected.value = 0));
watch(
  () => ui.commandOpen,
  async (open) => {
    composing.value = false;
    if (open) {
      search.value = '';
      selected.value = 0;
      await nextTick();
      input.value?.focus();
    }
  },
);
async function openEntry(entry?: Entry) {
  if (!entry) return;
  ui.commandOpen = false;
  await router.push(entry.path);
}
function handleKey(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    selected.value = Math.max(
      0,
      Math.min(matches.value.length - 1, selected.value + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    void nextTick(() =>
      document
        .getElementById(`command-option-${selected.value}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    void openEntry(matches.value[selected.value]);
  }
}
</script>
<template>
  <Dialog
    v-model:open="ui.commandOpen"
    title="快速打开"
    description="搜索当前工作台中已加载的项目、服务、数据库、卷与任务。"
  >
    <div class="relative">
      <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><input
        ref="input"
        v-model="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="command-results"
        :aria-expanded="true"
        :aria-activedescendant="matches.length ? `command-option-${selected}` : undefined"
        aria-label="搜索资源或操作"
        class="input pl-10"
        placeholder="输入名称或操作…"
        @keydown="handleKey"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />
    </div>
    <div id="command-results" class="command-results" role="listbox" aria-label="匹配的资源与操作">
      <div
        v-for="(entry, index) in matches"
        :id="`command-option-${index}`"
        :key="entry.id"
        role="option"
        :aria-selected="selected === index"
        class="command-option"
        @click="openEntry(entry)"
        @mouseenter="selected = index"
      >
        <component :is="entry.icon" class="size-4 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium">{{ entry.label }}</p>
          <p class="meta truncate">{{ entry.detail }}</p>
        </div>
        <CornerDownLeft v-if="index === selected" class="size-4 text-muted-foreground" />
      </div>
      <div v-if="!matches.length" class="py-12 text-center muted">
        没有匹配的资源，试试其他关键词。
      </div>
    </div>
    <p class="meta mt-3">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p>
  </Dialog>
</template>
<style scoped>
.command-results {
  margin-top: 0.75rem;
  max-height: min(24rem, 50dvh);
  overflow-y: auto;
}
.command-option {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.75rem;
  border-radius: 0.5rem;
  cursor: pointer;
}
.command-option[aria-selected='true'] {
  background: var(--accent);
}
</style>
