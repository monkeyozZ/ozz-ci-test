import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto } from '../projects/metadata.dto.js';
import { ImagePlatformDto, ResolvedImageDto } from '../services/configuration.dto.js';

export class BuildEpochDto {
  @ApiProperty() generation!: number;
  @ApiProperty() ownershipEpoch!: number;
}
export class BuildRunDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() runNumber!: number;
  @ApiProperty({ format: 'uuid' }) builderId!: string;
  @ApiProperty({ format: 'uuid' }) builderInstanceId!: string;
  @ApiProperty() specHash!: string;
  @ApiProperty({ type: BuildEpochDto }) epoch!: BuildEpochDto;
  @ApiProperty() phase!: string;
  @ApiProperty({ enum: ['prepared', 'open', 'never_submitted', 'ended'] }) executionState!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) executionClosedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) closureReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) submissionAttemptedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) cancelRequestedAt!:
    string | null;
  @ApiProperty() observationState!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastObservedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty() ledgerRevision!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) proofVerifiedAt!:
    string | null;
  @ApiProperty() logsTruncated!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) logsExpireAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class NoBuildArtifactDto {
  @ApiProperty({ enum: ['none'] }) state!: 'none';
}
export class BuildArtifactDestinationDto {
  @ApiProperty() authority!: string;
  @ApiProperty() repository!: string;
}
export class RetainedBuildArtifactDto {
  @ApiProperty({ enum: ['oci', 'registry'] }) state!: 'oci' | 'registry';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) producedByRunId!: string;
  @ApiProperty({ format: 'uuid' }) sourceRevisionId!: string;
  @ApiProperty() commitSha!: string;
  @ApiProperty() recipeHash!: string;
  @ApiProperty() rootDigest!: string;
  @ApiProperty() rootMediaType!: string;
  @ApiProperty({ type: [ImagePlatformDto] }) platforms!: ImagePlatformDto[];
  @ApiProperty() archiveBytes!: string;
  @ApiProperty({ format: 'date-time' }) archiveExpiresAt!: string;
  @ApiProperty({ format: 'uuid' }) registryConnectionId!: string;
  @ApiProperty({ type: BuildArtifactDestinationDto }) destination!: BuildArtifactDestinationDto;
  @ApiProperty({
    type: ResolvedImageDto,
    nullable: true,
    description: '收到可信push证明后即为registry；验证完成前image可空，不表示可以重建',
  })
  image!: ResolvedImageDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) pushedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastVerifiedAt!:
    string | null;
  @ApiProperty() availability!: string;
}
@ApiExtraModels(NoBuildArtifactDto, RetainedBuildArtifactDto)
export class BuildDetailDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) sourceRevisionId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) reuseArtifactId!: string | null;
  @ApiProperty({ type: [BuildRunDto] }) runs!: BuildRunDto[];
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(NoBuildArtifactDto) },
      { $ref: getSchemaPath(RetainedBuildArtifactDto) },
    ],
    discriminator: {
      propertyName: 'state',
      mapping: {
        none: getSchemaPath(NoBuildArtifactDto),
        oci: getSchemaPath(RetainedBuildArtifactDto),
        registry: getSchemaPath(RetainedBuildArtifactDto),
      },
    },
  })
  artifact!: NoBuildArtifactDto | RetainedBuildArtifactDto;
}
export class BuildLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() runId?: string;
}
export class BuildLogChunkDto {
  @ApiProperty() sequence!: string;
  @ApiProperty() phase!: string;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
  @ApiProperty() content!: string;
  @ApiProperty() truncated!: boolean;
}
export class BuildLogPageDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) runId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) runNumber!: number | null;
  @ApiProperty({ enum: ['builder'] }) source!: 'builder';
  @ApiProperty() available!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['expired', 'not_available', 'not_started'] })
  unavailableReason!: string | null;
  @ApiProperty() truncated!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ type: [BuildLogChunkDto] }) items!: BuildLogChunkDto[];
  @ApiProperty({ type: PageInfoDto }) pageInfo!: PageInfoDto;
}
