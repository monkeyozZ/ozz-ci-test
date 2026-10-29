import type { components } from '@ozz/api-client';
type Schema = components['schemas'];
export type Service = Schema['ServiceResponseDto'];
export type Configuration = Schema['ServiceConfigurationDto'];
export type ConfigurationInput = Schema['ServiceConfigurationInputDto'];
export type RuntimeConfiguration = Schema['GitRuntimeConfigurationDto'];
export type RuntimeConfigurationInput = Schema['GitRuntimeConfigurationInputDto'];
export type CreateServiceInput = Schema['CreateServiceDto'];
export type UpdateServiceInput = Schema['UpdateServiceDto'];
export type DeployServiceInput = Schema['DeployServiceDto'];
export type Variable = Schema['ServiceVariableDto'];
export type Probe = Schema['ServiceProbeDto'];
export type Deployment = Schema['DeploymentResponseDto'];
export type DeploymentDetail = Schema['DeploymentDetailDto'];
export type DeploymentLogs = Schema['DeploymentLogsDto'];
export type WorkloadObservation = Schema['WorkloadObservationDto'];
export type Pod = Schema['WorkloadPodDto'];
export type EnvironmentImport = Schema['EnvironmentImportDto'];

export interface VariableDraft {
  rowId: string;
  name: string;
  mode: 'plain' | 'secret' | 'reference';
  value: string;
  secretRefId: string;
  secretKey: string;
}
export interface ServiceDraft {
  name: string;
  slug: string;
  description: string;
  revision: number;
  registryCredentialRefId: string;
  image: string;
  replicas: number;
  commandText: string;
  argsText: string;
  ports: Configuration['ports'];
  resources: Configuration['resources'];
  variables: VariableDraft[];
  readiness: Probe | null;
  startup: Probe | null;
  healthTimeoutSeconds: number;
}
