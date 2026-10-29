import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { ClusterSummaryDto } from '../clusters/cluster.dto.js';
import {
  MetadataResponseDto,
  PageInfoDto,
  RenameResourceDto,
  SlugResourceDto,
  trimText,
} from './metadata.dto.js';

export class CreateProjectDto extends SlugResourceDto {
  @ApiProperty({ description: '必选的已登记 Cluster ID；可以尚未验证' })
  @IsUUID()
  clusterId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class UpdateProjectDto extends RenameResourceDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class ProjectQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  clusterId?: string;
}

export class ProjectResponseDto extends MetadataResponseDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  clusterId!: string;

  @ApiProperty({ type: ClusterSummaryDto })
  cluster!: ClusterSummaryDto;
}

export class ProjectEnvelopeDto {
  @ApiProperty({ type: ProjectResponseDto })
  data!: ProjectResponseDto;
}

export class ProjectListDto {
  @ApiProperty({ type: [ProjectResponseDto] })
  data!: ProjectResponseDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}
