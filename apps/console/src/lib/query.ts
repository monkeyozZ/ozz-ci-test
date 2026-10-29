import { QueryClient, useInfiniteQuery } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { api, ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: (count, error) =>
        count < 1 && (!(error instanceof ApiError) || error.status >= 500 || error.status === 0),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

export function useCollection<T>(
  resource: MaybeRefOrGetter<string>,
  params?: MaybeRefOrGetter<Record<string, string>>,
  enabled: MaybeRefOrGetter<boolean> = true,
  options: { refetchInterval?: number | false } = {},
) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['collection', toValue(resource), toValue(params) ?? {}]),
    enabled: computed(() => toValue(enabled)),
    refetchInterval: options.refetchInterval ?? false,
    initialPageParam: '' as string,
    queryFn: ({ pageParam, signal }) => {
      const search = new URLSearchParams({ limit: '50', ...toValue(params) });
      if (pageParam) search.set('cursor', pageParam);
      return api.list<T>(`${toValue(resource)}?${search}`, signal);
    },
    getNextPageParam: (last) =>
      last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined,
  });
  const items = computed(() => query.data.value?.pages.flatMap((page) => page.data) ?? []);
  return { ...query, items };
}

export function invalidateCollection(resource: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['collection', resource] }),
    ...(resource === '/projects'
      ? [
          queryClient.invalidateQueries({ queryKey: ['collection', '/clusters'] }),
          queryClient.invalidateQueries({ queryKey: ['cluster'] }),
        ]
      : []),
  ]);
}
