import type { components, Page as ApiPage, Resource } from '@ozz/api-client';

// The API owns these contracts. Regenerate with `pnpm api:generate` after changing DTOs.
type Schemas = components['schemas'];
export type Page<T> = ApiPage<T>;
export type Envelope<T> = Resource<T>;
export type User = Schemas['AuthUserDto'];
export type Session = Schemas['AuthSessionDto'];
export type Cluster = Schemas['ClusterResponseDto'];
export type Project = Schemas['ProjectResponseDto'];
export type Environment = Schemas['EnvironmentResponseDto'];
export type Server = Schemas['ServerResponseDto'];
export type SecretReference = Schemas['SecretResponseDto'];
export type SecretKind = SecretReference['kind'];
export type Operation = Schemas['OperationDto'];
export type OperationStatus = Operation['status'];
export type OperationLog = Schemas['TaskLogDto'];
export type OperationLogPage = Schemas['OperationLogsDto'];
export type WorkerStatus = Schemas['WorkerStatusDto'];
