import { computed, nextTick, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from 'vue-router';
import { useViewScope } from './useViewScope';

type Filters = { search: string; target: string };
type Position = { left: number; top: number };
let remembered: { owner: string; filters: Filters; position: Position } | undefined;
const requestedScroll = shallowRef<{ fullPath: string; position: Position } | null>(null);

function filters(query: LocationQuery): Filters {
  return {
    search: typeof query.search === 'string' ? query.search : '',
    target: typeof query.target === 'string' ? query.target : '',
  };
}

/** Only non-secret list context is retained, in memory and the list URL. */
export function rememberProjectListContext(query: LocationQuery, owner: string) {
  remembered = {
    owner,
    filters: filters(query),
    position: { left: window.scrollX, top: window.scrollY },
  };
}

export function projectListReturnQuery(
  query: LocationQuery,
  owner: string,
): LocationQueryRaw | null {
  if (
    !remembered ||
    remembered.owner !== owner ||
    Object.hasOwn(query, 'search') ||
    Object.hasOwn(query, 'target') ||
    (!remembered.filters.search && !remembered.filters.target)
  )
    return null;
  return {
    ...query,
    search: remembered.filters.search || undefined,
    target: remembered.filters.target || undefined,
  };
}

export function requestProjectListScroll(
  fullPath: string,
  query: LocationQuery,
  owner: string,
  saved?: Position | null,
) {
  const current = filters(query);
  const matches =
    remembered?.owner === owner &&
    remembered.filters.search === current.search &&
    remembered.filters.target === current.target;
  requestedScroll.value = {
    fullPath,
    position: saved ?? (matches ? remembered!.position : { left: 0, top: 0 }),
  };
}

export function useProjectListContext(ready: MaybeRefOrGetter<boolean>) {
  const route = useRoute();
  const router = useRouter();
  const active = useViewScope();
  function setFilter(name: keyof Filters, value: string) {
    void router.replace({
      path: route.path,
      query: { ...route.query, [name]: value || undefined },
    });
  }
  const search = computed({
    get: () => filters(route.query).search,
    set: (value: string) => setFilter('search', value),
  });
  const target = computed({
    get: () => filters(route.query).target,
    set: (value: string) => setFilter('target', value),
  });
  function clearFilters() {
    void router.replace({
      path: route.path,
      query: { ...route.query, search: undefined, target: undefined },
    });
  }
  watch(
    [requestedScroll, () => toValue(ready), () => route.fullPath],
    async ([request, loaded]) => {
      if (!request || !loaded || request.fullPath !== route.fullPath) return;
      await nextTick();
      if (!active() || requestedScroll.value !== request || route.fullPath !== request.fullPath)
        return;
      window.scrollTo(request.position);
      requestedScroll.value = null;
    },
    { immediate: true, flush: 'post' },
  );
  return { search, target, clearFilters };
}
