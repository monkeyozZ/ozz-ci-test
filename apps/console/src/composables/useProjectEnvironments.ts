import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useCollection } from '@/lib/query';
import type { Environment } from '@/lib/types';

export function useProjectEnvironments(
  projectId: MaybeRefOrGetter<string>,
  environmentSlug: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const active = computed(() => !!toValue(projectId) && toValue(enabled));
  const collection = useCollection<Environment>(
    '/environments',
    computed(() => ({ projectId: toValue(projectId) })),
    active,
  );
  const currentEnvironment = computed(() =>
    collection.items.value.find(
      (environment) =>
        environment.projectId === toValue(projectId) &&
        environment.slug === toValue(environmentSlug),
    ),
  );
  const isResolving = computed(
    () =>
      active.value &&
      (collection.isPending.value ||
        (!currentEnvironment.value && !!collection.hasNextPage.value && !collection.error.value)),
  );
  const showEnvironmentControl = computed(
    () =>
      !!collection.error.value ||
      !currentEnvironment.value ||
      !!collection.hasNextPage.value ||
      collection.items.value.length !== 1,
  );

  watch(
    [active, () => toValue(environmentSlug), collection.items, collection.isFetching],
    () => {
      if (
        active.value &&
        toValue(environmentSlug) &&
        !currentEnvironment.value &&
        collection.hasNextPage.value &&
        !collection.isFetching.value &&
        !collection.error.value
      ) {
        void collection.fetchNextPage({ cancelRefetch: false });
      }
    },
    { immediate: true },
  );

  return { ...collection, currentEnvironment, isResolving, showEnvironmentControl };
}
