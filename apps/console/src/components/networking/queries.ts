import { api, request } from '@/lib/api';
import type { Envelope, Operation } from '@/lib/types';
import { invalidateCollection, queryClient } from '@/lib/query';

export async function invalidateNetworking(serviceId?: string, domainId?: string) {
  await Promise.all([
    invalidateCollection('/domains'),
    invalidateCollection('/operations'),
    invalidateCollection('/services'),
    queryClient.invalidateQueries({
      queryKey: serviceId ? ['service-networking', serviceId] : ['service-networking'],
    }),
    queryClient.invalidateQueries({
      queryKey: serviceId ? ['service', serviceId] : ['service'],
    }),
    queryClient.invalidateQueries({ queryKey: domainId ? ['domain', domainId] : ['domain'] }),
  ]);
}

export function requestDomainAction(input: {
  domainId: string;
  revision: number;
  action: 'sync' | 'reconcile' | 'production' | 'unbind';
  key: string;
}) {
  const path = `/domains/${input.domainId}`;
  return input.action === 'unbind'
    ? request<Envelope<Operation>>(path, {
        method: 'DELETE',
        body: { revision: input.revision },
        idempotencyKey: input.key,
      }).then((result) => result.data)
    : api.create<Operation>(`${path}/${input.action}`, { revision: input.revision }, input.key);
}
