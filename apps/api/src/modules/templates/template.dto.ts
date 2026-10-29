import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type {
  TemplateId,
  TemplateParameter,
  TemplateParameters,
  TemplatePreview,
  TemplatePreviewInput,
  TemplateSelection,
  TemplateView,
} from '@ozz/control-plane/databases';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto } from '../projects/metadata.dto.js';
import { ServiceConfigurationDto, ServiceResourcesDto } from '../services/configuration.dto.js';
import { DataIssueDto } from '../databases/database.dto.js';

const templateIds = ['docker', 'node-example', 'static-example', 'postgresql', 'redis'] as const;
const parameterNames = [
  'image',
  'port',
  'requestedBytes',
  'username',
  'databaseName',
  'redisDatabase',
] as const;
export class TemplateParametersDto implements TemplateParameters {
  @ApiPropertyOptional({ maxLength: 2048 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Length(1, 2048)
  image?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 65535 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;
  @ApiPropertyOptional({ type: String, example: '1073741824' })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(/^[1-9][0-9]{0,12}$/u)
  requestedBytes?: string;
  @ApiPropertyOptional({ maxLength: 63 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,62}$/u)
  username?: string;
  @ApiPropertyOptional({ maxLength: 63 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,62}$/u)
  databaseName?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 15 })
  @ValidateIf((_o, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(15)
  redisDatabase?: number;
}
export class TemplateSelectionDto implements TemplateSelection {
  @ApiProperty({ enum: templateIds }) @IsIn(templateIds) id!: TemplateId;
  @ApiProperty({ example: '1.0.0', maxLength: 64 }) @IsString() @Length(1, 64) version!: string;
  @ApiProperty({ type: TemplateParametersDto })
  @IsObject()
  @ValidateNested()
  @Type(() => TemplateParametersDto)
  parameters!: TemplateParametersDto;
}
export class TemplatePreviewInputDto implements TemplatePreviewInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() environmentId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiProperty({ example: '1.0.0', maxLength: 64 }) @IsString() @Length(1, 64) version!: string;
  @ApiProperty({ type: TemplateParametersDto })
  @IsObject()
  @ValidateNested()
  @Type(() => TemplateParametersDto)
  parameters!: TemplateParametersDto;
}
export class TemplateParamsDto {
  @ApiProperty({ enum: templateIds })
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z0-9-]+$/u)
  id!: string;
}
export class TemplateVersionQueryDto {
  @ApiPropertyOptional({ maxLength: 64 }) @IsOptional() @IsString() @Length(1, 64) version?: string;
}
export class TemplateQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 }) override limit = 50;
  @ApiPropertyOptional({ enum: ['application', 'database'] })
  @IsOptional()
  @IsIn(['application', 'database'])
  category?: string;
}
export class TemplateParameterDto implements TemplateParameter {
  @ApiProperty({ enum: parameterNames }) name!: keyof TemplateParameters;
  @ApiProperty() label!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: ['string', 'integer', 'bytes'] }) type!: TemplateParameter['type'];
  @ApiProperty() required!: boolean;
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }], nullable: true }) defaultValue!:
    string | number | null;
  @ApiProperty({ type: Number, nullable: true }) minimum!: number | null;
  @ApiProperty({ type: Number, nullable: true }) maximum!: number | null;
}
export class TemplateImageDto {
  @ApiProperty() reference!: string;
  @ApiProperty() digest!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ enum: ['arm64', 'amd64'], isArray: true }) platforms!: ('arm64' | 'amd64')[];
  @ApiProperty({ format: 'date-time' }) verifiedAt!: string;
}
export class TemplateControllerDto {
  @ApiProperty({ enum: ['Deployment', 'StatefulSet'] }) kind!: 'Deployment' | 'StatefulSet';
  @ApiProperty({ enum: ['RollingUpdate', 'Recreate'] }) strategy!: 'RollingUpdate' | 'Recreate';
}
export class TemplateDto implements TemplateView {
  @ApiProperty({ enum: templateIds }) id!: TemplateId;
  @ApiProperty() version!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: ['application', 'database'] }) category!: 'application' | 'database';
  @ApiProperty({ format: 'uri' }) sourceUrl!: string;
  @ApiProperty() license!: string;
  @ApiProperty({ type: TemplateImageDto, nullable: true }) image!: TemplateImageDto | null;
  @ApiProperty({ type: [TemplateParameterDto] }) parameters!: TemplateParameterDto[];
  @ApiProperty({ type: ServiceResourcesDto }) resources!: ServiceResourcesDto;
  @ApiProperty({ type: TemplateControllerDto }) controller!: TemplateControllerDto;
  @ApiProperty() persistent!: boolean;
  @ApiProperty({ type: [String] }) notes!: string[];
}
export class TemplateIdentityDto {
  @ApiProperty({ enum: templateIds }) id!: TemplateId;
  @ApiProperty() version!: string;
}
export class TemplatePlannedVolumeDto {
  @ApiProperty({ enum: ['database_data'] }) purpose!: 'database_data';
  @ApiProperty({ type: String }) requestedBytes!: string;
  @ApiProperty({ enum: ['local-path'] }) storageClassName!: 'local-path';
  @ApiProperty() mountPath!: string;
  @ApiProperty({ enum: ['unsupported'] }) hardQuotaSupport!: 'unsupported';
}
export class TemplatePlannedCredentialDto {
  @ApiProperty({ enum: ['database'] }) kind!: 'database';
  @ApiProperty({ type: Boolean, enum: [true] }) generated!: true;
}
export class TemplatePreviewDto implements TemplatePreview {
  @ApiProperty({ type: TemplateIdentityDto }) template!: TemplateIdentityDto;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ type: ServiceConfigurationDto }) configuration!: ServiceConfigurationDto;
  @ApiProperty({ type: TemplateControllerDto }) controller!: TemplateControllerDto;
  @ApiProperty({ type: [TemplatePlannedVolumeDto] }) plannedVolumes!: TemplatePlannedVolumeDto[];
  @ApiProperty({ type: [TemplatePlannedCredentialDto] })
  plannedCredentials!: TemplatePlannedCredentialDto[];
  @ApiProperty({ type: [DataIssueDto] }) issues!: DataIssueDto[];
  @ApiProperty() previewDigest!: string;
}
export class TemplateEnvelopeDto {
  @ApiProperty({ type: TemplateDto }) data!: TemplateDto;
}
export class TemplateListDto {
  @ApiProperty({ type: [TemplateDto] }) data!: TemplateDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class TemplatePreviewEnvelopeDto {
  @ApiProperty({ type: TemplatePreviewDto }) data!: TemplatePreviewDto;
}
