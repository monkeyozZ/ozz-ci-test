import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PageQueryDto } from '../../common/pagination.js';
import {
  PageInfoDto,
  RenameResourceDto,
  RevisionDto,
  SlugResourceDto,
  trimText,
} from '../projects/metadata.dto.js';
import {
  ServiceConfigurationDto,
  ServiceConfigurationInputDto,
  ResolvedImageDto,
  GitRuntimeConfigurationDto,
  GitRuntimeConfigurationInputDto,
} from './configuration.dto.js';
import { WorkloadObservationDto } from './observation.dto.js';
import { TemplateSelectionDto } from '../templates/template.dto.js';
import {
  ServiceControllerConfigurationDto,
  ServiceTemplateIdentityDto,
} from './data-snapshot.dto.js';
import {
  ImageSourceDto,
  GitSourceInputDto,
  GitSourceDto,
  GitSourceSnapshotDto,
} from '../git/git.dto.js';

@ApiExtraModels(
  ImageSourceDto,
  GitSourceInputDto,
  ServiceConfigurationInputDto,
  GitRuntimeConfigurationInputDto,
)
export class CreateServiceDto extends SlugResourceDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() environmentId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  registryCredentialRefId?: string | null;
  @ApiPropertyOptional({
    oneOf: [
      { $ref: getSchemaPath(ServiceConfigurationInputDto) },
      { $ref: getSchemaPath(GitRuntimeConfigurationInputDto) },
    ],
    description: '与 template 二选一；Git 运行配置不允许 image',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type((options) =>
    options?.object?.source?.kind === 'github'
      ? GitRuntimeConfigurationInputDto
      : ServiceConfigurationInputDto,
  )
  configuration?: ServiceConfigurationInputDto | GitRuntimeConfigurationInputDto;
  @ApiPropertyOptional({
    oneOf: [{ $ref: getSchemaPath(ImageSourceDto) }, { $ref: getSchemaPath(GitSourceInputDto) }],
    discriminator: {
      propertyName: 'kind',
      mapping: { image: getSchemaPath(ImageSourceDto), github: getSchemaPath(GitSourceInputDto) },
    },
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ImageSourceDto, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { name: 'image', value: ImageSourceDto },
        { name: 'github', value: GitSourceInputDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  source?: ImageSourceDto | GitSourceInputDto;
  @ApiPropertyOptional({
    type: TemplateSelectionDto,
    description: '与 configuration 二选一；模板创建需要 Idempotency-Key',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TemplateSelectionDto)
  template?: TemplateSelectionDto;
}
@ApiExtraModels(ServiceConfigurationInputDto, GitRuntimeConfigurationInputDto)
export class UpdateServiceDto extends RenameResourceDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() environmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  registryCredentialRefId?: string | null;
  @ApiPropertyOptional({
    oneOf: [
      { $ref: getSchemaPath(ServiceConfigurationInputDto) },
      { $ref: getSchemaPath(GitRuntimeConfigurationInputDto) },
    ],
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type((options) =>
    options?.object?.configuration &&
    typeof options.object.configuration === 'object' &&
    'image' in options.object.configuration
      ? ServiceConfigurationInputDto
      : GitRuntimeConfigurationInputDto,
  )
  configuration?: ServiceConfigurationInputDto | GitRuntimeConfigurationInputDto;
}
export class DeployServiceDto extends RevisionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Git 发布必填；消费已审阅的固定commit和完整快照',
  })
  @IsOptional()
  @IsUUID()
  // An absent Git-only field must not become an own undefined key on image/retry requests.
  declare previewId?: string;
  @ApiPropertyOptional({ description: '明确发布并启动已停止服务' })
  @IsOptional()
  @IsBoolean()
  deployAndStart?: boolean;
  @ApiPropertyOptional({ description: '明确用完整快照修复部分应用或配置漂移' })
  @IsOptional()
  @IsBoolean()
  allowConfigurationRepair?: boolean;
}
export class ServiceQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() environmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clusterId?: string;
}
export class ParseEnvironmentDto {
  @ApiProperty({ maxLength: 24576, writeOnly: true }) @IsString() @MaxLength(24576) text!: string;
}
export class ImportedEnvironmentVariableDto {
  @ApiProperty() name!: string;
  @ApiProperty() value!: string;
  @ApiProperty() secret!: boolean;
  @ApiProperty() line!: number;
}
export class EnvironmentImportIssueDto {
  @ApiProperty() line!: number;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}
export class EnvironmentImportDto {
  @ApiProperty({ type: [ImportedEnvironmentVariableDto] })
  variables!: ImportedEnvironmentVariableDto[];
  @ApiProperty({ type: [EnvironmentImportIssueDto] }) issues!: EnvironmentImportIssueDto[];
}
export class EnvironmentImportEnvelopeDto {
  @ApiProperty({ type: EnvironmentImportDto }) data!: EnvironmentImportDto;
}

export class ServiceContextDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}
export class ServiceClusterContextDto extends ServiceContextDto {
  @ApiProperty({ enum: ['unverified', 'connected', 'unreachable', 'unknown'] })
  connectionStatus!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastObservedAt!:
    string | null;
}
export class ServiceActiveTaskDto {
  @ApiProperty({ enum: ['operation', 'deployment'] }) type!: 'operation' | 'deployment';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }) status!: string;
  @ApiProperty() kind!: string;
}
@ApiExtraModels(
  ServiceConfigurationDto,
  GitRuntimeConfigurationDto,
  ImageSourceDto,
  GitSourceSnapshotDto,
)
export class ServicePublishedDto {
  @ApiProperty({ format: 'uuid' }) deploymentId!: string;
  @ApiProperty() configRevision!: number;
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(ServiceConfigurationDto) },
      { $ref: getSchemaPath(GitRuntimeConfigurationDto) },
    ],
  })
  configuration!: ServiceConfigurationDto | GitRuntimeConfigurationDto;
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(ImageSourceDto) }, { $ref: getSchemaPath(GitSourceSnapshotDto) }],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        image: getSchemaPath(ImageSourceDto),
        github: getSchemaPath(GitSourceSnapshotDto),
      },
    },
  })
  source!: ImageSourceDto | GitSourceSnapshotDto;
  @ApiProperty({ type: ResolvedImageDto, nullable: true }) image!: ResolvedImageDto | null;
  @ApiProperty({ format: 'date-time' }) appliedAt!: string;
}
@ApiExtraModels(ServiceConfigurationDto, GitRuntimeConfigurationDto, ImageSourceDto, GitSourceDto)
export class ServiceResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty() kind!: string;
  @ApiProperty({ type: ServiceControllerConfigurationDto })
  controller!: ServiceControllerConfigurationDto;
  @ApiProperty({ type: ServiceTemplateIdentityDto, nullable: true })
  template!: ServiceTemplateIdentityDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) databaseInstanceId!: string | null;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ type: ServiceContextDto }) project!: ServiceContextDto;
  @ApiProperty({ type: ServiceContextDto }) environment!: ServiceContextDto;
  @ApiProperty({ type: ServiceClusterContextDto }) cluster!: ServiceClusterContextDto;
  @ApiProperty() revision!: number;
  @ApiProperty() configRevision!: number;
  @ApiProperty() mutationRevision!: number;
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(ServiceConfigurationDto) },
      { $ref: getSchemaPath(GitRuntimeConfigurationDto) },
    ],
  })
  configuration!: ServiceConfigurationDto | GitRuntimeConfigurationDto;
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(ImageSourceDto) }, { $ref: getSchemaPath(GitSourceDto) }],
    discriminator: {
      propertyName: 'kind',
      mapping: { image: getSchemaPath(ImageSourceDto), github: getSchemaPath(GitSourceDto) },
    },
  })
  source!: ImageSourceDto | GitSourceDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) registryCredentialRefId!:
    string | null;
  @ApiProperty({ enum: ['running', 'stopped'] }) desiredState!: 'running' | 'stopped';
  @ApiProperty({ enum: ['unpublished', 'consistent', 'partial', 'drifted', 'unknown'] })
  configurationState!: 'unpublished' | 'consistent' | 'partial' | 'drifted' | 'unknown';
  @ApiProperty({
    enum: ['unpublished', 'running', 'pending', 'stopped', 'degraded', 'missing', 'unknown'],
  })
  runtimeState!:
    'unpublished' | 'running' | 'pending' | 'stopped' | 'degraded' | 'missing' | 'unknown';
  @ApiProperty() hasUnpublishedChanges!: boolean;
  @ApiProperty({ type: ServicePublishedDto, nullable: true })
  published!: ServicePublishedDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) lastSuccessfulDeploymentId!:
    string | null;
  @ApiProperty({ type: ServiceActiveTaskDto, nullable: true })
  activeTask!: ServiceActiveTaskDto | null;
  @ApiProperty({ type: WorkloadObservationDto, nullable: true })
  observation!: WorkloadObservationDto | null;
  @ApiProperty() observationStale!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) remoteCreatedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastObservedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorMessage!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class ServiceEnvelopeDto {
  @ApiProperty({ type: ServiceResponseDto }) data!: ServiceResponseDto;
}
export class ServiceListDto {
  @ApiProperty({ type: [ServiceResponseDto] }) data!: ServiceResponseDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
