import type { Environment, Project } from '@/lib/types';
import type { CreateServiceInput, Service } from './types';

export type CreationContext = { project: Project; environment: Environment };
export type CreationSource =
  { kind: 'image' | 'github' } | { kind: 'template'; id: string; version?: string };

export function creationServiceMatches(
  service: Service,
  context: CreationContext,
  source: CreationSource,
) {
  if (
    service.projectId !== context.project.id ||
    service.project?.id !== context.project.id ||
    service.environmentId !== context.environment.id ||
    service.environment?.id !== context.environment.id ||
    service.environment?.slug !== context.environment.slug ||
    service.clusterId !== context.project.clusterId ||
    service.cluster?.id !== context.project.clusterId
  )
    return false;
  if (source.kind === 'template')
    return (
      service.template?.id === source.id &&
      (service.source?.kind ?? 'image') === 'image' &&
      (!source.version || service.template.version === source.version)
    );
  return !service.template && (service.source?.kind ?? 'image') === source.kind;
}

/** Keep keys, rather than plaintext request bodies, for earlier form revisions. */
export function creationRequestKeys() {
  const keys = new Map<string, string>();
  return async (input: CreateServiceInput) => {
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    bytes.fill(0);
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (!keys.has(fingerprint)) keys.set(fingerprint, crypto.randomUUID());
    return keys.get(fingerprint)!;
  };
}

export function clearCreationSecrets(input: CreateServiceInput | null) {
  for (const variable of input?.configuration?.environment ?? []) {
    if ('secret' in variable && variable.secret && 'value' in variable) variable.value = '';
  }
}
