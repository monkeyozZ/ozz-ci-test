import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { api, request } from '@/lib/api';
import type { Envelope } from '@/lib/types';
import type { Service } from '@/components/services/types';
import { invalidateCollection, queryClient } from '@/lib/query';
import type { GitBranch, GitRepository, GitSourceUpdate } from './types';

// GitHub has its own opaque pagination contract; do not add the platform's limit parameter.
function useGithubPages<T>(path: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['github-page', toValue(path)]),
    enabled: computed(() => toValue(enabled)),
    initialPageParam: '',
    queryFn: ({ queryKey, pageParam, signal }) => {
      const suffix = pageParam ? '?cursor=' + encodeURIComponent(pageParam) : '';
      return api.list<T>(String(queryKey[1]) + suffix, signal);
    },
    getNextPageParam: (page) =>
      page.page.hasMore ? (page.page.nextCursor ?? undefined) : undefined,
  });
  const items = computed(() => query.data.value?.pages.flatMap((page) => page.data) ?? []);
  return { ...query, items };
}

export function useGitRepositories(connectionId: MaybeRefOrGetter<string>) {
  return useGithubPages<GitRepository>(
    () => '/integrations/github/' + toValue(connectionId) + '/repositories',
    () => !!toValue(connectionId),
  );
}
export function useGitBranches(
  connectionId: MaybeRefOrGetter<string>,
  repositoryId: MaybeRefOrGetter<string>,
) {
  return useGithubPages<GitBranch>(
    () =>
      '/integrations/github/' +
      toValue(connectionId) +
      '/repositories/' +
      toValue(repositoryId) +
      '/branches',
    () => !!toValue(connectionId) && !!toValue(repositoryId),
  );
}
export async function saveGitSource(serviceId: string, input: GitSourceUpdate) {
  return (
    await request<Envelope<Service>>('/services/' + serviceId + '/git-source', {
      method: 'PUT',
      body: input,
    })
  ).data;
}
export async function invalidateGitService(serviceId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['service', serviceId] }),
    invalidateCollection('/services'),
    invalidateCollection('/deployments'),
    invalidateCollection('/services/' + serviceId + '/pending-commits'),
    invalidateCollection('/webhook-deliveries'),
    queryClient.invalidateQueries({ queryKey: ['webhook-delivery'] }),
  ]);
}
