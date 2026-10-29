import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto } from '../projects/metadata.dto.js';
import { operationStatuses, TaskLogDto } from '../operations/operation.dto.js';
import { ServiceConfigurationDto, ResolvedImageDto } from '../services/configuration.dto.js';
import { WorkloadObservationDto } from '../services/observation.dto.js';
import { ServiceTaskTargetDto, WorkloadRolloutDto } from '../services/execution.dto.js';
import { DeploymentFailureObservationDto } from './failure.dto.js';
import {
  ServiceControllerConfigurationDto,
  ServiceTemplateIdentityDto,
  ServiceVolumeSnapshotDto,
  ServiceDatabaseSnapshotDto,
  ServiceDatabaseBindingSnapshotDto,
} from '../services/data-snapshot.dto.js';
import { DeploymentGitSnapshotDto } from '../git/git.dto.js';
import { BuildDetailDto } from './build.dto.js';

export class DeploymentQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() environmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clusterId?: string;
  @ApiPropertyOptional({ enum: operationStatuses })
  @IsOptional()
  @IsIn(operationStatuses)
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) phase?: string;
}
export class DeploymentTargetDto extends ServiceTaskTargetDto {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
}
export class DeploymentSnapshotDto {
  @ApiProperty({ enum: [1, 2] }) version!: 1 | 2;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty() serviceSlug!: string;
  @ApiProperty() configRevision!: number;
  @ApiProperty({ type: ServiceConfigurationDto }) configuration!: ServiceConfigurationDto;
  @ApiProperty() deployAndStart!: boolean;
  @ApiProperty() allowConfigurationRepair!: boolean;
  @ApiPropertyOptional({ type: ServiceControllerConfigurationDto, description: 'version=2 必有' })
  controller?: ServiceControllerConfigurationDto;
  @ApiPropertyOptional({ type: [ServiceVolumeSnapshotDto], description: 'version=2 必有' })
  volumes?: ServiceVolumeSnapshotDto[];
  @ApiPropertyOptional({
    type: ServiceDatabaseSnapshotDto,
    nullable: true,
    description: 'version=2 必有',
  })
  database?: ServiceDatabaseSnapshotDto | null;
  @ApiPropertyOptional({ type: [ServiceDatabaseBindingSnapshotDto], description: 'version=2 必有' })
  databaseBindings?: ServiceDatabaseBindingSnapshotDto[];
  @ApiPropertyOptional({
    type: ServiceTemplateIdentityDto,
    nullable: true,
    description: 'version=2 必有',
  })
  template?: ServiceTemplateIdentityDto | null;
}
export class DeploymentResultDto {
  @ApiProperty({ enum: [1, 2, 3] }) version!: 1 | 2 | 3;
  @ApiProperty({ type: WorkloadRolloutDto }) published!: WorkloadRolloutDto;
  @ApiProperty({ type: ResolvedImageDto }) image!: ResolvedImageDto;
  @ApiProperty({ type: String, nullable: true }) serviceDns!: string | null;
  @ApiProperty({ format: 'date-time' }) appliedAt!: string;
  @ApiPropertyOptional({ type: WorkloadObservationDto }) observation?: WorkloadObservationDto;
}
export class DeploymentStageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) deploymentId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() attempt!: number;
  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'] })
  status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) finishedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
}
export class DeploymentInputDto {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() mutationRevision!: number;
}
@ApiExtraModels(DeploymentSnapshotDto, DeploymentGitSnapshotDto)
export class DeploymentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['image_deploy', 'git_deploy'] }) kind!: 'image_deploy' | 'git_deploy';
  @ApiProperty({ enum: ['service'] }) scope!: 'service';
  @ApiProperty({ enum: operationStatuses }) status!: string;
  @ApiProperty() phase!: string;
  @ApiProperty({ type: DeploymentInputDto }) input!: DeploymentInputDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serviceId!: string | null;
  @ApiProperty() configRevision!: number;
  @ApiProperty() mutationRevision!: number;
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(DeploymentSnapshotDto) },
      { $ref: getSchemaPath(DeploymentGitSnapshotDto) },
    ],
  })
  snapshot!: DeploymentSnapshotDto | DeploymentGitSnapshotDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) sourceRevisionId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) reuseArtifactId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) artifactId!: string | null;
  @ApiProperty({ enum: ['admin', 'webhook'] }) initiatorKind!: 'admin' | 'webhook';
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) webhookDeliveryId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) webhookTargetId!: string | null;
  @ApiProperty({ type: DeploymentTargetDto }) target!: DeploymentTargetDto;
  @ApiProperty({ type: ResolvedImageDto, nullable: true }) resolvedImage!: ResolvedImageDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) appliedAt!: string | null;
  @ApiProperty({ type: DeploymentResultDto, nullable: true }) result!: DeploymentResultDto | null;
  @ApiProperty({ type: DeploymentFailureObservationDto, nullable: true })
  failureObservation!: DeploymentFailureObservationDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) finishedAt!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) retryOfId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) cancelRequestedAt!:
    string | null;
  @ApiProperty() pollUrl!: string;
}
export class DeploymentDetailDto extends DeploymentResponseDto {
  @ApiProperty({ type: BuildDetailDto, nullable: true }) build!: BuildDetailDto | null;
  @ApiProperty({ type: [DeploymentStageDto] }) stages!: DeploymentStageDto[];
}
export class DeploymentEnvelopeDto {
  @ApiProperty({ type: DeploymentResponseDto }) data!: DeploymentResponseDto;
}
export class DeploymentDetailEnvelopeDto {
  @ApiProperty({ type: DeploymentDetailDto }) data!: DeploymentDetailDto;
}
export class DeploymentListDto {
  @ApiProperty({ type: [DeploymentResponseDto] }) data!: DeploymentResponseDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class DeploymentLogsDto {
  @ApiProperty({ type: [TaskLogDto] }) data!: TaskLogDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
  @ApiProperty({ enum: ['deployment'] }) source!: 'deployment';
  @ApiProperty() available!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['not_started', 'expired', 'not_available'] })
  unavailableReason!: string | null;
  @ApiProperty() truncated!: boolean;
}
