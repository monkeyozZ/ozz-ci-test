import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type {
  DatabaseView,
  DatabaseBindingView,
  DatabaseBindingInput,
  DatabaseBindingPreview,
  DatabaseBindingCollection,
  DatabaseOutputKey,
  DatabaseOutputMapping,
  DataIssue,
  ServiceDeletionPreview,
} from '@ozz/control-plane/databases';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto, ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';

export class DataIssueDto implements DataIssue {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ type: String, nullable: true }) field!: string | null;
  @ApiProperty({ enum: ['save', 'deploy', 'both', 'none'] }) blocks!: DataIssue['blocks'];
}
export class DatabaseServiceIdentityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}
export class DatabaseTemplateIdentityDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: string;
}
export class DatabaseVolumeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty() pvcName!: string;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
  @ApiProperty({ type: String }) requestedBytes!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) destroyedAt!: string | null;
}
export class DatabaseProtectionDto {
  @ApiProperty() active!: boolean;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) fencedAt!: string | null;
  @ApiProperty({ type: [String] }) lockedFields!: string[];
  @ApiProperty() reason!: string;
}
export class DatabaseInitializationDto {
  @ApiProperty() state!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) initializedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
}
export class DatabaseCredentialReferenceDto {
  @ApiProperty({ format: 'uuid' }) refId!: string;
  @ApiProperty() contentRevision!: number;
}
export class DatabaseConnectionDto {
  @ApiProperty({ type: String, nullable: true }) host!: string | null;
  @ApiProperty() port!: number;
  @ApiProperty() username!: string;
  @ApiProperty({ type: String, nullable: true }) database!: string | null;
  @ApiProperty({ type: Number, nullable: true }) redisDatabase!: number | null;
  @ApiProperty({ enum: ['cluster_private'] }) visibility!: 'cluster_private';
}
export class DatabaseAuthenticationObservationDto {
  @ApiProperty({ enum: ['ready', 'failed', 'unknown'] }) state!: 'ready' | 'failed' | 'unknown';
  @ApiProperty() authenticated!: boolean;
  @ApiProperty({ type: String, nullable: true }) engineVersion!: string | null;
  @ApiProperty({ enum: ['postgres_wal', 'redis_aof_everysec', 'unknown'] }) persistence!:
    'postgres_wal' | 'redis_aof_everysec' | 'unknown';
  @ApiProperty({ type: String, nullable: true }) podUid!: string | null;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty({ type: String, nullable: true }) message!: string | null;
}
export class DatabaseConsumerDto {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() desired!: boolean;
  @ApiProperty() published!: boolean;
  @ApiProperty() inFlight!: boolean;
}
export class DatabaseDto implements DatabaseView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['postgresql', 'redis'] }) engine!: DatabaseView['engine'];
  @ApiProperty() majorVersion!: number;
  @ApiProperty() exactVersion!: string;
  @ApiProperty({ type: DatabaseTemplateIdentityDto }) template!: DatabaseTemplateIdentityDto;
  @ApiProperty({ type: DatabaseServiceIdentityDto, nullable: true })
  service!: DatabaseServiceIdentityDto | null;
  @ApiProperty({ type: DatabaseServiceIdentityDto }) originalService!: DatabaseServiceIdentityDto;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ type: DatabaseVolumeDto }) dataVolume!: DatabaseVolumeDto;
  @ApiProperty({ type: DatabaseProtectionDto }) protection!: DatabaseProtectionDto;
  @ApiProperty({ type: DatabaseInitializationDto }) initialization!: DatabaseInitializationDto;
  @ApiProperty({ type: DatabaseCredentialReferenceDto })
  credential!: DatabaseCredentialReferenceDto;
  @ApiProperty({ type: DatabaseConnectionDto }) connection!: DatabaseConnectionDto;
  @ApiProperty() databaseReady!: boolean;
  @ApiProperty({ type: DatabaseAuthenticationObservationDto, nullable: true })
  observation!: DatabaseAuthenticationObservationDto | null;
  @ApiProperty() observationStale!: boolean;
  @ApiProperty({ type: [DatabaseConsumerDto] }) consumers!: DatabaseConsumerDto[];
  @ApiProperty() consumersTruncated!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class DatabaseQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 }) override limit = 50;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() environmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clusterId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serviceId?: string;
}
const variableNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export class DatabaseOutputMappingDto implements DatabaseOutputMapping {
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  host?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  port?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  database?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  user?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  password?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  db?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(variableNamePattern)
  url?: string;
}
export class DatabaseBindingInputDto extends RevisionDto implements DatabaseBindingInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() databaseInstanceId!: string;
  @ApiProperty({ enum: ['fields', 'url'] }) @IsIn(['fields', 'url']) profile!: 'fields' | 'url';
  @ApiProperty({ type: DatabaseOutputMappingDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DatabaseOutputMappingDto)
  mapping!: DatabaseOutputMappingDto;
}
export class DatabaseBindingProviderDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) serviceId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['postgresql', 'redis'] }) engine!: 'postgresql' | 'redis';
  @ApiProperty() ready!: boolean;
}
export class DatabaseBindingDto implements DatabaseBindingView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) databaseInstanceId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['fields', 'url'] }) profile!: 'fields' | 'url';
  @ApiProperty({ type: DatabaseOutputMappingDto }) mapping!: DatabaseOutputMappingDto;
  @ApiProperty() desired!: boolean;
  @ApiProperty({ type: DatabaseBindingProviderDto }) provider!: DatabaseBindingProviderDto;
  @ApiProperty() published!: boolean;
  @ApiProperty({ type: [DataIssueDto] }) issues!: DataIssueDto[];
}
export class DatabaseBindingCollectionDto implements DatabaseBindingCollection {
  @ApiProperty({ type: [DatabaseBindingDto], maxItems: 16 }) data!: DatabaseBindingDto[];
  @ApiProperty() serviceRevision!: number;
  @ApiProperty() configRevision!: number;
}
export class DatabaseBindingVariableDto {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['host', 'port', 'database', 'user', 'password', 'db', 'url'] })
  output!: DatabaseOutputKey;
  @ApiProperty() secret!: boolean;
  @ApiProperty({ enum: ['add', 'replace'] }) change!: 'add' | 'replace';
}
export class DatabaseBindingPreviewDto implements DatabaseBindingPreview {
  @ApiProperty({ format: 'uuid' }) databaseInstanceId!: string;
  @ApiProperty({ enum: ['fields', 'url'] }) profile!: 'fields' | 'url';
  @ApiProperty({ type: DatabaseOutputMappingDto }) mapping!: DatabaseOutputMappingDto;
  @ApiProperty({ type: [DatabaseBindingVariableDto] }) variables!: DatabaseBindingVariableDto[];
  @ApiProperty({ type: [DataIssueDto] }) issues!: DataIssueDto[];
  @ApiProperty() serviceRevision!: number;
}
export class DatabaseBindingParamsDto extends ResourceParamsDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bindingId!: string;
}
export class ServiceRetainedVolumeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) databaseInstanceId!: string | null;
}
export class ServiceDeletionPreviewDto implements ServiceDeletionPreview {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: [ServiceRetainedVolumeDto] }) retainedVolumes!: ServiceRetainedVolumeDto[];
  @ApiProperty({ type: [DatabaseConsumerDto] }) databaseConsumers!: DatabaseConsumerDto[];
  @ApiProperty({ type: [DataIssueDto] }) blockers!: DataIssueDto[];
  @ApiProperty() dataRetentionMessage!: string;
}
export class DatabaseEnvelopeDto {
  @ApiProperty({ type: DatabaseDto }) data!: DatabaseDto;
}
export class DatabaseListDto {
  @ApiProperty({ type: [DatabaseDto] }) data!: DatabaseDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class DatabaseBindingPreviewEnvelopeDto {
  @ApiProperty({ type: DatabaseBindingPreviewDto }) data!: DatabaseBindingPreviewDto;
}
export class ServiceDeletionPreviewEnvelopeDto {
  @ApiProperty({ type: ServiceDeletionPreviewDto }) data!: ServiceDeletionPreviewDto;
}
