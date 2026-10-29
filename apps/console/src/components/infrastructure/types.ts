import type { Cluster, Server } from '@/lib/types';
import type { components } from '@ozz/api-client';

// All observation fields come from the API-generated DTOs. These aliases only
// add the registration envelope returned by the paginated Node endpoints.
export type ServerPreflight = NonNullable<Server['preflight']>;
export type ClusterObservation = NonNullable<Cluster['observation']>;
export type ClusterNode = components['schemas']['NodeResponseDto'];
export type ConnectionPreview = components['schemas']['ConnectionPreviewDto'];
