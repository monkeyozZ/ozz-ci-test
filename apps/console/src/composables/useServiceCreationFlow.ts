import {
  computed,
  nextTick,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useViewScope } from './useViewScope';
import { creationViewKey } from './useCreationDialogState';
import type { CreateServiceInput, Service } from '@/components/services/types';
import {
  clearCreationSecrets,
  creationRequestKeys,
  creationServiceMatches,
  type CreationContext,
  type CreationSource,
} from '@/components/services/creation-state';

type SaveWork = {
  create: () => CreateServiceInput;
  update: (service: Service, remember: (service: Service) => void) => Promise<Service>;
};

/** Own the boundary between a new form and its already-created, recoverable service. */
export function useServiceCreationFlow(
  context: MaybeRefOrGetter<CreationContext | null>,
  source: MaybeRefOrGetter<CreationSource>,
) {
  const route = useRoute();
  const router = useRouter();
  const auth = useAuthStore();
  const mounted = useViewScope();
  const ownViewKey = creationViewKey(route);
  const current = computed(() => creationViewKey(route) === ownViewKey);
  const active = () => mounted() && current.value;
  const queryId = () =>
    typeof route.query.createdService === 'string' ? route.query.createdService : '';
  const hasIdParameter = ref(Object.hasOwn(route.query, 'createdService'));
  const createdId = ref(queryId());
  const verifiedId = ref('');
  const phase = ref<'configure' | 'review'>(createdId.value ? 'review' : 'configure');
  const accepted = shallowRef<Service | null>(null);
  const saving = ref(false);
  const saveError = shallowRef<unknown>(null);
  const uncertain = ref(false);
  const keys = creationRequestKeys();
  let unresolved: { input: CreateServiceInput; key: string } | null = null;
  let routeGeneration = 0;
  const validId = computed(() =>
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(createdId.value),
  );
  const requested = useQuery({
    queryKey: computed(() => ['service', createdId.value]),
    enabled: () => current.value && !!createdId.value && validId.value,
    queryFn: async ({ queryKey, signal }) => {
      const value = await api.get<Service>(`/services/${queryKey[1]}`, signal);
      if (active() && queryKey[1] === createdId.value) verifiedId.value = value.id;
      return value;
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 10_000,
  });
  watch([() => route.query.createdService, current], () => {
    if (!current.value) return;
    // Returning from the source picker resumes this form's accepted service.
    // An absent query ID must never turn a completed save into a second POST.
    if (!Object.hasOwn(route.query, 'createdService') && createdId.value) {
      if (!saving.value)
        void router.replace({
          path: route.path,
          query: { ...route.query, createdService: createdId.value },
        });
      return;
    }
    if (queryId() === createdId.value) return;
    routeGeneration++;
    clearCreationSecrets(unresolved?.input ?? null);
    unresolved = null;
    uncertain.value = false;
    saving.value = false;
    hasIdParameter.value = Object.hasOwn(route.query, 'createdService');
    createdId.value = queryId();
    verifiedId.value = '';
    accepted.value = null;
    phase.value = createdId.value ? 'review' : 'configure';
    saveError.value = null;
  });
  const candidate = computed(() => {
    const fetched = requested.data.value?.id === createdId.value ? requested.data.value : null;
    const saved = accepted.value?.id === createdId.value ? accepted.value : null;
    return saved && (!fetched || saved.revision > fetched.revision) ? saved : fetched;
  });
  const service = computed(() => {
    const target = toValue(context);
    const value = candidate.value;
    return target &&
      value &&
      verifiedId.value === value.id &&
      creationServiceMatches(value, target, toValue(source))
      ? value
      : null;
  });
  const loadError = computed(() => {
    if (hasIdParameter.value && !validId.value)
      return new Error('已保存服务的链接无效，请返回项目。');
    if (createdId.value && requested.error.value) return requested.error.value;
    if (
      candidate.value &&
      verifiedId.value === candidate.value.id &&
      toValue(context) &&
      !service.value
    )
      return new Error('此服务的项目、环境或来源与当前创建流程不一致，请返回项目打开原服务。');
    return null;
  });
  const hasSavedService = computed(() => !!createdId.value || hasIdParameter.value);
  const loading = computed(
    () =>
      hasSavedService.value &&
      validId.value &&
      verifiedId.value !== createdId.value &&
      !requested.error.value,
  );
  const writesLocked = computed(
    () => saving.value || auth.restoreMode || !!service.value?.activeTask,
  );
  const fieldsLocked = computed(() => writesLocked.value || uncertain.value);

  function remember(value: Service, generation = routeGeneration) {
    queryClient.setQueryData(['service', value.id], value);
    if (!active() || generation !== routeGeneration) return;
    accepted.value = value;
    createdId.value = value.id;
    verifiedId.value = value.id;
  }
  async function save(work: SaveWork): Promise<Service | null> {
    if (saving.value || auth.restoreMode || !active() || !toValue(context) || loadError.value)
      return null;
    if (hasSavedService.value && (!service.value || service.value.activeTask)) return null;
    saving.value = true;
    saveError.value = null;
    const target = toValue(context)!;
    const expectedSource = toValue(source);
    const generation = routeGeneration;
    const stillHere = () => active() && generation === routeGeneration;
    try {
      let value: Service;
      if (hasSavedService.value) {
        value = await work.update(service.value!, (saved) => remember(saved, generation));
      } else {
        if (!unresolved) {
          const input = work.create();
          const key = await keys(input);
          if (!stillHere()) {
            clearCreationSecrets(input);
            return null;
          }
          unresolved = { input, key };
        }
        const attempt = unresolved;
        value = await api.create<Service>('/services', attempt.input, attempt.key);
        if (
          !value ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) ||
          !creationServiceMatches(value, target, expectedSource)
        )
          throw new ApiError(0, {
            code: 'RESPONSE_UNCONFIRMED',
            detail: '服务保存结果不完整，请重试确认同一次创建。',
          });
        clearCreationSecrets(attempt.input);
        if (unresolved === attempt) unresolved = null;
        if (stillHere()) uncertain.value = false;
      }
      // Pin the resource before callers invalidate queries, prepare previews or navigate.
      remember(value, generation);
      return stillHere() ? value : null;
    } catch (error) {
      if (!stillHere()) return null;
      saveError.value = error;
      if (!hasSavedService.value && unresolved) {
        uncertain.value = error instanceof ApiError && (error.status === 0 || error.status >= 500);
        if (!uncertain.value) {
          clearCreationSecrets(unresolved.input);
          unresolved = null;
        }
      }
      return null;
    } finally {
      if (stillHere()) saving.value = false;
    }
  }
  async function showReview() {
    if (!active() || !service.value) return;
    phase.value = 'review';
    await router.replace({
      path: route.path,
      query: {
        ...route.query,
        createdService: service.value.id,
        ...(service.value.template ? { version: service.value.template.version } : {}),
        ...(route.params.projectId
          ? {}
          : { projectId: service.value.projectId, environmentId: service.value.environmentId }),
      },
    });
  }
  function edit() {
    if (saving.value || !service.value || service.value.activeTask) return;
    saveError.value = null;
    phase.value = 'configure';
  }
  function submitted(deployment: { id: string }) {
    if (active()) void router.push(`/deployments/${deployment.id}`);
  }

  let composing = false;
  let lastComposition = 0;
  function compositionStart() {
    composing = true;
  }
  function compositionEnd() {
    composing = false;
    lastComposition = Date.now();
  }
  function guardEnter(event: KeyboardEvent) {
    if (
      event.key === 'Enter' &&
      (composing || event.isComposing || event.keyCode === 229 || Date.now() - lastComposition < 80)
    )
      event.preventDefault();
  }
  onScopeDispose(() => {
    clearCreationSecrets(unresolved?.input ?? null);
    unresolved = null;
  });
  return {
    active,
    service,
    hasSavedService,
    loading,
    loadError,
    phase,
    saving,
    saveError,
    uncertain,
    fieldsLocked,
    writesLocked,
    save,
    remember,
    showReview,
    edit,
    submitted,
    refetch: () => (validId.value ? requested.refetch() : Promise.resolve(null)),
    compositionStart,
    compositionEnd,
    guardEnter,
  };
}

export async function revealCreationError(root: HTMLElement | undefined, error: unknown) {
  await nextTick();
  const slugError =
    error instanceof ApiError && /SLUG|ALREADY_EXISTS/.test(error.problem.code ?? '');
  if (
    slugError ||
    (error instanceof ApiError && error.status === 422) ||
    (error instanceof Error && !(error instanceof ApiError))
  ) {
    for (const details of root?.querySelectorAll('details') ?? []) details.open = true;
    await nextTick();
  }
  if (slugError) root?.querySelector<HTMLInputElement>('input[id$="-slug"]')?.focus();
  else root?.querySelector<HTMLElement>('[data-mutation-error]')?.focus();
}
