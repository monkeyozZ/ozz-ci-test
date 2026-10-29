<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDown, Pause, Play, Square, ScrollText, Info, Copy } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import MutationError from '@/components/MutationError.vue';
import { api, eventStream } from '@/lib/api';
import { appendServiceLog, ServiceLogDecoder } from '@/lib/service-log-stream';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import VirtualServiceLog from './VirtualServiceLog.vue';
import type { Service } from './types';
const props = defineProps<{ service: Service }>();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const pods = computed(() => props.service.observation?.pods ?? []);
const selectedPod = ref(typeof route.query.podUid === 'string' ? route.query.podUid : '');
const selectedContainer = ref(
  typeof route.query.container === 'string' ? route.query.container : '',
);
const pod = computed(() => pods.value.find((value) => value.uid === selectedPod.value));
const validContainer = computed(
  () => !!pod.value?.containers.some((container) => container.name === selectedContainer.value),
);
const follow = ref(false);
const previous = ref(false);
const tailLines = ref(200);
const reading = ref(false);
const error = ref<unknown>(null);
const text = ref('');
const endMessage = ref('');
const endReason = ref('');
const followingScroll = ref(true);
const unread = ref(0);
const clipped = ref(false);
const wrapLines = ref(false);
const firstLine = ref(0);
const output = ref<InstanceType<typeof VirtualServiceLog>>();
let controller: AbortController | null = null;
let generation = 0;
watch(
  pods,
  (values) => {
    if (!selectedPod.value && values.length) selectedPod.value = values[0]!.uid;
  },
  { immediate: true },
);
watch(
  pod,
  (value) => {
    if (value && !selectedContainer.value)
      selectedContainer.value = value.containers[0]?.name ?? '';
  },
  { immediate: true },
);
function stop(clear = false) {
  generation++;
  controller?.abort();
  controller = null;
  reading.value = false;
  if (clear) {
    text.value = '';
    firstLine.value = 0;
    unread.value = 0;
    clipped.value = false;
    error.value = null;
    endMessage.value = '';
    endReason.value = '';
  } else {
    endMessage.value = '已断开当前日志连接，已有输出保留。';
    endReason.value = 'user_closed';
  }
}
watch([selectedPod, selectedContainer, previous], () => stop(true));
watch(
  () => props.service.id,
  () => {
    stop(true);
    selectedPod.value = pods.value[0]?.uid ?? '';
    selectedContainer.value = pods.value[0]?.containers[0]?.name ?? '';
  },
);
watch(
  () => pod.value?.uid,
  (value, old) => {
    if (old && value !== old) stop(true);
  },
);
watch(
  () => pod.value?.containers.some((container) => container.name === selectedContainer.value),
  (valid) => {
    if (!valid) stop(true);
  },
);
watch(
  () => [route.query.podUid, route.query.container] as const,
  ([podUid, container]) => {
    if (typeof podUid === 'string') selectedPod.value = podUid;
    if (typeof container === 'string') selectedContainer.value = container;
  },
);
watch(
  () => auth.user?.id,
  () => stop(true),
);
onScopeDispose(() => {
  controller?.abort();
  controller = null;
  generation++;
  text.value = '';
});
async function choosePod() {
  selectedContainer.value = pod.value?.containers[0]?.name ?? '';
  await saveSelection();
}
async function saveSelection() {
  await router.replace({
    path: route.path,
    query: {
      ...route.query,
      podUid: selectedPod.value || undefined,
      container: selectedContainer.value || undefined,
    },
  });
}
async function jumpToBottom() {
  followingScroll.value = true;
  unread.value = 0;
  await nextTick();
  await output.value?.jumpToBottom();
}
async function append(value: string) {
  const combined = text.value + value;
  const next = appendServiceLog(text.value, value);
  const removed = combined.length - next.text.length;
  if (removed) firstLine.value += (combined.slice(0, removed).match(/\n/g) ?? []).length;
  text.value = next.text;
  clipped.value ||= next.clipped;
  if (followingScroll.value) await jumpToBottom();
  else unread.value += Math.max(1, (value.match(/\n/g) ?? []).length);
}
async function copyLogs() {
  try {
    await navigator.clipboard.writeText(text.value);
    ui.toast('已复制当前缓冲中的日志原文。');
  } catch {
    ui.toast('复制未完成，请允许剪贴板访问后重试。', 'error');
  }
}
async function readLogs() {
  if (!pod.value || !validContainer.value || reading.value) return;
  stop(true);
  const run = ++generation;
  const abort = new AbortController();
  controller = abort;
  reading.value = true;
  followingScroll.value = true;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const query = new URLSearchParams({
      podUid: pod.value.uid,
      container: selectedContainer.value,
      previous: String(previous.value),
      tailLines: String(tailLines.value),
      follow: String(follow.value),
    });
    const response = await eventStream(
      `/services/${props.service.id}/logs?${query}`,
      AbortSignal.any([abort.signal, AbortSignal.timeout(70_000)]),
    );
    reader = response.body!.getReader();
    const decoder = new ServiceLogDecoder();
    let ended = false;
    while (run === generation && !ended) {
      const result = await reader.read();
      if (result.done) break;
      for (const event of decoder.push(result.value)) {
        if (run !== generation) break;
        if (event.type === 'log') await append(event.text);
        else {
          endMessage.value = event.message;
          endReason.value = event.reason;
          ended = true;
          if (event.reason === 'access_changed') await api.get('/auth/me').catch(() => undefined);
          break;
        }
      }
    }
    if (run === generation && !ended)
      endMessage.value = '日志连接结束，未收到完整结束确认。可以重新读取尾部。';
  } catch (failure) {
    if (run === generation && !abort.signal.aborted) error.value = failure;
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    if (run === generation) {
      reading.value = false;
      controller = null;
    }
  }
}
</script>
<template>
  <section class="panel log-viewer" data-service-logs>
    <div class="section-head">
      <div>
        <h2>容器日志</h2>
        <p class="meta mt-1">
          {{ service.project.name }} / {{ service.environment.name }} / {{ service.name }}
        </p>
      </div>
      <ScrollText class="size-5 text-muted-foreground" />
    </div>
    <div v-if="!pods.length" class="notice">
      <Info />
      <p>
        {{
          service.desiredState === 'stopped'
            ? '服务已停止，没有当前实例可读取。部署和操作日志保留在各自任务中。'
            : '当前没有已观察到的实例，等待发布或刷新运行状态后再读取。'
        }}
      </p>
    </div>
    <template v-else>
      <div class="log-filters">
        <div class="field">
          <label for="runtime-log-pod">实例</label
          ><select id="runtime-log-pod" v-model="selectedPod" class="input" @change="choosePod">
            <option v-if="selectedPod && !pod" :value="selectedPod" disabled>原实例已不可用</option>
            <option v-for="value in pods" :key="value.uid" :value="value.uid">
              {{ value.name }} · {{ value.uid.slice(0, 8) }}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="runtime-log-container">容器</label
          ><select
            id="runtime-log-container"
            v-model="selectedContainer"
            class="input"
            @change="saveSelection"
          >
            <option v-if="selectedContainer && !validContainer" :value="selectedContainer" disabled>
              原容器已不可用
            </option>
            <option
              v-for="container in pod?.containers ?? []"
              :key="container.name"
              :value="container.name"
            >
              {{ container.name }}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="runtime-log-tail">尾部行数</label
          ><select
            id="runtime-log-tail"
            v-model.number="tailLines"
            class="input"
            :disabled="reading"
          >
            <option :value="100">100 行</option>
            <option :value="200">200 行</option>
            <option :value="500">500 行</option>
            <option :value="1000">1000 行</option>
          </select>
        </div>
      </div>
      <div class="actions mt-4">
        <label class="log-check"><input v-model="previous" type="checkbox" />上次退出的容器</label
        ><label class="log-check"
          ><input v-model="follow" type="checkbox" :disabled="reading" />持续跟随输出</label
        ><Button v-if="!reading" :disabled="!pod || !validContainer" @click="readLogs"
          ><Play />{{ follow ? '开始跟随日志' : '读取日志尾部' }}</Button
        ><Button v-else variant="outline" @click="stop()"><Square />断开日志连接</Button>
        <Button variant="ghost" :disabled="!text" @click="copyLogs"><Copy />复制缓冲日志</Button>
      </div>
      <p v-if="pod && selectedContainer && !validContainer" class="meta mt-3" role="status">
        原容器已不可用，请选择当前实例中的容器后读取。
      </p>
      <MutationError class="mt-5" :error="error" />
      <p
        class="log-connection-state meta mt-4"
        role="status"
        :data-log-end-reason="endReason || undefined"
      >
        {{
          endMessage ||
          (reading
            ? '连接已建立，正在接收所选容器的输出。'
            : '按所选实例、容器和尾部行数读取日志。')
        }}
      </p>
      <div class="log-toolbar mt-5">
        <span role="status"
          >{{ reading ? '正在读取' : text ? '连接已结束' : '尚未读取'
          }}{{ !followingScroll ? ' · 自动滚动已暂停' : '' }}</span
        >
        <label class="log-check"><input v-model="wrapLines" type="checkbox" />长行换行</label>
        <div class="log-toolbar-actions">
          <Button
            v-if="followingScroll && reading"
            variant="ghost"
            size="sm"
            @click="followingScroll = false"
            ><Pause />暂停滚动</Button
          ><Button v-if="!followingScroll || unread" variant="ghost" size="sm" @click="jumpToBottom"
            ><ArrowDown />回到最新{{ unread ? ` · ${unread} 条新输出` : '' }}</Button
          >
        </div>
      </div>
      <VirtualServiceLog
        ref="output"
        :text="text"
        :first-line="firstLine"
        :wrap="wrapLines"
        :following="followingScroll"
        :reading="reading"
        @pause="followingScroll = false"
      />
      <p class="meta mt-3">
        单次连接最多 60 秒 / 1 MiB。{{
          clipped
            ? '视图已裁剪较早输出，最多保留最近 10,000 行或 200,000 个字符（先到者为准）。'
            : '视图最多保留 10,000 行或 200,000 个字符；暂停自动滚动仍会裁剪较早输出。'
        }}
      </p>
    </template>
  </section>
</template>
<style scoped>
.log-filters {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(7rem, 0.6fr);
  gap: 1rem;
}
.log-check {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--secondary);
  border: 1px solid var(--border);
  border-bottom: 0;
  border-radius: 0.5rem 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.log-connection-state {
  min-height: 2.5rem;
}
.log-toolbar-actions {
  min-height: 2rem;
  min-width: 15rem;
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 639px) {
  .log-filters {
    grid-template-columns: 1fr;
  }
  .log-toolbar {
    flex-wrap: wrap;
  }
}
</style>
