import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import type { CreationContext } from '@/components/services/creation-state';
import { useProjectEnvironments } from './useProjectEnvironments';

interface Selection {
  projectId: string;
  environmentId?: string;
  environmentSlug?: string;
  invalid?: boolean;
}

/** Resolve only the requested destination; a missing or invalid environment never falls back. */
export function useServiceCreationContext(selection: MaybeRefOrGetter<Selection>) {
  const selected = computed(() => toValue(selection));
  const invalid = computed(() => !!selected.value.invalid || selected.value.environmentSlug === '');
  const enabled = computed(() => !!selected.value.projectId && !invalid.value);
  const project = useQuery({
    queryKey: computed(() => ['project', selected.value.projectId]),
    enabled,
    queryFn: ({ queryKey, signal }) => api.get<Project>(`/projects/${queryKey[1]}`, signal),
  });
  const environments = useProjectEnvironments(
    () => selected.value.projectId,
    () => selected.value.environmentSlug ?? '',
    enabled,
  );
  const hasSelection = computed(
    () => !!selected.value.environmentId || selected.value.environmentSlug !== undefined,
  );
  const mismatchedPair = computed(() => {
    const { environmentId, environmentSlug } = selected.value;
    const byId = environmentId
      ? environments.items.value.find((item) => item.id === environmentId)
      : null;
    return !!byId && environmentSlug !== undefined && byId.slug !== environmentSlug;
  });
  const environment = computed(() => {
    const { environmentId, environmentSlug } = selected.value;
    if (!environmentId && !environmentSlug) return undefined;
    return environments.items.value.find(
      (item) =>
        (!environmentId || item.id === environmentId) &&
        (!environmentSlug || item.slug === environmentSlug),
    );
  });
  watch(
    [environments.items, environments.hasNextPage, environments.isFetching, selected],
    () => {
      if (
        enabled.value &&
        !!selected.value.environmentId &&
        !environments.items.value.some((item) => item.id === selected.value.environmentId) &&
        !environments.error.value &&
        environments.hasNextPage.value &&
        !environments.isFetching.value
      )
        void environments.fetchNextPage({ cancelRefetch: false });
    },
    { immediate: true },
  );
  const context = computed<CreationContext | null>(() => {
    const value = project.data.value;
    const target = environment.value;
    return value && target && !invalid.value && target.projectId === value.id
      ? { project: value, environment: target }
      : null;
  });
  const pending = computed(
    () =>
      enabled.value &&
      (project.isPending.value ||
        environments.isPending.value ||
        (hasSelection.value &&
          !mismatchedPair.value &&
          !environment.value &&
          environments.hasNextPage.value &&
          !environments.error.value)),
  );
  const error = computed(() => {
    if (invalid.value) return new Error('项目或环境链接无效，请返回项目重新选择。');
    if (project.error.value || environments.error.value)
      return project.error.value || environments.error.value;
    if (enabled.value && hasSelection.value && !pending.value && !context.value)
      return new Error('所选环境不属于当前项目，或已被删除。请返回项目核对。');
    return null;
  });
  const showEnvironment = computed(
    () =>
      !!environments.error.value ||
      !environment.value ||
      environments.items.value.length !== 1 ||
      environments.hasNextPage.value,
  );
  const refetch = () =>
    enabled.value ? Promise.all([project.refetch(), environments.refetch()]) : Promise.resolve([]);
  return { context, pending, error, showEnvironment, refetch };
}
