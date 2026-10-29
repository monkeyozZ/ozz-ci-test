import {
  computed,
  onScopeDispose,
  reactive,
  toValue,
  watch,
  type InjectionKey,
  type MaybeRefOrGetter,
} from 'vue';
import type { LocationQuery, LocationQueryRaw, RouteLocationNormalizedLoaded } from 'vue-router';

export const CREATION_DIALOG: InjectionKey<boolean> = Symbol('creation-dialog');
export const CREATION_SCOPE = 'service-creation';
const pending = reactive(new Set<symbol>());
const uncertain = reactive(new Set<symbol>());
export const creationBusy = computed(() => pending.size > 0);
export const creationUncertain = computed(() => uncertain.size > 0);
export const creationNavigationLocked = computed(
  () => creationBusy.value || creationUncertain.value,
);

export function useCreationBusy(
  value: MaybeRefOrGetter<boolean>,
  unresolved: MaybeRefOrGetter<boolean> = false,
) {
  const key = Symbol('creation-request');
  watch(
    () => toValue(value),
    (busy) => {
      if (busy) pending.add(key);
      else pending.delete(key);
    },
    { immediate: true, flush: 'sync' },
  );
  watch(
    () => toValue(unresolved),
    (unknown) => {
      if (unknown) uncertain.add(key);
      else uncertain.delete(key);
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    pending.delete(key);
    uncertain.delete(key);
  });
}

/** Saving an ID updates the URL without replacing the source's cached form. */
export function creationViewKey(route: RouteLocationNormalizedLoaded) {
  return JSON.stringify([
    route.path,
    route.query.environment ?? (route.params.projectId ? 'production' : ''),
    route.query.source ?? '',
    route.query.category ?? '',
    route.params.templateId ?? route.query.template ?? '',
    route.query.version ?? '',
  ]);
}

export function creationStepQuery(
  query: LocationQuery,
  next: LocationQueryRaw = {},
): LocationQueryRaw {
  return {
    ...query,
    source: undefined,
    category: undefined,
    template: undefined,
    version: undefined,
    createdService: undefined,
    createService: '1',
    ...next,
  };
}

export function withoutCreationQuery(query: LocationQuery): LocationQueryRaw {
  const result: LocationQueryRaw = { ...query };
  for (const key of [
    'createService',
    'source',
    'category',
    'template',
    'version',
    'createdService',
    'first',
    'fromService',
    'environmentId',
  ])
    delete result[key];
  return result;
}
