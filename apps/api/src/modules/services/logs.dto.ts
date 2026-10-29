import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const booleanQuery = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ServiceLogsQueryDto {
  @ApiProperty({ format: 'uuid', description: '从当前服务 Pod 列表选择的 UID' })
  @IsUUID()
  podUid!: string;

  @ApiProperty({ maxLength: 63 })
  @IsString()
  @MaxLength(63)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
  container!: string;

  @ApiPropertyOptional({ default: false })
  @Transform(booleanQuery)
  @IsBoolean()
  previous = false;

  @ApiPropertyOptional({ default: false })
  @Transform(booleanQuery)
  @IsBoolean()
  follow = false;

  @ApiPropertyOptional({ default: 200, minimum: 1, maximum: 1000 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d{1,4}$/u.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(1000)
  tailLines = 200;
}
