import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { MetadataResponseDto, NamedResourceDto, PageInfoDto } from '../projects/metadata.dto.js';

export const SECRET_KINDS = [
  'ssh',
  'kubeconfig',
  'git',
  'registry',
  'database',
  'generic',
  'webhook',
  'builder',
] as const;
export type CredentialKind = (typeof SECRET_KINDS)[number];

export class CreateSecretDto extends NamedResourceDto {
  @ApiProperty({ enum: SECRET_KINDS })
  @IsIn(SECRET_KINDS)
  kind!: CredentialKind;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    writeOnly: true,
    description: '只用于加密存储，不在普通 API 中返回',
  })
  @IsObject()
  @IsNotEmptyObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}

export class SecretQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: SECRET_KINDS })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(SECRET_KINDS)
  kind?: CredentialKind;
}

export class SecretResponseDto extends MetadataResponseDto {
  @ApiProperty({ enum: SECRET_KINDS })
  kind!: CredentialKind;

  @ApiProperty({ minimum: 1, description: '加密主密钥版本，仅作元数据呈现' })
  keyVersion!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  expiresAt!: string | null;
}

export class SecretEnvelopeDto {
  @ApiProperty({ type: SecretResponseDto })
  data!: SecretResponseDto;
}

export class SecretListDto {
  @ApiProperty({ type: [SecretResponseDto] })
  data!: SecretResponseDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}
