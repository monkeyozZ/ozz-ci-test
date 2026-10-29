import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { PageQueryDto } from '../../common/pagination.js';
import {
  ServiceOperationInputDto,
  ServiceOperationResultDto,
  ServiceNoRemoteResultDto,
} from '../services/execution.dto.js';
import {
  DomainOperationInputDto,
  DomainOperationResultDto,
  ClusterNetworkingOperationInputDto,
  ClusterNetworkingOperationResultDto,
} from '../networking/execution.dto.js';
import { VolumeOperationInputDto, VolumeOperationResultDto } from '../storage/execution.dto.js';
import {
  WebhookRegistrationInputDto,
  WebhookRegistrationResultDto,
  RegistryProbeInputDto,
  RegistryProbeResultDto,
} from '../integrations/execution.dto.js';

export const operationStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export class DiagnosticRequestDto {
  @ApiPropertyOptional({
    default: 250,
    minimum: 0,
    maximum: 5000,
    description: '无远端副作用的诊断等待时间（毫秒）',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  durationMs?: number;
}

export class DiagnosticInputDto {
  @ApiProperty({ example: 250, minimum: 0, maximum: 5000 }) durationMs!: number;
}

export class OperationQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serverId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clusterId?: string;
  @ApiPropertyOptional({ enum: operationStatuses })
  @IsOptional()
  @IsIn(operationStatuses)
  status?: (typeof operationStatuses)[number];
}

export class InfrastructureInputDto {
  @ApiProperty({ format: 'uuid' }) targetId!: string;
  @ApiProperty({ minimum: 1 }) connectionRevision!: number;
  @ApiPropertyOptional() host?: string;
  @ApiPropertyOptional() port?: number;
  @ApiPropertyOptional() username?: string;
  @ApiPropertyOptional() hostKeyFingerprint?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) expectedMachineId?: string | null;
  @ApiPropertyOptional({ format: 'uuid' }) clusterId?: string;
  @ApiPropertyOptional() clusterConnectionRevision?: number;
  @ApiPropertyOptional({ format: 'uuid' }) installationId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) bootstrapCredentialRefId?: string;
  @ApiPropertyOptional() nodeName?: string;
  @ApiPropertyOptional() apiEndpoint?: string;
  @ApiPropertyOptional({ format: 'uuid' }) candidateCredentialRefId?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) expectedKubeSystemUid?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) expectedCaFingerprint?: string | null;
  @ApiPropertyOptional() acceptedCaFingerprint?: string;
}

export class HostKeyResultDto {
  @ApiProperty({ enum: ['ssh-host-key'] }) check!: 'ssh-host-key';
  @ApiProperty() host!: string;
  @ApiProperty() port!: number;
  @ApiProperty() fingerprint!: string;
  @ApiProperty() algorithm!: string;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
}

export class PreflightResultDto {
  @ApiProperty({ enum: ['server-preflight'] }) check!: 'server-preflight';
  @ApiProperty({ format: 'uuid' }) serverId!: string;
  @ApiProperty({ type: [String] }) blockers!: string[];
  @ApiProperty({ type: [String] }) warnings!: string[];
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
}

export class InitializationResultDto {
  @ApiProperty({ enum: ['server-initialize'] }) check!: 'server-initialize';
  @ApiProperty({ format: 'uuid' }) serverId!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ format: 'uuid' }) installationId!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ enum: ['enabled'] }) secretsEncryption!: 'enabled';
  @ApiProperty() resumed!: boolean;
}

export class ClusterOperationResultDto {
  @ApiProperty({ enum: ['cluster-connect', 'cluster-sync'] }) check!:
    'cluster-connect' | 'cluster-sync';
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ minimum: 0 }) nodeCount!: number;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
}

export class OperationLogQueryDto {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 100;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class DiagnosticResultDto {
  @ApiProperty({ enum: ['database-roundtrip'] }) check!: string;
  @ApiProperty({ enum: ['ok'] }) database!: string;
  @ApiProperty({ format: 'uuid' }) operationId!: string;
  @ApiProperty({ format: 'date-time' }) completedAt!: string;
}

@ApiExtraModels(
  DiagnosticInputDto,
  InfrastructureInputDto,
  DiagnosticResultDto,
  HostKeyResultDto,
  PreflightResultDto,
  InitializationResultDto,
  ClusterOperationResultDto,
  ServiceOperationInputDto,
  ServiceOperationResultDto,
  ServiceNoRemoteResultDto,
  DomainOperationInputDto,
  DomainOperationResultDto,
  ClusterNetworkingOperationInputDto,
  ClusterNetworkingOperationResultDto,
  VolumeOperationInputDto,
  VolumeOperationResultDto,
  WebhookRegistrationInputDto,
  WebhookRegistrationResultDto,
  RegistryProbeInputDto,
  RegistryProbeResultDto,
)
export class OperationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    enum: [
      'diagnostic',
      'ssh_discover',
      'server_preflight',
      'server_initialize',
      'cluster_connect',
      'cluster_sync',
      'service_restart',
      'service_stop',
      'service_resume',
      'service_delete',
      'domain_bind',
      'domain_sync',
      'domain_reconcile',
      'domain_unbind',
      'domain_production',
      'cluster_network_check',
      'cluster_cert_manager_install',
      'volume_create',
      'volume_sync',
      'volume_destroy',
      'volume_maintenance_enter',
      'volume_maintenance_exit',
      'github_webhook_register',
      'registry_validate',
    ],
  })
  kind!: string;
  @ApiProperty({ enum: ['control_plane', 'server', 'cluster', 'service', 'volume', 'integration'] })
  scope!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serverId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) clusterId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serviceId!: string | null;
  @ApiProperty({ enum: operationStatuses }) status!: string;
  @ApiProperty({
    oneOf: [
      DiagnosticInputDto,
      InfrastructureInputDto,
      ServiceOperationInputDto,
      DomainOperationInputDto,
      ClusterNetworkingOperationInputDto,
      VolumeOperationInputDto,
      WebhookRegistrationInputDto,
      RegistryProbeInputDto,
    ].map((type) => ({
      $ref: getSchemaPath(type),
    })),
  })
  input!:
    | DiagnosticInputDto
    | InfrastructureInputDto
    | ServiceOperationInputDto
    | DomainOperationInputDto
    | ClusterNetworkingOperationInputDto
    | VolumeOperationInputDto
    | WebhookRegistrationInputDto
    | RegistryProbeInputDto;
  @ApiProperty({
    nullable: true,
    oneOf: [
      DiagnosticResultDto,
      HostKeyResultDto,
      PreflightResultDto,
      InitializationResultDto,
      ClusterOperationResultDto,
      ServiceOperationResultDto,
      ServiceNoRemoteResultDto,
      DomainOperationResultDto,
      ClusterNetworkingOperationResultDto,
      VolumeOperationResultDto,
      WebhookRegistrationResultDto,
      RegistryProbeResultDto,
    ].map((type) => ({ $ref: getSchemaPath(type) })),
  })
  result!:
    | DiagnosticResultDto
    | HostKeyResultDto
    | PreflightResultDto
    | InitializationResultDto
    | ClusterOperationResultDto
    | ServiceOperationResultDto
    | ServiceNoRemoteResultDto
    | DomainOperationResultDto
    | ClusterNetworkingOperationResultDto
    | VolumeOperationResultDto
    | WebhookRegistrationResultDto
    | RegistryProbeResultDto
    | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) finishedAt!: string | null;
  @ApiProperty({ minimum: 0 }) attempts!: number;
  @ApiProperty({ minimum: 1 }) maxAttempts!: number;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) retryOfId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) cancelRequestedAt!:
    string | null;
  @ApiProperty({ example: '/api/operations/operation-id' }) pollUrl!: string;
}

export class OperationPageDto {
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class OperationEnvelopeDto {
  @ApiProperty({ type: OperationDto }) data!: OperationDto;
}

export class OperationListDto {
  @ApiProperty({ type: [OperationDto] }) data!: OperationDto[];
  @ApiProperty({ type: OperationPageDto }) page!: OperationPageDto;
}

export class TaskLogDto {
  @ApiProperty({ minimum: 1 }) sequence!: number;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
  @ApiProperty({ enum: ['info', 'warn', 'error'] }) level!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ minimum: 0 }) attempt!: number;
  @ApiPropertyOptional() code?: string;
}

export class OperationLogsDto {
  @ApiProperty({ type: [TaskLogDto] }) data!: TaskLogDto[];
  @ApiProperty({ type: OperationPageDto }) page!: OperationPageDto;
  @ApiProperty({ enum: ['operation'] }) source!: string;
  @ApiProperty() available!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['not_started', 'expired', 'not_available'] })
  unavailableReason!: string | null;
  @ApiProperty() truncated!: boolean;
}

export class WorkerHeartbeatDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
  @ApiProperty() queueConnected!: boolean;
  @ApiProperty() recoveryMode!: boolean;
  @ApiProperty({ minimum: 0 }) activeOperations!: number;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty() stale!: boolean;
}

export class WorkerStatusDto {
  @ApiProperty({ enum: ['ready', 'degraded', 'offline', 'paused'] }) status!: string;
  @ApiProperty() restoreLocked!: boolean;
  @ApiProperty({ enum: ['connected', 'disconnected', 'unknown'] }) queue!: string;
  @ApiProperty({ minimum: 0 }) queuedCount!: number;
  @ApiProperty({ minimum: 0 }) unpublishedCount!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) oldestQueuedAt!:
    string | null;
  @ApiProperty({ type: [WorkerHeartbeatDto] }) workers!: WorkerHeartbeatDto[];
}

export class WorkerStatusEnvelopeDto {
  @ApiProperty({ type: WorkerStatusDto }) data!: WorkerStatusDto;
}
