import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';
import {
  MetadataResponseDto,
  PageInfoDto,
  RenameResourceDto,
  SlugResourceDto,
  trimText,
} from '../projects/metadata.dto.js';
import {
  KubernetesIdentityDto,
  KubernetesInspectionDto,
} from '../infrastructure/observation.dto.js';

export class CreateClusterDto extends SlugResourceDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(80)
  region?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '尚未连接的 Kubernetes HTTPS API 地址',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false, disallow_auth: true })
  apiEndpoint?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'kind=kubeconfig 的凭证引用' })
  @IsOptional()
  @IsUUID()
  credentialRefId?: string | null;
}

export class UpdateClusterDto extends RenameResourceDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(80)
  region?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'S1 仅允许修改未绑定项目的未验证登记',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false, disallow_auth: true })
  apiEndpoint?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'S1 仅允许修改未绑定项目的未验证登记',
  })
  @IsOptional()
  @IsUUID()
  credentialRefId?: string | null;
}

export class ClusterSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({
    enum: ['unverified', 'connected', 'unreachable', 'unknown'],
    description: '真实连接观察状态；元数据登记不会标记为在线',
  })
  connectionStatus!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastObservedAt!: string | null;
}

export class ClusterResponseDto extends MetadataResponseDto {
  @ApiProperty({ type: KubernetesIdentityDto, nullable: true })
  identity!: KubernetesIdentityDto | null;
  @ApiProperty({ type: KubernetesInspectionDto, nullable: true })
  observation!: KubernetesInspectionDto | null;
  @ApiProperty() observationStale!: boolean;
  @ApiProperty({ minimum: 0 }) nodeCount!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorMessage!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) lastOperationId!: string | null;
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ nullable: true, type: String })
  region!: string | null;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ nullable: true, type: String })
  apiEndpoint!: string | null;

  @ApiProperty({ nullable: true, type: String })
  credentialRefId!: string | null;

  @ApiProperty({ enum: ['unverified', 'connected', 'unreachable', 'unknown'] })
  connectionStatus!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastObservedAt!: string | null;

  @ApiProperty({ minimum: 0 })
  projectCount!: number;
}

export class ClusterEnvelopeDto {
  @ApiProperty({ type: ClusterResponseDto })
  data!: ClusterResponseDto;
}

export class ClusterListDto {
  @ApiProperty({ type: [ClusterResponseDto] })
  data!: ClusterResponseDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}
