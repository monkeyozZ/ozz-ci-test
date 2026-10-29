<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDown, Pause, Play, Square, ScrollText, Info } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import CopyButton from '@/components/CopyButton.vue';
import { sampleFreshness } from '@/components/infrastructure/format';
import { useObservationClock } from '@/components/infrastructure/useObservationClock';
import { api, eventStream } from '@/lib/api';
import { appendServiceLog, ServiceLogDecoder } from '@/lib/service-log-stream';
import { useAuthStore } from '@/stores/auth';
import VirtualServiceLog from './VirtualServiceLog.vue';
import { bufferedLogLines } from './useBufferedLog';
import type { Service } from './types';
const props = defineProps<{ service: Service }>();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const now = useObservationClock();
const current = computed(
  () =>
    !props.service.observationStale &&
    sampleFreshness(props.service.lastObservedAt, now.value) === 'fresh',
);
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
const phase = ref<'idle' | 'connecting' | 'streaming' | 'ended' | 'error'>('idle');
const reading = computed(() => phase.value === 'connecting' || phase.value === 'streaming');
const error = ref<unknown>(null);
const text = ref('');
const endMessage = ref('');
const endReason = ref('');
const followingScroll = ref(true);
const unread = ref(0);
const clipped = ref(false);
const wrapLines = ref(false);
const firstLine = ref(0);
const search = ref('');
const showingPreviousRead = ref(false);
const bufferScope = ref(0);
const filteredLines = computed(() => bufferedLogLines(text.value, firstLine.value, search.value));
const copyText = computed(() =>
  search.value
    ? filteredLines.value.map((line) => line.text).join('\n') +
      (filteredLines.value.length && text.value.endsWith('\n') ? '\n' : '')
    : text.value,
);
const copyContext = computed(() =>
  JSON.stringify([
    props.service.id,
    selectedPod.value,
    selectedContainer.value,
    previous.value,
    search.value,
    bufferScope.value,
  ]),
);
const phaseLabel = computed(
  () =>
    ({
      idle: '尚未读取',
      connecting: '正在连接',
      streaming: '正在接收',
      ended: '连接已结束',
      error: '读取失败',
    })[phase.value],
);
const connectionMessage = computed(() => {
  if (phase.value === 'connecting') return '正在连接所选容器，等待日志源响应…';
  if (phase.value === 'streaming') return '连接已建立，正在接收所选容器的输出。';
  if (endMessage.value) return endMessage.value;
  if (phase.value === 'error') return '本次连接失败，可以重新读取日志。';
  return '按所选实例、容器和尾部行数读取日志。';
});
const emptyMessage = computed(() => {
  if (phase.value === 'connecting') return '正在连接日志源…';
  if (phase.value === 'streaming') return '连接已建立，等待日志输出…';
  if (phase.value === 'ended') return '本次读取没有日志输出。';
  if (phase.value === 'error') return '本次未收到可显示的日志，可以重新读取。';
  return '选择实例与容器后读取日志。';
});
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
  const wasReading = reading.value;
  generation++;
  controller?.abort();
  controller = null;
  if (clear) {
    phase.value = 'idle';
    text.value = '';
    firstLine.value = 0;
    unread.value = 0;
    clipped.value = false;
    error.value = null;
    endMessage.value = '';
    endReason.value = '';
    showingPreviousRead.value = false;
    followingScroll.value = true;
    search.value = '';
    bufferScope.value++;
  } else if (wasReading) {
    phase.value = 'ended';
    endMessage.value = '已断开当前日志连接，已有输出保留。';
    endReason.value = 'user_closed';
  }
}
watch([selectedPod, selectedContainer, previous], () => stop(true), { flush: 'sync' });
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
  () => [route.query.tab, route.query.podUid, route.query.container] as const,
  ([tab, podUid, container]) => {
    if (tab !== 'logs') {
      if (reading.value) stop();
      return;
    }
    if (typeof podUid === 'string') selectedPod.value = podUid;
    if (typeof container === 'string') selectedContainer.value = container;
  },
  { flush: 'sync' },
);
watch(
  () => auth.user?.id,
  () => stop(true),
);
onScopeDispose(() => {
  stop(true);
});
async function choosePod() {
  selectedContainer.value = pod.value?.containers[0]?.name ?? '';
  await saveSelection();
}
async function saveSelection() {
  if (route.query.tab !== 'logs') return;
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
  if (followingScroll.value) await output.value?.jumpToBottom();
}
async function append(value: string, run: number) {
  const nextLine =
    firstLine.value +
    (text.value.match(/\n/g) ?? []).length +
    (text.value && !text.value.endsWith('\n') ? 1 : 0);
  const combined = text.value + value;
  const next = appendServiceLog(text.value, value);
  const removed = combined.length - next.text.length;
  if (removed) firstLine.value += (combined.slice(0, removed).match(/\n/g) ?? []).length;
  text.value = next.text;
  clipped.value ||= next.clipped;
  if (followingScroll.value) {
    await nextTick();
    if (run === generation && followingScroll.value) await output.value?.jumpToBottom();
  } else {
    unread.value = Math.min(
      9999,
      unread.value + filteredLines.value.filter((line) => line.key >= nextLine).length,
    );
  }
}
watch(search, async () => {
  unread.value = 0;
  await nextTick();
  if (followingScroll.value) await output.value?.jumpToBottom();
});
async function readLogs() {
  if (!pod.value || !validContainer.value || reading.value || route.query.tab !== 'logs') return;
  controller?.abort();
  const run = ++generation;
  const abort = new AbortController();
  controller = abort;
  phase.value = 'connecting';
  error.value = null;
  endMessage.value = '';
  endReason.value = '';
  showingPreviousRead.value = !!text.value;
  if (!text.value) followingScroll.value = true;
  let receivedOutput = false;
  function beginCurrentBuffer() {
    if (receivedOutput) return;
    receivedOutput = true;
    text.value = '';
    firstLine.value = 0;
    unread.value = 0;
    clipped.value = false;
    showingPreviousRead.value = false;
  }
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
    if (run === generation) phase.value = 'streaming';
    const decoder = new ServiceLogDecoder();
    let ended = false;
    while (run === generation && !ended) {
      const result = await reader.read();
      if (result.done) break;
      for (const event of decoder.push(result.value)) {
        if (run !== generation) break;
        if (event.type === 'log') {
          if (event.text) {
            beginCurrentBuffer();
            await append(event.text, run);
          }
        } else {
          // An empty, confirmed EOF is a successful new snapshot. A failed
          // connection before output leaves the previous snapshot available.
          if (event.reason === 'eof') beginCurrentBuffer();
          endMessage.value = event.message;
          endReason.value = event.reason;
          phase.value = ['source_error', 'access_changed'].includes(event.reason)
            ? 'error'
            : 'ended';
          ended = true;
          if (event.reason === 'access_changed') await api.get('/auth/me').catch(() => undefined);
          break;
        }
      }
    }
    if (run === generation && !ended) {
      endMessage.value = '日志连接结束，未收到完整结束确认。可以重新读取尾部。';
      phase.value = 'error';
    }
  } catch (failure) {
    if (run === generation && !abort.signal.aborted) {
      error.value = failure;
      phase.value = 'error';
    }
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    if (run === generation) {
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
          current && service.observation && service.runtimeState === 'stopped'
            ? '服务已停止，没有当前实例可读取。部署和操作日志保留在各自任务中。'
            : service.desiredState === 'stopped'
              ? '期望状态为停止，尚无最新观察确认实际是否已停止。部署和操作日志仍可查看。'
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
        <CopyButton
          :text="copyText"
          :context-key="copyContext"
          :label="search ? '复制匹配日志' : '复制缓冲日志'"
        />
      </div>
      <p v-if="pod && selectedContainer && !validContainer" class="meta mt-3" role="status">
        原容器已不可用，请选择当前实例中的容器后读取。
      </p>
      <QueryState
        class="mt-3"
        :error="error"
        :refreshing="phase === 'connecting'"
        @retry="readLogs"
      >
        <p
          class="log-connection-state meta mt-4"
          role="status"
          :data-log-end-reason="endReason || undefined"
          :data-log-phase="phase"
        >
          {{ connectionMessage }}
          <span v-if="showingPreviousRead" class="block">{{
            reading
              ? '下方保留上次读取的日志，收到本次输出后更新。'
              : '下方保留上次读取的日志，本次未更新缓冲。'
          }}</span>
        </p>
        <div class="log-toolbar mt-5">
          <span role="status"
            >{{ phaseLabel }}{{ !followingScroll ? ' · 自动滚动已暂停' : '' }}</span
          >
          <input
            v-model="search"
            type="search"
            class="input log-search"
            aria-label="搜索容器日志"
            placeholder="搜索当前缓冲日志"
          />
          <span v-if="search" role="status">{{ filteredLines.length }} 行匹配</span>
          <label class="log-check"><input v-model="wrapLines" type="checkbox" />长行换行</label>
          <div class="log-toolbar-actions">
            <Button
              v-if="followingScroll && (reading || text)"
              variant="ghost"
              size="sm"
              @click="followingScroll = false"
              ><Pause />暂停滚动</Button
            ><Button
              v-if="!followingScroll || unread"
              variant="ghost"
              size="sm"
              @click="jumpToBottom"
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
          :search="search"
          :empty-message="emptyMessage"
          @pause="followingScroll = false"
        />
        <p class="meta mt-3">
          单次连接最多 60 秒 / 1 MiB。{{
            clipped
              ? '视图已裁剪较早输出，最多保留最近 10,000 行或 200,000 个字符（先到者为准）。'
              : '视图最多保留 10,000 行或 200,000 个字符；暂停自动滚动仍会裁剪较早输出。'
          }}
        </p>
      </QueryState>
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
  flex-wrap: wrap;
  padding: 0.75rem 1rem;
  background: var(--secondary);
  border: 1px solid var(--border);
  border-bottom: 0;
  border-radius: 0.5rem 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.log-search {
  width: min(100%, 18rem);
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
