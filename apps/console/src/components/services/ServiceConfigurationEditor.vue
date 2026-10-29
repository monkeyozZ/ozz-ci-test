<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ChevronRight, Image, Plus, Trash2, Info } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCollection } from '@/lib/query';
import { resourceSlug } from '@/lib/utils';
import type { SecretReference } from '@/lib/types';
import type { Probe, ServiceDraft } from './types';
import ServiceVariablesEditor from './ServiceVariablesEditor.vue';
const form = defineModel<ServiceDraft>({ required: true });
const props = defineProps<{
  disabled?: boolean;
  creating?: boolean;
  compact?: boolean;
  hideVariables?: boolean;
  protectedConfiguration?: boolean;
  protectionReason?: string;
  sourceKind?: 'image' | 'github';
}>();
const uid = useId();
const tab = ref('image');
const root = ref<HTMLElement>();
let currentDraft = form.value;
let slugSuffix = crypto.randomUUID().slice(0, 8);
let generatedSlug = '';
let slugEdited = Boolean(form.value.slug);
watch(
  () => [props.creating, form.value, form.value.name] as const,
  ([creating, draft, name]) => {
    if (draft !== currentDraft) {
      currentDraft = draft;
      slugSuffix = crypto.randomUUID().slice(0, 8);
      generatedSlug = '';
      slugEdited = Boolean(draft.slug);
    }
    if (!creating || slugEdited) return;
    if (draft.slug && draft.slug !== generatedSlug) {
      slugEdited = true;
      return;
    }
    generatedSlug = name.trim() ? resourceSlug(name, slugSuffix) : '';
    draft.slug = generatedSlug;
  },
  { immediate: true },
);
async function validate(): Promise<boolean> {
  const invalid = root.value?.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input:invalid, select:invalid, textarea:invalid');
  if (!invalid) return true;
  tab.value =
    invalid.closest<HTMLElement>('[data-config-section]')?.dataset.configSection ?? 'image';
  let details = invalid.closest('details');
  while (details) {
    details.open = true;
    details = details.parentElement?.closest('details') ?? null;
  }
  await nextTick();
  invalid.focus();
  invalid.reportValidity();
  return false;
}
defineExpose({ validate });
const sections = computed(() => [
  { id: 'image', label: props.sourceKind === 'github' ? '服务名称' : '镜像与名称' },
  { id: 'runtime', label: '启动与资源' },
  { id: 'ports', label: '端口与探针' },
  ...(!props.hideVariables ? [{ id: 'variables', label: '环境变量' }] : []),
]);
const credentials = useCollection<SecretReference>(
  '/secrets',
  { kind: 'registry' },
  () => props.sourceKind !== 'github',
);
const probeNames = ['readiness', 'startup'] as const;
async function addPort() {
  form.value.ports.push({
    name: '',
    protocol: 'http',
    containerPort: 3000,
    servicePort: 80,
  });
  await nextTick();
  const name = document.getElementById(`${uid}-port-${form.value.ports.length - 1}-name`);
  const details = name?.closest('details');
  if (details) details.open = true;
  name?.focus();
}
function setProbe(name: (typeof probeNames)[number], event: Event) {
  const type = (event.target as HTMLSelectElement).value;
  form.value[name] =
    type === 'none'
      ? null
      : {
          type: type as Probe['type'],
          port: form.value.ports[0]?.name ?? '',
          ...(type === 'http' ? { path: '/' } : {}),
          initialDelaySeconds: 0,
          periodSeconds: 10,
          timeoutSeconds: 1,
          failureThreshold: name === 'startup' ? 30 : 3,
        };
}
</script>
<template>
  <div ref="root" class="configuration-editor" :class="{ 'configuration-editor-compact': compact }">
    <div v-if="protectedConfiguration" class="notice mb-5" data-database-config-protection>
      <Info />
      <div>
        <strong>数据库模板配置受保护</strong>
        <p>
          {{ protectionReason || '数据库镜像、启动方式、初始化变量与数据布局由固定模板管理。' }}
        </p>
        <p class="meta mt-2">可修改名称、说明与资源设置。本页不能执行密码轮换或主版本升级。</p>
      </div>
    </div>
    <nav v-if="!compact" class="editor-tabs" aria-label="配置分组">
      <Button
        v-for="section in sections"
        :key="section.id"
        type="button"
        :variant="tab === section.id ? 'secondary' : 'ghost'"
        :aria-pressed="tab === section.id"
        @click="tab = section.id"
        >{{ section.label }}</Button
      >
    </nav>
    <fieldset :disabled="disabled" class="min-w-0 config-sections">
      <div v-show="compact || tab === 'image'" class="stack" data-config-section="image">
        <div v-if="!compact" class="section-head">
          <div>
            <h2 class="flex items-center gap-2">
              <Image v-if="sourceKind !== 'github'" class="size-4" />{{
                sourceKind === 'github' ? '服务信息' : 'Docker 镜像'
              }}
            </h2>
            <p class="meta mt-1">
              {{
                sourceKind === 'github'
                  ? '保存服务名称与运行配置，构建来源在下方单独配置。'
                  : '支持公开或私有镜像，发布时固定实际内容摘要。'
              }}
            </p>
          </div>
        </div>
        <div :class="compact ? 'field' : 'form-grid'">
          <div class="field">
            <label :for="`${uid}-name`">服务名称</label
            ><Input
              :id="`${uid}-name`"
              v-model="form.name"
              required
              maxlength="120"
              placeholder="例如：个人博客"
            />
          </div>
          <div v-if="!compact" class="field">
            <label :for="`${uid}-slug`">服务标识</label
            ><Input
              :id="`${uid}-slug`"
              v-model="form.slug"
              @input="slugEdited = true"
              required
              maxlength="63"
              pattern="[a-z0-9][a-z0-9-]*"
              :disabled="!creating"
              class="mono"
              placeholder="blog-web"
            />
            <p class="meta">创建后保持固定，显示名称可以修改。</p>
          </div>
        </div>
        <div v-if="sourceKind !== 'github'" class="field">
          <label :for="`${uid}-image`">镜像地址</label
          ><Input
            :id="`${uid}-image`"
            v-model="form.image"
            :readonly="protectedConfiguration"
            required
            maxlength="1024"
            class="mono"
            placeholder="ghcr.io/owner/app:1.0.0"
            autocomplete="off"
          />
          <p class="meta">
            {{
              compact
                ? '填写镜像地址与版本标签，也可使用 @sha256:… 固定版本。'
                : '可使用版本标签或 @sha256:…；目标节点架构会在发布任务中核对。'
            }}
          </p>
        </div>
        <div v-if="sourceKind !== 'github'" class="field">
          <label :for="`${uid}-registry`">镜像拉取凭证</label
          ><select
            :id="`${uid}-registry`"
            v-model="form.registryCredentialRefId"
            class="input"
            :disabled="protectedConfiguration"
          >
            <option value="">公开镜像，无需凭证</option>
            <option
              v-if="
                form.registryCredentialRefId &&
                !credentials.items.value.some((item) => item.id === form.registryCredentialRefId)
              "
              :value="form.registryCredentialRefId"
            >
              当前凭证 · {{ form.registryCredentialRefId }}
            </option>
            <option
              v-for="credential in credentials.items.value"
              :key="credential.id"
              :value="credential.id"
            >
              {{ credential.name }}
            </option>
          </select>
          <p class="meta">
            私有镜像使用独立仓库凭证。<RouterLink to="/settings" class="text-link"
              >管理凭证</RouterLink
            >
          </p>
          <Button
            v-if="credentials.hasNextPage.value"
            type="button"
            variant="ghost"
            :disabled="credentials.isFetchingNextPage.value"
            @click="credentials.fetchNextPage()"
            >载入更多仓库凭证</Button
          >
        </div>
        <div v-if="!compact" class="field">
          <label :for="`${uid}-description`">描述 <span class="meta">（选填）</span></label
          ><Textarea
            :id="`${uid}-description`"
            v-model="form.description"
            maxlength="1000"
            rows="3"
          />
        </div>
      </div>
      <fieldset
        v-show="compact || tab === 'ports'"
        class="stack"
        data-config-section="ports"
        :disabled="protectedConfiguration"
      >
        <section>
          <div class="section-head">
            <div>
              <h2>{{ compact ? '服务端口' : '具名端口' }}</h2>
              <p class="meta mt-1">
                {{ compact ? '填写应用实际监听的端口。' : '容器端口映射为环境内的私有服务端口。' }}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              :disabled="form.ports.length >= 16"
              @click="addPort"
              ><Plus />添加端口</Button
            >
          </div>
          <div
            v-for="(port, index) in form.ports"
            :key="index"
            :class="compact ? 'compact-port-row' : 'port-row'"
          >
            <div v-if="!compact" class="field">
              <label :for="`${uid}-port-${index}-name`">端口名称</label
              ><Input
                :id="`${uid}-port-${index}-name`"
                v-model="port.name"
                required
                maxlength="15"
                placeholder="http"
              />
            </div>
            <div v-if="!compact" class="field">
              <label :for="`${uid}-port-${index}-type`">类型</label
              ><select :id="`${uid}-port-${index}-type`" v-model="port.protocol" class="input">
                <option value="http">HTTP</option>
                <option value="tcp">TCP</option>
              </select>
            </div>
            <div class="field">
              <label :for="`${uid}-port-${index}-container`">容器端口</label
              ><Input
                :id="`${uid}-port-${index}-container`"
                v-model.number="port.containerPort"
                type="number"
                required
                min="1"
                max="65535"
              />
            </div>
            <div v-if="compact" class="field">
              <label :for="`${uid}-port-${index}-type`">类型</label>
              <select :id="`${uid}-port-${index}-type`" v-model="port.protocol" class="input">
                <option value="http">HTTP</option>
                <option value="tcp">TCP</option>
              </select>
            </div>
            <div v-if="!compact" class="field">
              <label :for="`${uid}-port-${index}-service`">私有服务端口</label
              ><Input
                :id="`${uid}-port-${index}-service`"
                v-model.number="port.servicePort"
                type="number"
                required
                min="1"
                max="65535"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              :aria-label="`删除端口 ${port.name || index + 1}`"
              @click="form.ports.splice(index, 1)"
              ><Trash2
            /></Button>
            <details v-if="compact" class="compact-port-options">
              <summary><ChevronRight />名称与内部访问端口</summary>
              <div class="form-grid mt-4">
                <div class="field">
                  <label :for="`${uid}-port-${index}-name`">端口名称</label>
                  <Input
                    :id="`${uid}-port-${index}-name`"
                    v-model="port.name"
                    required
                    maxlength="15"
                    placeholder="http"
                  />
                </div>
                <div class="field">
                  <label :for="`${uid}-port-${index}-service`">私有服务端口</label>
                  <Input
                    :id="`${uid}-port-${index}-service`"
                    v-model.number="port.servicePort"
                    type="number"
                    required
                    min="1"
                    max="65535"
                  />
                </div>
              </div>
            </details>
          </div>
          <p v-if="!form.ports.length" class="muted py-5">无端口的服务作为后台任务运行。</p>
          <div v-if="!compact" class="notice mt-4">
            <Info />
            <p>这里配置内部访问端口。公网域名、HTTPS 与外部 TCP 入口在后续网络设置中提供。</p>
          </div>
        </section>
        <component :is="compact ? 'details' : 'div'" :class="compact ? 'compact-section' : 'stack'">
          <summary v-if="compact"><ChevronRight />健康检查</summary>
          <div :class="compact ? 'stack compact-section-body' : 'stack'">
            <section v-for="probeName in probeNames" :key="probeName">
              <h2>{{ probeName === 'readiness' ? '就绪探针' : '启动探针' }}</h2>
              <div class="field mt-4">
                <label :for="`${uid}-${probeName}-type`">检查方式</label
                ><select
                  :id="`${uid}-${probeName}-type`"
                  :value="form[probeName]?.type ?? 'none'"
                  class="input max-w-80"
                  @change="setProbe(probeName, $event)"
                >
                  <option value="none">不配置</option>
                  <option value="http">HTTP</option>
                  <option value="tcp">TCP</option>
                </select>
              </div>
              <div v-if="form[probeName]" class="form-grid mt-4">
                <div class="field">
                  <label :for="`${uid}-${probeName}-port`">探针端口</label
                  ><select
                    :id="`${uid}-${probeName}-port`"
                    v-model="form[probeName]!.port"
                    required
                    class="input"
                  >
                    <option value="" disabled>选择具名端口</option>
                    <option v-for="port in form.ports" :key="port.name" :value="port.name">
                      {{ port.name || '未命名' }}
                    </option>
                  </select>
                </div>
                <div v-if="form[probeName]!.type === 'http'" class="field">
                  <label :for="`${uid}-${probeName}-path`">HTTP 路径</label
                  ><Input
                    :id="`${uid}-${probeName}-path`"
                    v-model="form[probeName]!.path"
                    required
                    maxlength="2048"
                    placeholder="/health"
                  />
                </div>
                <div
                  v-for="field in [
                    { key: 'initialDelaySeconds', label: '初始延迟（秒）', min: 0 },
                    { key: 'periodSeconds', label: '检查间隔（秒）', min: 1 },
                    { key: 'timeoutSeconds', label: '单次超时（秒）', min: 1 },
                    { key: 'failureThreshold', label: '失败阈值（次）', min: 1 },
                  ] as const"
                  :key="field.key"
                  class="field"
                >
                  <label :for="`${uid}-${probeName}-${field.key}`">{{ field.label }}</label
                  ><Input
                    :id="`${uid}-${probeName}-${field.key}`"
                    v-model.number="form[probeName]![field.key]"
                    type="number"
                    required
                    :min="field.min"
                    step="1"
                  />
                </div>
              </div>
              <p v-else class="meta mt-2">
                {{
                  probeName === 'readiness'
                    ? '未配置时仅观察 Kubernetes 就绪状态，不能证明应用业务请求成功。'
                    : '启动较慢的应用可通过启动探针延后就绪检查。'
                }}
              </p>
            </section>
            <div class="field">
              <label :for="`${uid}-timeout`">发布健康等待上限（秒）</label
              ><Input
                :id="`${uid}-timeout`"
                v-model.number="form.healthTimeoutSeconds"
                type="number"
                required
                min="10"
                max="900"
                class="max-w-60"
              />
            </div>
          </div>
        </component>
      </fieldset>
      <details v-if="compact" class="compact-section" data-config-section="image">
        <summary><ChevronRight />标识与描述</summary>
        <div class="stack compact-section-body">
          <div class="field">
            <label :for="`${uid}-slug`">服务标识</label>
            <Input
              :id="`${uid}-slug`"
              v-model="form.slug"
              required
              maxlength="63"
              pattern="[a-z0-9][a-z0-9-]*"
              :disabled="!creating"
              class="mono"
              placeholder="根据名称自动生成"
              @input="slugEdited = true"
            />
            <p class="meta">用于内部资源命名，通常无需修改。创建后保持固定。</p>
          </div>
          <div class="field">
            <label :for="`${uid}-description`">描述 <span class="meta">（选填）</span></label>
            <Textarea
              :id="`${uid}-description`"
              v-model="form.description"
              maxlength="1000"
              rows="3"
            />
          </div>
        </div>
      </details>
      <component
        :is="compact ? 'details' : 'div'"
        v-show="compact || tab === 'runtime'"
        :class="compact ? 'compact-section' : 'stack'"
        data-config-section="runtime"
      >
        <summary v-if="compact"><ChevronRight />启动方式与资源</summary>
        <div :class="compact ? 'stack compact-section-body' : 'stack'">
          <div v-if="!compact">
            <h2>启动与资源</h2>
            <p class="meta mt-1">资源设置按每个副本计算。停止服务会保留这里的副本数。</p>
          </div>
          <div class="form-grid">
            <div class="field">
              <label :for="`${uid}-command`">启动命令（JSON 数组）</label
              ><Textarea
                :id="`${uid}-command`"
                v-model="form.commandText"
                :readonly="protectedConfiguration"
                rows="3"
                class="mono"
                spellcheck="false"
              />
              <p class="meta">例如 ["node"]；空数组沿用镜像入口。</p>
            </div>
            <div class="field">
              <label :for="`${uid}-args`">启动参数（JSON 数组）</label
              ><Textarea
                :id="`${uid}-args`"
                v-model="form.argsText"
                :readonly="protectedConfiguration"
                rows="3"
                class="mono"
                spellcheck="false"
              />
              <p class="meta">例如 ["server.js", "--port", "3000"]，每项保留参数边界。</p>
            </div>
          </div>
          <div class="field">
            <label :for="`${uid}-replicas`">副本数</label
            ><Input
              :id="`${uid}-replicas`"
              v-model.number="form.replicas"
              :readonly="protectedConfiguration"
              type="number"
              required
              min="1"
              max="20"
              step="1"
              class="max-w-60"
            />
          </div>
          <div class="form-grid">
            <div
              v-for="bound in ['requests', 'limits'] as const"
              :key="bound"
              class="resource-fields"
            >
              <h3 class="mb-3">{{ bound === 'requests' ? '资源请求' : '资源上限' }}</h3>
              <div class="field">
                <label :for="`${uid}-${bound}-cpu`">每副本 CPU（mCPU）</label
                ><Input
                  :id="`${uid}-${bound}-cpu`"
                  v-model.number="form.resources[bound].cpuMillis"
                  type="number"
                  required
                  min="1"
                  step="1"
                />
                <p class="meta">1000 mCPU = 1 核</p>
              </div>
              <div class="field mt-4">
                <label :for="`${uid}-${bound}-memory`">每副本内存（MiB）</label
                ><Input
                  :id="`${uid}-${bound}-memory`"
                  v-model.number="form.resources[bound].memoryMiB"
                  type="number"
                  required
                  min="1"
                  step="1"
                />
              </div>
            </div>
          </div>
        </div>
      </component>
      <component
        :is="compact ? 'details' : 'div'"
        v-if="!hideVariables"
        v-show="compact || tab === 'variables'"
        :class="compact ? 'compact-section' : undefined"
        data-config-section="variables"
      >
        <summary v-if="compact">
          <ChevronRight />环境变量<span v-if="form.variables.length" class="meta"
            >{{ form.variables.length }} 项</span
          >
        </summary>
        <ServiceVariablesEditor
          v-model="form.variables"
          :disabled="disabled || protectedConfiguration"
          :class="{ 'compact-section-body': compact }"
        />
      </component>
    </fieldset>
  </div>
</template>
<style scoped>
.editor-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  padding-bottom: 1.25rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.port-row {
  display: grid;
  grid-template-columns:
    minmax(7rem, 1fr) minmax(5rem, 0.6fr) minmax(7rem, 1fr) minmax(7rem, 1fr)
    auto;
  gap: 1rem;
  align-items: start;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border);
}
.port-row > button {
  margin-top: 1.75rem;
}
.configuration-editor-compact .config-sections {
  display: grid;
  gap: 1.5rem;
}
.compact-section {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.compact-section > summary,
.compact-port-options > summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  cursor: pointer;
  list-style: none;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.compact-section > summary::-webkit-details-marker,
.compact-port-options > summary::-webkit-details-marker {
  display: none;
}
.compact-section > summary > svg,
.compact-port-options > summary > svg {
  width: 1rem;
  height: 1rem;
}
.compact-section[open] > summary > svg,
.compact-port-options[open] > summary > svg {
  transform: rotate(90deg);
}
.compact-section-body {
  padding-top: 1rem;
}
.compact-port-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: start;
  gap: 1rem;
  padding: 1rem 0;
}
.compact-port-row > button {
  margin-top: 1.75rem;
}
.compact-port-options {
  grid-column: 1 / -1;
}
.compact-port-options > summary {
  min-height: 2rem;
  font-size: 0.8125rem;
}
@media (max-width: 850px) {
  .port-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .port-row > .field:nth-child(3) {
    grid-row: 2;
  }
  .port-row > .field:nth-child(4) {
    grid-row: 2;
  }
  .port-row > button {
    grid-row: 1;
    grid-column: 3;
  }
}
</style>
