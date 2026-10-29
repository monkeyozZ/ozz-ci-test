import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import {
  MetadataResponseDto,
  PageInfoDto,
  RenameResourceDto,
  SlugResourceDto,
  trimText,
} from '../projects/metadata.dto.js';

export class CreateEnvironmentDto extends SlugResourceDto {
  @ApiProperty({ description: '所属项目；目标继承项目的 Cluster' })
  @IsUUID()
  projectId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class UpdateEnvironmentDto extends RenameResourceDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

export class EnvironmentQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  projectId?: string;
}

export class EnvironmentResponseDto extends MetadataResponseDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  projectId!: string;

  @ApiProperty({ readOnly: true, description: '由所属项目推导，不是独立部署目标' })
  clusterId!: string;

  @ApiProperty({ readOnly: true })
  isDefault!: boolean;
}

export class EnvironmentEnvelopeDto {
  @ApiProperty({ type: EnvironmentResponseDto })
  data!: EnvironmentResponseDto;
}

export class EnvironmentListDto {
  @ApiProperty({ type: [EnvironmentResponseDto] })
  data!: EnvironmentResponseDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}
