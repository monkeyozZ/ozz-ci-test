import { api, request } from '@/lib/api';
import { invalidateCollection, queryClient } from '@/lib/query';
import type { Envelope, Operation } from '@/lib/types';
import type {
  CreateVolumeInput,
  VolumeCreateResult,
  VolumeMountCollection,
  SaveVolumeMountInput,
  DatabaseBindingInput,
  DatabaseBindingCollection,
  DatabaseBindingPreview,
  VolumeDeletionConfirmation,
} from './types';

export async function invalidateStorage(serviceId?: string, volumeId?: string) {
  await Promise.all([
    ...['/volumes', '/databases', '/services', '/operations'].map(invalidateCollection),
    queryClient.invalidateQueries({ queryKey: volumeId ? ['volume', volumeId] : ['volume'] }),
    queryClient.invalidateQueries({ queryKey: ['database'] }),
    queryClient.invalidateQueries({ queryKey: serviceId ? ['service', serviceId] : ['service'] }),
    queryClient.invalidateQueries({
      queryKey: serviceId ? ['service-volume-mounts', serviceId] : ['service-volume-mounts'],
    }),
    queryClient.invalidateQueries({
      queryKey: serviceId
        ? ['service-database-bindings', serviceId]
        : ['service-database-bindings'],
    }),
  ]);
}

export const createVolume = (body: CreateVolumeInput, key: string) =>
  api.create<VolumeCreateResult>('/volumes', body, key);
export const volumeMounts = (serviceId: string, signal?: AbortSignal) =>
  request<VolumeMountCollection>(`/services/${serviceId}/volume-mounts`, { signal });
export const saveVolumeMount = (serviceId: string, body: SaveVolumeMountInput) =>
  request<VolumeMountCollection>(`/services/${serviceId}/volume-mounts`, { method: 'POST', body });
export const detachVolumeMount = (serviceId: string, mountId: string, revision: number) =>
  request<VolumeMountCollection>(`/services/${serviceId}/volume-mounts/${mountId}`, {
    method: 'DELETE',
    body: { revision },
  });
export const databaseBindings = (serviceId: string, signal?: AbortSignal) =>
  request<DatabaseBindingCollection>(`/services/${serviceId}/database-bindings`, { signal });
export const previewDatabaseBinding = (serviceId: string, body: DatabaseBindingInput) =>
  api.create<DatabaseBindingPreview>(`/services/${serviceId}/database-bindings/preview`, body);
export const saveDatabaseBinding = (serviceId: string, body: DatabaseBindingInput) =>
  request<DatabaseBindingCollection>(`/services/${serviceId}/database-bindings`, {
    method: 'POST',
    body,
  });
export const detachDatabaseBinding = (serviceId: string, bindingId: string, revision: number) =>
  request<DatabaseBindingCollection>(`/services/${serviceId}/database-bindings/${bindingId}`, {
    method: 'DELETE',
    body: { revision },
  });
export async function volumeAction(input: {
  volumeId: string;
  revision: number;
  action: 'sync' | 'maintenance/enter' | 'maintenance/exit' | 'destroy';
  key: string;
  purpose?: 'backup' | 'restore';
  maintenanceId?: string;
  confirmation?: VolumeDeletionConfirmation;
}) {
  const body = {
    revision: input.revision,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.maintenanceId ? { maintenanceId: input.maintenanceId } : {}),
    ...(input.confirmation ? { confirmation: input.confirmation } : {}),
  };
  if (input.action === 'destroy')
    return (
      await request<Envelope<Operation>>(`/volumes/${input.volumeId}`, {
        method: 'DELETE',
        body,
        idempotencyKey: input.key,
      })
    ).data;
  return api.create<Operation>(`/volumes/${input.volumeId}/${input.action}`, body, input.key);
}
