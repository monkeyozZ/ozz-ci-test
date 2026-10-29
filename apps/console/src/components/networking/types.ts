import type { components } from '@ozz/api-client';

type Schema = components['schemas'];

export type PlatformSettings = Schema['PlatformSettingsDto'];
export type ClusterNetworking = Schema['ClusterNetworkingDto'];
export type ServiceNetworking = Schema['ServiceNetworkingDto'];
export type Domain = Schema['DomainDto'];
export type EligibleHttpPort = Schema['EligibleHttpPortDto'];

export type NetworkTone = 'neutral' | 'primary' | 'good' | 'warning' | 'danger';
export interface NetworkStatus {
  label: string;
  tone: NetworkTone;
}
