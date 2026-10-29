import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ServicePortDto {
  @ApiProperty({ maxLength: 15 }) @IsString() @MaxLength(15) name!: string;
  @ApiProperty({ enum: ['http', 'tcp'] }) @IsIn(['http', 'tcp']) protocol!: 'http' | 'tcp';
  @ApiProperty({ minimum: 1, maximum: 65535 }) @IsInt() @Min(1) @Max(65535) containerPort!: number;
  @ApiProperty({ minimum: 1, maximum: 65535 }) @IsInt() @Min(1) @Max(65535) servicePort!: number;
}

export class ServiceResourceQuantityDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) cpuMillis!: number;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) memoryMiB!: number;
}

export class ServiceResourcesDto {
  @ApiProperty({ type: ServiceResourceQuantityDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ServiceResourceQuantityDto)
  requests!: ServiceResourceQuantityDto;
  @ApiProperty({ type: ServiceResourceQuantityDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ServiceResourceQuantityDto)
  limits!: ServiceResourceQuantityDto;
}

export class ServiceProbeDto {
  @ApiProperty({ enum: ['http', 'tcp'] }) @IsIn(['http', 'tcp']) type!: 'http' | 'tcp';
  @ApiProperty({ description: '已声明的容器端口名称' }) @IsString() @MaxLength(15) port!: string;
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  path?: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) initialDelaySeconds!: number;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) periodSeconds!: number;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) timeoutSeconds!: number;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) failureThreshold!: number;
}

export class ServiceVariableDto {
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ description: '只有普通变量返回值；秘密变量只返回引用' }) value?: string;
  @ApiPropertyOptional({ format: 'uuid' }) secretRefId?: string;
  @ApiPropertyOptional() secretKey?: string;
}

export class ServiceVariableInputDto {
  @ApiProperty({ maxLength: 128 }) @IsString() @MaxLength(128) name!: string;
  @ApiPropertyOptional({ maxLength: 24576, writeOnly: true })
  @IsOptional()
  @IsString()
  @MaxLength(24576)
  value?: string;
  @ApiPropertyOptional({ description: '将本次输入加密保存，响应不返回明文' })
  @IsOptional()
  @IsBoolean()
  secret?: boolean;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() secretRefId?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  secretKey?: string;
}

export class ServiceRuntimeConfigurationDto {
  @ApiProperty({ minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20) replicas!: number;
  @ApiProperty({ type: [String], maxItems: 64 })
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  command!: string[];
  @ApiProperty({ type: [String], maxItems: 64 })
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  args!: string[];
  @ApiProperty({ type: [ServicePortDto], maxItems: 16 })
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => ServicePortDto)
  ports!: ServicePortDto[];
  @ApiProperty({ type: ServiceResourcesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ServiceResourcesDto)
  resources!: ServiceResourcesDto;
  @ApiProperty({ type: ServiceProbeDto, nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ServiceProbeDto)
  readiness!: ServiceProbeDto | null;
  @ApiProperty({ type: ServiceProbeDto, nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ServiceProbeDto)
  startup!: ServiceProbeDto | null;
  @ApiProperty({ minimum: 10, maximum: 900 })
  @IsInt()
  @Min(10)
  @Max(900)
  healthTimeoutSeconds!: number;
}

export class ServiceConfigurationInputDto extends PartialType(ServiceRuntimeConfigurationDto) {
  @ApiProperty({ maxLength: 1024, description: '镜像标签或完整 sha256 摘要' })
  @IsString()
  @MaxLength(1024)
  image!: string;
  @ApiPropertyOptional({ type: [ServiceVariableInputDto], maxItems: 128 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(128)
  @ValidateNested({ each: true })
  @Type(() => ServiceVariableInputDto)
  environment?: ServiceVariableInputDto[];
}

export class ServiceConfigurationDto extends ServiceRuntimeConfigurationDto {
  @ApiProperty() image!: string;
  @ApiProperty({ type: [ServiceVariableDto] }) environment!: ServiceVariableDto[];
}

export class GitRuntimeConfigurationInputDto extends PartialType(ServiceRuntimeConfigurationDto) {
  @ApiPropertyOptional({ type: [ServiceVariableInputDto], maxItems: 128 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(128)
  @ValidateNested({ each: true })
  @Type(() => ServiceVariableInputDto)
  environment?: ServiceVariableInputDto[];
}
export class GitRuntimeConfigurationDto extends ServiceRuntimeConfigurationDto {
  @ApiProperty({ type: [ServiceVariableDto] }) environment!: ServiceVariableDto[];
}

export class ImagePlatformDto {
  @ApiProperty({ enum: ['linux'] }) os!: 'linux';
  @ApiProperty({ enum: ['amd64', 'arm64'] }) architecture!: 'amd64' | 'arm64';
  @ApiPropertyOptional() variant?: string;
  @ApiProperty() manifestDigest!: string;
  @ApiProperty() manifestMediaType!: string;
  @ApiProperty() configDigest!: string;
}

export class ResolvedImageDto {
  @ApiProperty({ enum: [1] }) version!: 1;
  @ApiProperty() inputReference!: string;
  @ApiProperty() registry!: string;
  @ApiProperty() repository!: string;
  @ApiProperty({ type: String, nullable: true }) tag!: string | null;
  @ApiProperty({ type: String, nullable: true }) requestedDigest!: string | null;
  @ApiProperty() manifestDigest!: string;
  @ApiProperty() manifestMediaType!: string;
  @ApiProperty({ type: String, nullable: true }) indexDigest!: string | null;
  @ApiProperty() deployReference!: string;
  @ApiProperty({ type: [ImagePlatformDto] }) platformManifests!: ImagePlatformDto[];
  @ApiProperty({ format: 'date-time' }) resolvedAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) verifiedAt?: string;
}
