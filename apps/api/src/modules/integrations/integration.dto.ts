import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageInfoDto, ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { BuildPlatformDto } from '../git/git.dto.js';

export class IntegrationCheckDto {
  @ApiProperty({ enum: ['unverified', 'verified', 'failed'] }) state!:
    'unverified' | 'verified' | 'failed';
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) checkedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
}
export class GitHubConnectionCreateDto {
  @ApiProperty({ maxLength: 120 }) @IsString() @MaxLength(120) name!: string;
  @ApiProperty({ format: 'uuid', description: 'Fine-grained PAT 的 git 类型秘密引用' })
  @IsUUID()
  credentialRefId!: string;
}
export class GitHubConnectionUpdateDto extends RevisionDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() credentialRefId?: string;
}
export class GitHubAccountDto {
  @ApiProperty() id!: string;
  @ApiProperty() login!: string;
}
export class GitHubConnectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['fine_grained_pat'] }) authorization!: 'fine_grained_pat';
  @ApiProperty({ format: 'uuid' }) credentialRefId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: IntegrationCheckDto }) verification!: IntegrationCheckDto;
  @ApiProperty({ type: GitHubAccountDto, nullable: true }) account!: GitHubAccountDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class GitHubConnectionEnvelopeDto {
  @ApiProperty({ type: GitHubConnectionDto }) data!: GitHubConnectionDto;
}
export class GitHubConnectionListDto {
  @ApiProperty({ type: [GitHubConnectionDto] }) data!: GitHubConnectionDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class RepositoryHookDto {
  @ApiProperty() state!: string;
  @ApiProperty({ type: String, nullable: true }) hookId!: string | null;
  @ApiProperty({ type: String, nullable: true }) callbackUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) verifiedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) operationId!: string | null;
}
export class GitRepositoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) githubConnectionId!: string;
  @ApiProperty() githubRepositoryId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() defaultBranch!: string;
  @ApiProperty() private!: boolean;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: RepositoryHookDto }) hook!: RepositoryHookDto;
  @ApiProperty({ format: 'date-time' }) lastVerifiedAt!: string;
}
export class GitRepositoryListDto {
  @ApiProperty({ type: [GitRepositoryDto] }) data!: GitRepositoryDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class GitHubPageQueryDto {
  @ApiPropertyOptional({ description: 'GitHub 列表的原分页游标' })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9][0-9]{0,3}$/)
  cursor?: string;
}
export class GitBranchDto {
  @ApiProperty() name!: string;
  @ApiProperty() ref!: string;
  @ApiProperty() commitSha!: string;
}
export class GitBranchListDto {
  @ApiProperty({ type: [GitBranchDto] }) data!: GitBranchDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class GitHubRepositoryParamsDto extends ResourceParamsDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() repositoryId!: string;
}
export class RegisterWebhookDto extends RevisionDto {
  @ApiProperty({
    format: 'uuid',
    description: '独立 webhook 类型秘密引用；注册/更新实际 GitHub hook',
  })
  @IsUUID()
  secretRefId!: string;
}
export class RegistryConnectionCreateDto {
  @ApiProperty({ maxLength: 120 }) @IsString() @MaxLength(120) name!: string;
  @ApiProperty({ maxLength: 253 }) @IsString() @MaxLength(253) authority!: string;
  @ApiProperty({ maxLength: 255 }) @IsString() @MaxLength(255) namespace!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() pushCredentialRefId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() pullCredentialRefId!: string;
}
export class RegistryConnectionUpdateDto extends RevisionDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() pushCredentialRefId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() pullCredentialRefId?: string;
}
export class RegistryConnectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() authority!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty({ format: 'uuid' }) pushCredentialRefId!: string;
  @ApiProperty({ format: 'uuid' }) pullCredentialRefId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: IntegrationCheckDto }) pushVerification!: IntegrationCheckDto;
  @ApiProperty({ type: IntegrationCheckDto }) pullVerification!: IntegrationCheckDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class RegistryConnectionEnvelopeDto {
  @ApiProperty({ type: RegistryConnectionDto }) data!: RegistryConnectionDto;
}
export class RegistryConnectionListDto {
  @ApiProperty({ type: [RegistryConnectionDto] }) data!: RegistryConnectionDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class BuilderProfileInputDto {
  @ApiProperty({ maxLength: 64 }) @IsString() @MaxLength(64) buildkitVersion!: string;
  @ApiProperty({ pattern: '^sha256:[0-9a-f]{64}$' })
  @Matches(/^sha256:[0-9a-f]{64}$/)
  frontendDigest!: string;
}
export class BuilderProfileDto extends BuilderProfileInputDto {
  @ApiProperty({ format: 'uuid' }) instanceId!: string;
  @ApiProperty() profileRevision!: number;
}
export class BuilderCreateDto {
  @ApiProperty({ maxLength: 120 }) @IsString() @MaxLength(120) name!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() instanceId!: string;
  @ApiProperty({ maxLength: 2048 }) @IsString() @MaxLength(2048) identityPublicKey!: string;
  @ApiProperty({ maxLength: 2048 }) @IsString() @MaxLength(2048) endpoint!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() credentialRefId!: string;
  @ApiProperty({ type: BuilderProfileInputDto })
  @IsObject()
  @ValidateNested()
  @Type(() => BuilderProfileInputDto)
  profile!: BuilderProfileInputDto;
}
export class BuilderUpdateDto extends RevisionDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  endpoint?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() credentialRefId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ type: BuilderProfileInputDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BuilderProfileInputDto)
  profile?: BuilderProfileInputDto;
}
export class BuilderCapabilitiesDto {
  @ApiProperty() highGeneration!: number;
  @ApiProperty() controlPlaneGenerationAtCheck!: number;
  @ApiProperty({ type: BuildPlatformDto }) platform!: BuildPlatformDto;
  @ApiProperty() maxConcurrency!: number;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
}
export class BuilderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ format: 'uuid' }) instanceId!: string;
  @ApiProperty() identityPublicKey!: string;
  @ApiProperty() endpoint!: string;
  @ApiProperty({ format: 'uuid' }) credentialRefId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() profileRevision!: number;
  @ApiProperty({ type: BuilderProfileDto }) profile!: BuilderProfileDto;
  @ApiProperty({ type: IntegrationCheckDto }) verification!: IntegrationCheckDto;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: BuilderCapabilitiesDto, nullable: true })
  capabilities!: BuilderCapabilitiesDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class BuilderEnvelopeDto {
  @ApiProperty({ type: BuilderDto }) data!: BuilderDto;
}
export class BuilderListDto {
  @ApiProperty({ type: [BuilderDto] }) data!: BuilderDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
