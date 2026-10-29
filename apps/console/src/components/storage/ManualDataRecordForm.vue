<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { LoaderCircle, Search } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient, useCollection } from '@/lib/query';
import { dateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useViewScope } from '@/composables/useViewScope';
import { useDirtyForm } from '@/composables/useDirtyForm';
import type { Volume, ManualDataRecord, CreateManualDataRecordInput } from './types';
import StorageMutationError from './StorageMutationError.vue';
import StorageTarget from './StorageTarget.vue';
import { storageContext, engineLabel } from './presentation';
import { formatStorageBytes } from './format';
const props = defineProps<{ volume: Volume }>();
const emit = defineEmits<{ saved: [record: ManualDataRecord] }>();
const auth = useAuthStore();
const active = useViewScope();
const prefix = useId();
const initialForm = () => ({
  type: 'backup' as 'backup' | 'restore',
  backupRecordId: '',
  targetId: '',
  backupId: '',
  engine: (props.volume.retainedDatabase?.engine === 'postgresql'
    ? 'postgresql'
    : props.volume.retainedDatabase?.engine === 'redis'
      ? 'redis'
      : 'files') as 'postgresql' | 'redis' | 'files',
  engineVersion: '',
  dataLayout: '',
  format: '',
  toolVersion: '',
  sizeBytes: '',
  sha256: '',
  startedAt: '',
  completedAt: '',
  dataFrom: '',
  dataTo: '',
  dataDescription: '',
  offHostLocationLabel: '',
  integrity: 'unknown' as 'passed' | 'failed' | 'unknown',
  result: 'incomplete' as 'passed' | 'failed' | 'incomplete',
  verificationSteps: '',
  evidenceReferences: '',
});
const form = ref(initialForm());
const guard = useDirtyForm(form, '手工数据记录');
const localError = ref<Error | null>(null);
const resource = computed(() => `/volumes/${props.volume.id}/manual-data-records`);
const backups = useCollection<ManualDataRecord>(
  resource,
  { type: 'backup' },
  computed(() => form.value.type === 'restore'),
);
const backup = computed(() =>
  backups.items.value.find((item) => item.id === form.value.backupRecordId),
);
const targetSearch = ref('');
const targetParams = computed<Record<string, string>>(() => ({
  ...(targetSearch.value.trim() ? { search: targetSearch.value.trim() } : {}),
}));
const targets = useCollection<Volume>(
  '/volumes',
  targetParams,
  computed(() => form.value.type === 'restore'),
);
const target = useQuery({
  queryKey: computed(() => ['volume', form.value.targetId]),
  enabled: computed(() => form.value.type === 'restore' && !!form.value.targetId),
  queryFn: ({ queryKey, signal }) => api.get<Volume>(`/volumes/${queryKey[1]}`, signal),
});
const selectedTargetContext = computed(() =>
  target.data.value ? storageContext(target.data.value) : null,
);
const eligibleTargets = computed(() =>
  targets.items.value.filter(
    (item) =>
      item.id !== props.volume.id && item.desiredState === 'active' && item.manualDataIdentity,
  ),
);
const save = useMutation({
  mutationFn: (input: CreateManualDataRecordInput) =>
    api.create<ManualDataRecord>(resource.value, input),
  onSuccess: async (record) => {
    await Promise.all([
      invalidateCollection(resource.value),
      queryClient.invalidateQueries({ queryKey: ['volume', props.volume.id] }),
    ]);
    if (!active()) return;
    form.value = initialForm();
    guard.markClean();
    emit('saved', record);
  },
});
function iso(value: string, label: string) {
  const time = new Date(value);
  if (!value || Number.isNaN(time.valueOf())) throw new Error(`请填写有效的${label}。`);
  return time.toISOString();
}
function submit() {
  if (save.isPending.value || auth.restoreMode || !props.volume.manualDataIdentity) return;
  localError.value = null;
  try {
    const restore = form.value.type === 'restore';
    if (
      restore &&
      (!backup.value ||
        !target.data.value?.manualDataIdentity ||
        target.data.value.id === props.volume.id)
    )
      throw new Error('选择已登记的备份清单和不同于源卷的新目标。');
    const manifest = restore
      ? backup.value!
      : {
          backupId: form.value.backupId.trim(),
          source: props.volume.manualDataIdentity,
          engine: form.value.engine,
          engineVersion: form.value.engineVersion.trim(),
          dataLayout: form.value.dataLayout.trim(),
          format: form.value.format.trim(),
          toolVersion: form.value.toolVersion.trim(),
          sizeBytes: form.value.sizeBytes.trim(),
          sha256: form.value.sha256.trim().toLowerCase(),
          dataTime: {
            from: form.value.dataFrom ? iso(form.value.dataFrom, '数据起始时间') : null,
            to: form.value.dataTo ? iso(form.value.dataTo, '数据截止时间') : null,
            description: form.value.dataDescription.trim(),
          },
          offHostLocationLabel: form.value.offHostLocationLabel.trim(),
        };
    if (!/^[1-9][0-9]{0,15}$/.test(manifest.sizeBytes))
      throw new Error('备份大小需要填写清单中的字节数。');
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256))
      throw new Error('SHA256 需要完整的 64 位十六进制校验值。');
    const startedAt = iso(form.value.startedAt, '执行开始时间');
    const completedAt = iso(form.value.completedAt, '执行结束时间');
    if (completedAt < startedAt) throw new Error('执行结束时间不能早于开始时间。');
    if (
      manifest.dataTime.from &&
      manifest.dataTime.to &&
      manifest.dataTime.to < manifest.dataTime.from
    )
      throw new Error('数据截止时间不能早于起始时间。');
    const lines = (value: string) =>
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const verificationSteps = lines(form.value.verificationSteps);
    const evidenceReferences = lines(form.value.evidenceReferences);
    if (verificationSteps.length > 20 || verificationSteps.some((step) => step.length > 500))
      throw new Error('验证步骤最多 20 条，每条不超过 500 个字符。');
    if (
      evidenceReferences.length > 20 ||
      evidenceReferences.some((reference) => reference.length > 300)
    )
      throw new Error('证据引用最多 20 条，每条不超过 300 个字符。');
    if (form.value.result === 'passed' && (!verificationSteps.length || !evidenceReferences.length))
      throw new Error('报告验证通过时，请附实际验证步骤和证据引用。');
    save.mutate({
      type: form.value.type,
      backupId: manifest.backupId,
      source: manifest.source,
      target: restore ? target.data.value!.manualDataIdentity! : null,
      engine: manifest.engine,
      engineVersion: manifest.engineVersion,
      dataLayout: manifest.dataLayout,
      format: manifest.format,
      toolVersion: restore ? form.value.toolVersion.trim() : manifest.toolVersion,
      sizeBytes: manifest.sizeBytes,
      sha256: manifest.sha256,
      startedAt,
      completedAt,
      dataTime: manifest.dataTime,
      offHostLocationLabel: manifest.offHostLocationLabel,
      integrity: form.value.integrity,
      verificationSteps,
      result: form.value.result,
      evidenceReferences,
    });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查记录内容。');
  }
}
</script>
<template>
  <form data-manual-data-record-form @submit.prevent="submit">
    <p class="field-hint mb-5">
      按实际执行结果登记清单与证据。保存记录不会执行导出、导入或验证数据。
    </p>
    <fieldset :disabled="save.isPending.value || auth.restoreMode" class="record-fields">
      <legend class="sr-only">手工记录内容</legend>
      <div class="field">
        <label :for="`${prefix}-type`">记录类型</label
        ><select :id="`${prefix}-type`" v-model="form.type" class="input">
          <option value="backup">手工备份</option>
          <option value="restore">手工恢复到新目标</option>
        </select>
      </div>
      <div class="field">
        <label>源卷</label>
        <p class="source-name">
          {{ volume.name
          }}<span class="meta block mt-1"
            >{{ volume.project?.name }} / {{ volume.environment?.name }} ·
            {{ volume.cluster?.name }}</span
          >
        </p>
      </div>
      <template v-if="form.type === 'restore'">
        <div class="field record-wide">
          <label :for="`${prefix}-backup`">已登记的备份清单</label
          ><select :id="`${prefix}-backup`" v-model="form.backupRecordId" class="input" required>
            <option value="" disabled>选择源卷的备份记录</option>
            <option v-for="item in backups.items.value" :key="item.id" :value="item.id">
              {{ item.backupId }} · {{ dateTime(item.completedAt) }} ·
              {{ item.result === 'passed' ? '报告通过' : '未确认通过' }}
            </option></select
          ><Button
            v-if="backups.hasNextPage.value"
            type="button"
            variant="ghost"
            class="self-start"
            :disabled="backups.isFetchingNextPage.value"
            @click="backups.fetchNextPage()"
            >载入更多备份记录</Button
          ><QueryState
            :pending="backups.isPending.value"
            :error="backups.error.value"
            @retry="backups.refetch()"
          />
        </div>
        <div v-if="backup" class="record-wide notice">
          <div>
            <strong>沿用已登记的不可变备份清单</strong>
            <p class="mt-2">
              {{ engineLabel(backup.engine) }} {{ backup.engineVersion }} · {{ backup.format }} ·
              {{ formatStorageBytes(backup.sizeBytes) }}
            </p>
            <p class="mono text-xs mt-2 break-all">SHA256 {{ backup.sha256 }}</p>
            <p class="field-hint mt-2">
              {{ backup.dataTime.description }} · {{ backup.offHostLocationLabel }}
            </p>
          </div>
        </div>
        <div class="field record-wide">
          <label :for="`${prefix}-target-search`">查找新目标卷</label>
          <div class="relative">
            <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
              :id="`${prefix}-target-search`"
              v-model="targetSearch"
              class="pl-10"
              placeholder="输入新目标卷名称"
            />
          </div>
          <label :for="`${prefix}-target`">恢复目标</label
          ><select :id="`${prefix}-target`" v-model="form.targetId" class="input" required>
            <option value="" disabled>选择已创建且已确认 PVC 身份的新卷</option>
            <option
              v-if="
                target.data.value &&
                !eligibleTargets.some((item) => item.id === target.data.value!.id)
              "
              :value="target.data.value.id"
            >
              {{ target.data.value.name }}
            </option>
            <option v-for="item in eligibleTargets" :key="item.id" :value="item.id">
              {{ item.name }} · {{ item.project?.name }} / {{ item.environment?.name }} ·
              {{ item.cluster?.name }}
            </option>
          </select>
          <p class="field-hint">
            原卷保持保留。目标卷必须有独立 PVC 身份；恢复完成后不会自动切换消费者或流量。
          </p>
          <Button
            v-if="targets.hasNextPage.value"
            type="button"
            variant="ghost"
            class="self-start"
            :disabled="targets.isFetchingNextPage.value"
            @click="targets.fetchNextPage()"
            >载入更多目标卷</Button
          ><QueryState
            :pending="targets.isPending.value"
            :error="targets.error.value || target.error.value"
            @retry="
              targets.refetch();
              if (form.targetId) target.refetch();
            "
          /><StorageTarget v-if="selectedTargetContext" :context="selectedTargetContext" />
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label :for="`${prefix}-backup-id`">备份清单 ID</label
          ><Input :id="`${prefix}-backup-id`" v-model="form.backupId" required maxlength="120" />
          <p class="field-hint">填写备份工具清单中的稳定 backupId。</p>
        </div>
        <div class="field">
          <label :for="`${prefix}-engine`">数据类型</label
          ><select :id="`${prefix}-engine`" v-model="form.engine" class="input">
            <option value="postgresql">PostgreSQL</option>
            <option value="redis">Redis</option>
            <option value="files">文件卷</option>
          </select>
        </div>
        <div class="field">
          <label :for="`${prefix}-version`">引擎或数据版本</label
          ><Input :id="`${prefix}-version`" v-model="form.engineVersion" required maxlength="120" />
        </div>
        <div class="field">
          <label :for="`${prefix}-layout`">数据布局</label
          ><Input :id="`${prefix}-layout`" v-model="form.dataLayout" required maxlength="200" />
        </div>
        <div class="field">
          <label :for="`${prefix}-format`">备份格式</label
          ><Input
            :id="`${prefix}-format`"
            v-model="form.format"
            required
            maxlength="80"
            placeholder="如 pg_dump custom、RDB、tar"
          />
        </div>
        <div class="field">
          <label :for="`${prefix}-bytes`">清单大小（字节）</label
          ><Input
            :id="`${prefix}-bytes`"
            v-model="form.sizeBytes"
            required
            inputmode="numeric"
            pattern="[1-9][0-9]{0,15}"
            maxlength="16"
          />
        </div>
        <div class="field record-wide">
          <label :for="`${prefix}-sha`">SHA256</label
          ><Input
            :id="`${prefix}-sha`"
            v-model="form.sha256"
            class="mono"
            required
            minlength="64"
            maxlength="64"
            pattern="[a-fA-F0-9]{64}"
          />
        </div>
        <div class="field record-wide">
          <label :for="`${prefix}-location`">离机副本位置标签</label
          ><Input
            :id="`${prefix}-location`"
            v-model="form.offHostLocationLabel"
            required
            maxlength="300"
            placeholder="例如：离机备份盘 / 订单库 2026-10-26"
          />
          <p class="field-hint">
            仅记录可定位副本的标签；不要填写密码、访问密钥或带签名的下载地址。
          </p>
        </div>
        <div class="field">
          <label :for="`${prefix}-data-from`">数据时间范围起点 <span class="meta">可选</span></label
          ><Input
            :id="`${prefix}-data-from`"
            v-model="form.dataFrom"
            type="datetime-local"
            step="1"
          />
        </div>
        <div class="field">
          <label :for="`${prefix}-data-to`">数据时间范围终点 <span class="meta">可选</span></label
          ><Input :id="`${prefix}-data-to`" v-model="form.dataTo" type="datetime-local" step="1" />
        </div>
        <div class="field record-wide">
          <label :for="`${prefix}-data-description`">可恢复的数据时间点说明</label
          ><Textarea
            :id="`${prefix}-data-description`"
            v-model="form.dataDescription"
            required
            maxlength="500"
            rows="2"
            placeholder="说明可确认的时间点；不能确认时明确记录未知。"
          />
        </div>
      </template>
      <div class="field record-wide">
        <label :for="`${prefix}-tool`">本次执行工具与版本</label
        ><Input :id="`${prefix}-tool`" v-model="form.toolVersion" required maxlength="200" />
      </div>
      <div class="field">
        <label :for="`${prefix}-started`">执行开始时间（本地时间）</label
        ><Input
          :id="`${prefix}-started`"
          v-model="form.startedAt"
          type="datetime-local"
          step="1"
          required
        />
      </div>
      <div class="field">
        <label :for="`${prefix}-completed`">执行结束时间（本地时间）</label
        ><Input
          :id="`${prefix}-completed`"
          v-model="form.completedAt"
          type="datetime-local"
          step="1"
          required
        />
      </div>
      <div class="field">
        <label :for="`${prefix}-integrity`">完整性校验结果</label
        ><select :id="`${prefix}-integrity`" v-model="form.integrity" class="input">
          <option value="unknown">未确认</option>
          <option value="passed">操作者报告通过</option>
          <option value="failed">操作者报告失败</option>
        </select>
      </div>
      <div class="field">
        <label :for="`${prefix}-result`">本次数据验证结果</label
        ><select :id="`${prefix}-result`" v-model="form.result" class="input">
          <option value="incomplete">未完成</option>
          <option value="passed">操作者报告通过</option>
          <option value="failed">操作者报告失败</option>
        </select>
      </div>
      <div class="field record-wide">
        <label :for="`${prefix}-steps`">实际验证步骤</label
        ><Textarea
          :id="`${prefix}-steps`"
          v-model="form.verificationSteps"
          rows="3"
          maxlength="8000"
          placeholder="每行一步，记录实际查询或文件验证结果。"
        />
        <p class="field-hint">
          Redis TTL 记录绝对到期时间或可验证范围，不要求恢复后的剩余秒数与备份前相同。
        </p>
      </div>
      <div class="field record-wide">
        <label :for="`${prefix}-evidence`">证据引用</label
        ><Textarea
          :id="`${prefix}-evidence`"
          v-model="form.evidenceReferences"
          rows="2"
          maxlength="4000"
          placeholder="每行一个脱敏报告或验证清单标签。"
        />
      </div>
    </fieldset>
    <p v-if="!volume.manualDataIdentity" class="field-error mt-5">
      源卷的 PVC 身份尚未确认，暂不能登记数据记录。
    </p>
    <StorageMutationError :error="localError || save.error.value" class="mt-5" />
    <div class="form-footer">
      <p class="meta">保存的是操作者报告。</p>
      <Button
        type="submit"
        :disabled="
          save.isPending.value ||
          auth.restoreMode ||
          !volume.manualDataIdentity ||
          (form.type === 'restore' &&
            (!backup ||
              !target.data.value?.manualDataIdentity ||
              target.data.value.id === volume.id))
        "
        ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
          save.isPending.value ? '正在保存…' : '保存手工记录'
        }}</Button
      >
    </div>
  </form>
</template>
<style scoped>
.record-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
  min-width: 0;
  border: 0;
  padding: 0;
}
.record-wide {
  grid-column: 1 / -1;
}
.source-name {
  font-weight: 550;
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .record-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
