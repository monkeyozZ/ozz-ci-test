import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, IsUrl, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { RevisionDto, trimText } from '../projects/metadata.dto.js';

export class TrustHostKeyDto extends RevisionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() discoveryOperationId!: string;
  @ApiProperty({ description: '通过独立可信来源核对的 OpenSSH SHA256 指纹' })
  @IsString()
  @Matches(/^SHA256:[A-Za-z0-9+/]{43}$/)
  fingerprint!: string;
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trimText)
  @IsString()
  @Length(5, 500)
  source!: string;
}

export class InitializeServerDto extends RevisionDto {
  @ApiProperty({ format: 'uuid', description: '已有空白集群登记 ID' }) @IsUUID() clusterId!: string;
  @ApiProperty({ minLength: 1, maxLength: 63 })
  @IsString()
  @Length(1, 63)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  nodeName!: string;
  @ApiProperty({
    maxLength: 2048,
    description: '控制面可访问的 HTTPS Kubernetes API 地址，必须通过 SAN 校验',
  })
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false, disallow_auth: true })
  apiEndpoint!: string;
}

export class ConnectionPreviewRequestDto extends RevisionDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  credentialRefId?: string;
  @ApiPropertyOptional({ maxLength: 2048 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false, disallow_auth: true })
  apiEndpoint?: string;
}

export class ConnectClusterDto extends ConnectionPreviewRequestDto {
  @ApiPropertyOptional({ maxLength: 128, description: '预览并明确确认的新 CA SHA256 摘要' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 128)
  acceptedCaFingerprint?: string;
}
