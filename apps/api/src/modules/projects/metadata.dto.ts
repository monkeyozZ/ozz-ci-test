import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ResourceParamsDto {
  @ApiProperty({ description: '稳定资源 ID', format: 'uuid' })
  @IsUUID()
  id!: string;
}

export class RevisionDto {
  @ApiProperty({
    minimum: 1,
    maximum: 2147483647,
    description: '本次编辑所依据的资源 revision；过期时返回 409',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision!: number;
}

export class DeleteRevisionDto {
  @ApiProperty({ minimum: 1, maximum: 2147483647, description: '删除前确认的资源 revision' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision!: number;
}

export class NamedResourceDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @Transform(trimText)
  @IsString()
  @Length(1, 120)
  @IsNotEmpty()
  name!: string;
}

export class SlugResourceDto extends NamedResourceDto {
  @ApiProperty({ minLength: 1, maxLength: 63, pattern: SLUG_PATTERN.source })
  @IsString()
  @Length(1, 63)
  @Matches(SLUG_PATTERN)
  slug!: string;
}

export class RenameResourceDto extends RevisionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @Length(1, 120)
  @IsNotEmpty()
  name?: string;
}

export class MetadataResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 1 })
  revision!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class PageInfoDto {
  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;
}
