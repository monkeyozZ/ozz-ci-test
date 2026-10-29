import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto, RevisionDto } from '../projects/metadata.dto.js';
import { GitRuntimeConfigurationDto } from '../services/configuration.dto.js';
import { ServiceTaskTargetDto } from '../services/execution.dto.js';
import {
  ServiceControllerConfigurationDto,
  ServiceDatabaseBindingSnapshotDto,
  ServiceVolumeSnapshotDto,
} from '../services/data-snapshot.dto.js';

export class BuildPlatformDto {
  @ApiProperty({ enum: ['linux'] }) @IsIn(['linux']) os!: 'linux';
  @ApiProperty({ enum: ['amd64', 'arm64'] }) @IsIn(['amd64', 'arm64']) architecture!:
    'amd64' | 'arm64';
  @ApiPropertyOptional({ enum: ['v1', 'v8'] }) @IsOptional() @IsIn(['v1', 'v8']) variant?: string;
}
export class BuildSecretInputDto {
  @ApiProperty({ maxLength: 64 }) @IsString() @MaxLength(64) mountId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() secretRefId!: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  secretKey?: string;
}
export class FixedBuildSecretDto {
  @ApiProperty() mountId!: string;
  @ApiProperty({ format: 'uuid' }) secretRefId!: string;
  @ApiProperty() secretKey!: string;
  @ApiProperty() contentRevision!: number;
}
export class ImageSourceDto {
  @ApiProperty({ enum: ['image'] }) @IsIn(['image']) kind!: 'image';
}
export class GitSourceInputDto {
  @ApiProperty({ enum: ['github'] }) @IsIn(['github']) kind!: 'github';
  @ApiProperty({ format: 'uuid' }) @IsUUID() repositoryId!: string;
  @ApiProperty({ maxLength: 270, example: 'refs/heads/main' })
  @IsString()
  @MaxLength(270)
  branchRef!: string;
  @ApiProperty({ maxLength: 500, example: 'Dockerfile' })
  @IsString()
  @MaxLength(500)
  dockerfilePath!: string;
  @ApiProperty({ maxLength: 500, example: '.' }) @IsString() @MaxLength(500) contextPath!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  buildArgs?: Record<string, string>;
  @ApiPropertyOptional({ type: [BuildSecretInputDto], maxItems: 32 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => BuildSecretInputDto)
  buildSecrets?: BuildSecretInputDto[];
  @ApiProperty({ type: [BuildPlatformDto], minItems: 1, maxItems: 2 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => BuildPlatformDto)
  platforms!: BuildPlatformDto[];
  @ApiProperty({ format: 'uuid' }) @IsUUID() builderId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() registryConnectionId!: string;
  @ApiProperty({ maxLength: 255, description: '相对于固定Registry命名空间的镜像名称' })
  @IsString()
  @MaxLength(255)
  imageRepository!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoDeploy?: boolean;
}
export class GitRepositoryIdentityDto {
  @ApiProperty({ format: 'uuid' }) repositoryId!: string;
  @ApiProperty() githubRepositoryId!: string;
  @ApiProperty() fullNameAtCapture!: string;
}
export class FixedBuilderProfileDto {
  @ApiProperty({ format: 'uuid' }) builderId!: string;
  @ApiProperty({ format: 'uuid' }) instanceId!: string;
  @ApiProperty() profileRevision!: number;
  @ApiProperty() buildkitVersion!: string;
  @ApiProperty() frontendDigest!: string;
}
export class FixedRegistryDestinationDto {
  @ApiProperty({ format: 'uuid' }) registryConnectionId!: string;
  @ApiProperty() authority!: string;
  @ApiProperty() repository!: string;
}
export class GitSourceRevisionDto {
  @ApiProperty({ enum: [1] }) version!: 1;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sourceId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['github'] }) provider!: 'github';
  @ApiProperty({ format: 'uuid' }) githubConnectionId!: string;
  @ApiProperty({ type: GitRepositoryIdentityDto }) repository!: GitRepositoryIdentityDto;
  @ApiProperty() branchRef!: string;
  @ApiProperty() dockerfilePath!: string;
  @ApiProperty() contextPath!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) buildArgs!: Record<
    string,
    string
  >;
  @ApiProperty({ type: [FixedBuildSecretDto] }) buildSecrets!: FixedBuildSecretDto[];
  @ApiProperty({ type: [BuildPlatformDto] }) platforms!: BuildPlatformDto[];
  @ApiProperty({ type: FixedBuilderProfileDto }) builder!: FixedBuilderProfileDto;
  @ApiProperty({ type: FixedRegistryDestinationDto }) destination!: FixedRegistryDestinationDto;
  @ApiProperty() recipeHash!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class GitSourceDto {
  @ApiProperty({ enum: ['github'] }) kind!: 'github';
  @ApiProperty({ format: 'uuid' }) sourceId!: string;
  @ApiProperty({ type: GitSourceRevisionDto }) currentRevision!: GitSourceRevisionDto;
  @ApiProperty() autoDeploy!: boolean;
  @ApiProperty() policyRevision!: number;
}
export class GitSourceSnapshotDto {
  @ApiProperty({ enum: ['github'] }) kind!: 'github';
  @ApiProperty({ type: GitSourceRevisionDto }) revision!: GitSourceRevisionDto;
  @ApiProperty({ minLength: 40, maxLength: 40 }) commitSha!: string;
}
export class GitSourceUpdateDto extends RevisionDto {
  @ApiProperty({ type: GitSourceInputDto })
  @IsObject()
  @ValidateNested()
  @Type(() => GitSourceInputDto)
  source!: GitSourceInputDto;
}
export class GitPolicyUpdateDto extends RevisionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) policyRevision!: number;
  @ApiProperty() @IsBoolean() autoDeploy!: boolean;
}
export class BranchHeadSelectionDto {
  @ApiProperty({ enum: ['branch_head'] }) @IsIn(['branch_head']) kind!: 'branch_head';
}
export class CommitSelectionDto {
  @ApiProperty({ enum: ['commit'] }) @IsIn(['commit']) kind!: 'commit';
  @ApiProperty({ minLength: 40, maxLength: 40 }) @Matches(/^[0-9a-f]{40}$/) commitSha!: string;
}
export class PendingTargetSelectionDto {
  @ApiProperty({ enum: ['pending_target'] }) @IsIn(['pending_target']) kind!: 'pending_target';
  @ApiProperty({ format: 'uuid' }) @IsUUID() webhookTargetId!: string;
}
@ApiExtraModels(BranchHeadSelectionDto, CommitSelectionDto, PendingTargetSelectionDto)
export class GitPreviewRequestDto extends RevisionDto {
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(BranchHeadSelectionDto) },
      { $ref: getSchemaPath(CommitSelectionDto) },
      { $ref: getSchemaPath(PendingTargetSelectionDto) },
    ],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        branch_head: getSchemaPath(BranchHeadSelectionDto),
        commit: getSchemaPath(CommitSelectionDto),
        pending_target: getSchemaPath(PendingTargetSelectionDto),
      },
    },
  })
  @IsObject()
  @ValidateNested()
  @Type(() => BranchHeadSelectionDto, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { name: 'branch_head', value: BranchHeadSelectionDto },
        { name: 'commit', value: CommitSelectionDto },
        { name: 'pending_target', value: PendingTargetSelectionDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  selection!: BranchHeadSelectionDto | CommitSelectionDto | PendingTargetSelectionDto;
}
export class GitSnapshotTargetDto extends ServiceTaskTargetDto {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
}
export class DeploymentGitSnapshotDto {
  @ApiProperty({ enum: [3] }) version!: 3;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty() serviceSlug!: string;
  @ApiProperty() configRevision!: number;
  @ApiProperty({ type: GitRuntimeConfigurationDto }) configuration!: GitRuntimeConfigurationDto;
  @ApiProperty({ type: GitSourceSnapshotDto }) source!: GitSourceSnapshotDto;
  @ApiProperty() deployAndStart!: boolean;
  @ApiProperty() allowConfigurationRepair!: boolean;
  @ApiProperty({ type: ServiceControllerConfigurationDto })
  controller!: ServiceControllerConfigurationDto;
  @ApiProperty({ type: [ServiceVolumeSnapshotDto] }) volumes!: ServiceVolumeSnapshotDto[];
  @ApiProperty({ type: 'object', additionalProperties: false, nullable: true, enum: [null] })
  database!: null;
  @ApiProperty({ type: [ServiceDatabaseBindingSnapshotDto] })
  databaseBindings!: ServiceDatabaseBindingSnapshotDto[];
  @ApiProperty({ type: 'object', additionalProperties: false, nullable: true, enum: [null] })
  template!: null;
}
export class GitPreviewIssueDto {
  @ApiProperty() code!: string;
  @ApiPropertyOptional() field?: string;
  @ApiProperty() message!: string;
}
export class GitPublicationPreviewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() serviceRevision!: number;
  @ApiProperty() configRevision!: number;
  @ApiProperty() policyRevision!: number;
  @ApiProperty({ type: GitSourceSnapshotDto }) source!: GitSourceSnapshotDto;
  @ApiProperty({ type: GitSnapshotTargetDto }) target!: GitSnapshotTargetDto;
  @ApiProperty({ type: GitRuntimeConfigurationDto }) configuration!: GitRuntimeConfigurationDto;
  @ApiProperty({ type: DeploymentGitSnapshotDto }) snapshot!: DeploymentGitSnapshotDto;
  @ApiProperty({ enum: ['running', 'stopped'] }) desiredState!: 'running' | 'stopped';
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) webhookTargetId!: string | null;
  @ApiProperty({ type: [GitPreviewIssueDto] }) issues!: GitPreviewIssueDto[];
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
export class GitPublicationPreviewEnvelopeDto {
  @ApiProperty({ type: GitPublicationPreviewDto }) data!: GitPublicationPreviewDto;
}
export class WebhookTargetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) webhookDeliveryId!: string;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) currentServiceId!: string | null;
  @ApiProperty({ format: 'uuid' }) sourceRevisionId!: string;
  @ApiProperty() commitSha!: string;
  @ApiProperty() configRevisionAtReceipt!: number;
  @ApiProperty() policyRevisionAtReceipt!: number;
  @ApiProperty({ type: GitSnapshotTargetDto }) target!: GitSnapshotTargetDto;
  @ApiProperty({ description: '十进制序号，保留数据库精度' }) receiptSequence!: string;
  @ApiProperty() manualRequired!: boolean;
  @ApiProperty({ enum: ['waiting', 'pending', 'ignored', 'orphaned', 'enqueued'] }) state!:
    'waiting' | 'pending' | 'ignored' | 'orphaned' | 'enqueued';
  @ApiProperty() reason!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) deploymentId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) admittedAt!: string | null;
  @ApiProperty() canPreview!: boolean;
  @ApiProperty({ type: String, nullable: true }) blockedReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class WebhookTargetListDto {
  @ApiProperty({ type: [WebhookTargetDto] }) data!: WebhookTargetDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class WebhookDeliveryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['github'] }) provider!: 'github';
  @ApiProperty() externalDeliveryId!: string;
  @ApiProperty({ format: 'uuid' }) repositoryId!: string;
  @ApiProperty() githubRepositoryId!: string;
  @ApiProperty() event!: string;
  @ApiProperty({ type: String, nullable: true }) ref!: string | null;
  @ApiProperty({ type: String, nullable: true }) afterSha!: string | null;
  @ApiProperty() state!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() duplicateCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) lastReceivedAt!: string;
}
export class WebhookDeliveryListDto {
  @ApiProperty({ type: [WebhookDeliveryDto] }) data!: WebhookDeliveryDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class WebhookDeliveryDetailDto extends WebhookDeliveryDto {
  @ApiProperty({ type: [WebhookTargetDto] }) targets!: WebhookTargetDto[];
  @ApiProperty({ type: PageInfoDto }) targetsPage!: PageInfoDto;
}
export class WebhookDeliveryEnvelopeDto {
  @ApiProperty({ type: WebhookDeliveryDetailDto }) data!: WebhookDeliveryDetailDto;
}
export class WebhookDeliveryQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() repositoryId?: string;
}
export class WebhookRejectionDto {
  @ApiProperty({ format: 'uuid' }) repositoryId!: string;
  @ApiProperty({ format: 'date-time' }) bucket!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() count!: number;
}
export class WebhookRejectionListDto {
  @ApiProperty({ type: [WebhookRejectionDto] }) data!: WebhookRejectionDto[];
  @ApiProperty() truncated!: boolean;
  @ApiProperty() retentionHours!: number;
}
export class WebhookReceiptDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty() duplicate!: boolean;
  @ApiProperty() targetCount!: number;
}
