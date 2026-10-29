import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  MetadataResponseDto,
  NamedResourceDto,
  PageInfoDto,
  RenameResourceDto,
  trimText,
} from '../projects/metadata.dto.js';
import { SshHostKeyDto, SshPreflightDto } from '../infrastructure/observation.dto.js';

export class CreateServerDto extends NamedResourceDto {
  @ApiProperty({ description: 'IP 地址或主机名，不含协议、凭证和端口' })
  @Transform(trimText)
  @IsString()
  @Length(1, 253)
  host!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535, default: 22 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(65535)
  sshPort?: number;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/)
  sshUser!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'kind=ssh 的凭证引用' })
  @IsOptional()
  @IsUUID()
  credentialRefId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(80)
  region?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  tags?: string[];
}

export class UpdateServerDto extends RenameResourceDto {
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @Length(1, 253)
  host?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(65535)
  sshPort?: number;

  @ApiPropertyOptional({ maxLength: 64 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/)
  sshUser?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUUID()
  credentialRefId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(80)
  region?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  tags?: string[];
}

export class ServerResponseDto extends MetadataResponseDto {
  @ApiProperty() initializationVersion!: string;
  @ApiProperty({ type: SshHostKeyDto }) hostKey!: SshHostKeyDto;
  @ApiProperty({ type: String, nullable: true }) machineId!: string | null;
  @ApiProperty({ type: SshPreflightDto, nullable: true }) preflight!: SshPreflightDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) preflightAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorMessage!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) lastOperationId!: string | null;
  @ApiProperty()
  host!: string;

  @ApiProperty({ minimum: 1, maximum: 65535 })
  sshPort!: number;

  @ApiProperty()
  sshUser!: string;

  @ApiProperty({ nullable: true, type: String })
  credentialRefId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  region!: string | null;

  @ApiProperty({ type: [String] })
  tags!: string[];

  @ApiProperty({
    enum: ['unverified', 'connected', 'unreachable', 'unknown'],
    description: '预检观察状态，未预检时为 unverified',
  })
  connectionStatus!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastObservedAt!: string | null;
}

export class ServerEnvelopeDto {
  @ApiProperty({ type: ServerResponseDto })
  data!: ServerResponseDto;
}

export class ServerListDto {
  @ApiProperty({ type: [ServerResponseDto] })
  data!: ServerResponseDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}
