import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type {
  ClusterStorageView,
  CreateManualDataRecordInput,
  ManualDataIdentity,
  ManualDataRecordView,
  StorageCapabilities,
  StorageClassObservation,
  StoragePodMount,
  StorageVolumeObservation,
  VolumeDeletionPreview,
  VolumeMountCollection,
  VolumeMountView,
  VolumeView,
} from '@ozz/control-plane/storage';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto, ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { OperationDto } from '../operations/operation.dto.js';

export class StorageIdentityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}
export class StorageIssueDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}
export class StorageClassDto implements StorageClassObservation {
  @ApiProperty() name!: string;
  @ApiProperty() uid!: string;
  @ApiProperty() provisioner!: string;
  @ApiProperty({ type: String, enum: ['Immediate', 'WaitForFirstConsumer'], nullable: true })
  bindingMode!: StorageClassObservation['bindingMode'];
  @ApiProperty({ type: String, enum: ['Delete', 'Retain'], nullable: true })
  reclaimPolicy!: StorageClassObservation['reclaimPolicy'];
  @ApiProperty() default!: boolean;
  @ApiProperty() supported!: boolean;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty() message!: string;
  @ApiProperty({ enum: ['unsupported', 'unknown'] })
  hardQuotaSupport!: StorageClassObservation['hardQuotaSupport'];
  @ApiProperty() allowVolumeExpansion!: boolean;
}
export class StorageProvisionerDto {
  @ApiProperty({ enum: ['ready', 'missing', 'unknown'] })
  state!: StorageCapabilities['provisioner']['state'];
  @ApiProperty({ type: String, nullable: true }) version!: string | null;
}
export class StorageCapabilitiesDto implements StorageCapabilities {
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ type: [StorageClassDto] }) storageClasses!: StorageClassDto[];
  @ApiProperty() truncated!: boolean;
  @ApiProperty({ type: StorageProvisionerDto }) provisioner!: StorageProvisionerDto;
  @ApiProperty({ enum: ['ready', 'insufficient', 'unknown'] })
  permissions!: StorageCapabilities['permissions'];
  @ApiProperty({ type: [StorageIssueDto] }) issues!: StorageIssueDto[];
}
export class ClusterStorageDto implements ClusterStorageView {
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ type: StorageCapabilitiesDto, nullable: true })
  capabilities!: StorageCapabilitiesDto | null;
  @ApiProperty({ type: [StorageClassDto] }) storageClasses!: StorageClassDto[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) observedAt!: string | null;
  @ApiProperty() stale!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
}
export class VolumeSummaryDto extends StorageIdentityDto {
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) destroyedAt!: string | null;
}
export class VolumeMountDto implements VolumeMountView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) serviceId!: string | null;
  @ApiProperty({ type: StorageIdentityDto, nullable: true }) service!: StorageIdentityDto | null;
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty({ type: VolumeSummaryDto }) volume!: VolumeSummaryDto;
  @ApiProperty() mountPath!: string;
  @ApiProperty() readOnly!: boolean;
  @ApiProperty() desired!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) lastPublishedDeploymentId!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) detachedAt!: string | null;
}
export class VolumeMountCollectionDto implements VolumeMountCollection {
  @ApiProperty({ type: [VolumeMountDto] }) data!: VolumeMountDto[];
  @ApiProperty() serviceRevision!: number;
  @ApiProperty() configRevision!: number;
}
export class VolumeControllerDto {
  @ApiProperty() kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty() uid!: string;
}
export class StoragePodMountDto implements StoragePodMount {
  @ApiProperty() podName!: string;
  @ApiProperty() podUid!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty({ type: String, nullable: true }) nodeName!: string | null;
  @ApiProperty() phase!: string;
  @ApiProperty() deleting!: boolean;
  @ApiProperty() readOnly!: boolean;
  @ApiProperty({ type: [String] }) paths!: string[];
  @ApiProperty({ type: String, nullable: true }) serviceId!: string | null;
  @ApiProperty({ type: VolumeControllerDto, nullable: true })
  controller!: VolumeControllerDto | null;
}
export class VolumeMountGroupsDto {
  @ApiProperty({ type: [VolumeMountDto] }) desired!: VolumeMountDto[];
  @ApiProperty({ type: [VolumeMountDto] }) published!: VolumeMountDto[];
  @ApiProperty({ type: [StoragePodMountDto] }) actual!: StoragePodMountDto[];
  @ApiProperty() truncated!: boolean;
}
export class VolumePvcDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) uid!: string | null;
  @ApiProperty({ type: String, nullable: true }) resourceVersion!: string | null;
  @ApiProperty({ enum: ['Pending', 'Bound', 'Lost', 'Unknown', 'Missing'] })
  phase!: StorageVolumeObservation['pvc']['phase'];
  @ApiProperty() deleting!: boolean;
}
export class VolumePvDto {
  @ApiProperty() name!: string;
  @ApiProperty() uid!: string;
  @ApiProperty() claimUid!: string;
  @ApiProperty({ type: String, nullable: true }) capacityBytes!: string | null;
  @ApiProperty({ type: String, enum: ['Delete', 'Retain'], nullable: true }) reclaimPolicy!:
    'Delete' | 'Retain' | null;
  @ApiProperty() storageClassName!: string;
  @ApiProperty() provisioner!: string;
  @ApiProperty({ type: Object, nullable: true, additionalProperties: true }) nodeAffinity!: unknown;
}
export class VolumeNodeDto {
  @ApiProperty() name!: string;
  @ApiProperty() uid!: string;
  @ApiProperty({ type: Boolean, nullable: true }) ready!: boolean | null;
}
export class VolumeUsageDto {
  @ApiProperty({ type: String, nullable: true }) usedBytes!: string | null;
  @ApiProperty({ type: String, nullable: true }) nodeAvailableBytes!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) observedAt!: string | null;
}
export class VolumeObservationDto {
  @ApiProperty({ enum: ['pending', 'ready', 'missing', 'drifted', 'unknown', 'destroyed'] })
  state!: StorageVolumeObservation['state'];
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) observedAt!: string | null;
  @ApiProperty() stale!: boolean;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty() message!: string;
}
export class VolumeMaintenanceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['backup', 'restore'] }) purpose!: 'backup' | 'restore';
  @ApiProperty({ enum: ['entering', 'active', 'exiting', 'failed', 'closed'] }) state!: NonNullable<
    VolumeView['maintenance']
  >['state'];
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) enteredAt!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) releasedAt!: string | null;
  @ApiProperty() overdue!: boolean;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: [StorageIssueDto] }) exitBlockers!: StorageIssueDto[];
}
export class VolumeTaskDto {
  @ApiProperty({ enum: ['operation', 'deployment'] }) type!: 'operation' | 'deployment';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() status!: string;
}
export class RetainedDatabaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) serviceId!: string | null;
  @ApiProperty() engine!: string;
  @ApiProperty() majorVersion!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) initializedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) initializationFenceAt!:
    string | null;
}
export class ManualDataIdentityDto implements ManualDataIdentity {
  @ApiProperty({ format: 'uuid' }) @IsUUID() installationId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() clusterId!: string;
  @ApiProperty() @IsString() @MaxLength(128) kubeSystemUid!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() environmentId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() volumeId!: string;
  @ApiProperty() @IsString() @MaxLength(128) pvcUid!: string;
}
export class ManualDataTimeDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(40)
  from!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(40)
  to!: string | null;
  @ApiProperty() @IsString() @MaxLength(500) description!: string;
}
export class CreateManualDataRecordDto implements CreateManualDataRecordInput {
  @ApiProperty({ enum: ['backup', 'restore'] }) @IsIn(['backup', 'restore']) type!:
    'backup' | 'restore';
  @ApiProperty({ format: 'uuid' }) @IsUUID() backupId!: string;
  @ApiProperty({ type: ManualDataIdentityDto })
  @ValidateNested()
  @Type(() => ManualDataIdentityDto)
  source!: ManualDataIdentityDto;
  @ApiProperty({ type: ManualDataIdentityDto, nullable: true })
  @ValidateIf((_o, value) => value !== null)
  @ValidateNested()
  @Type(() => ManualDataIdentityDto)
  target!: ManualDataIdentityDto | null;
  @ApiProperty({ enum: ['postgresql', 'redis', 'files'] })
  @IsIn(['postgresql', 'redis', 'files'])
  engine!: 'postgresql' | 'redis' | 'files';
  @ApiProperty() @IsString() @MaxLength(80) engineVersion!: string;
  @ApiProperty() @IsString() @MaxLength(100) dataLayout!: string;
  @ApiProperty() @IsString() @MaxLength(80) format!: string;
  @ApiProperty() @IsString() @MaxLength(120) toolVersion!: string;
  @ApiProperty({ type: String }) @IsString() @Matches(/^[1-9][0-9]{0,15}$/u) sizeBytes!: string;
  @ApiProperty() @IsString() @Matches(/^[a-f0-9]{64}$/u) sha256!: string;
  @ApiProperty({ format: 'date-time' }) @IsString() @MaxLength(40) startedAt!: string;
  @ApiProperty({ format: 'date-time' }) @IsString() @MaxLength(40) completedAt!: string;
  @ApiProperty({ type: ManualDataTimeDto })
  @ValidateNested()
  @Type(() => ManualDataTimeDto)
  dataTime!: ManualDataTimeDto;
  @ApiProperty() @IsString() @MaxLength(300) offHostLocationLabel!: string;
  @ApiProperty({ enum: ['passed', 'failed', 'unknown'] })
  @IsIn(['passed', 'failed', 'unknown'])
  integrity!: 'passed' | 'failed' | 'unknown';
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  verificationSteps!: string[];
  @ApiProperty({ enum: ['passed', 'failed', 'incomplete'] })
  @IsIn(['passed', 'failed', 'incomplete'])
  result!: 'passed' | 'failed' | 'incomplete';
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  evidenceReferences!: string[];
}
export class ManualDataRecordDto extends CreateManualDataRecordDto implements ManualDataRecordView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) actorId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ enum: ['operator_reported'] }) verificationSource!: 'operator_reported';
  @ApiProperty() durationMs!: number;
}
export class VolumeDto implements VolumeView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: StorageIdentityDto, nullable: true }) project!: StorageIdentityDto | null;
  @ApiProperty({ type: StorageIdentityDto, nullable: true })
  environment!: StorageIdentityDto | null;
  @ApiProperty({ type: StorageIdentityDto, nullable: true }) cluster!: StorageIdentityDto | null;
  @ApiProperty() namespace!: string;
  @ApiProperty({ type: String }) requestedBytes!: string;
  @ApiProperty() storageClassName!: string;
  @ApiProperty({ type: String, nullable: true }) storageClassUid!: string | null;
  @ApiProperty({ type: StorageClassDto, nullable: true }) storageClass!: StorageClassDto | null;
  @ApiProperty({ enum: ['unsupported', 'unknown'] }) hardQuotaSupport!: 'unsupported' | 'unknown';
  @ApiProperty({ enum: ['active', 'destroying', 'destroyed'] })
  desiredState!: VolumeView['desiredState'];
  @ApiProperty() retained!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) destroyedAt!: string | null;
  @ApiProperty({ type: VolumePvcDto }) pvc!: VolumePvcDto;
  @ApiProperty({ type: VolumePvDto, nullable: true }) pv!: VolumePvDto | null;
  @ApiProperty({ enum: ['waiting_for_consumer', 'verified', 'unavailable', 'unknown'] })
  locality!: VolumeView['locality'];
  @ApiProperty({ type: [VolumeNodeDto] }) nodes!: VolumeNodeDto[];
  @ApiProperty({ type: VolumeUsageDto }) usage!: VolumeUsageDto;
  @ApiProperty({ type: VolumeMountGroupsDto }) mounts!: VolumeMountGroupsDto;
  @ApiProperty({ type: VolumeObservationDto }) observation!: VolumeObservationDto;
  @ApiProperty({ type: VolumeMaintenanceDto, nullable: true })
  maintenance!: VolumeMaintenanceDto | null;
  @ApiProperty({ type: VolumeTaskDto, nullable: true }) activeTask!: VolumeTaskDto | null;
  @ApiProperty({ type: [StorageIssueDto] }) deletionBlockers!: StorageIssueDto[];
  @ApiProperty({ type: RetainedDatabaseDto, nullable: true })
  retainedDatabase!: RetainedDatabaseDto | null;
  @ApiProperty({ type: ManualDataIdentityDto, nullable: true })
  manualDataIdentity!: ManualDataIdentityDto | null;
  @ApiProperty({ type: ManualDataRecordDto, nullable: true })
  lastManualBackupRecord!: ManualDataRecordDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorMessage!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class VolumeDeletionPreviewDto implements VolumeDeletionPreview {
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() volumeName!: string;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
  @ApiProperty() pvcName!: string;
  @ApiProperty({ type: String, nullable: true }) pvName!: string | null;
  @ApiProperty({ type: String, enum: ['Delete', 'Retain'], nullable: true }) reclaimPolicy!:
    'Delete' | 'Retain' | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) observedAt!: string | null;
  @ApiProperty() previewDigest!: string;
  @ApiProperty({ type: [StorageIssueDto] }) blockers!: StorageIssueDto[];
  @ApiProperty() retained!: boolean;
  @ApiProperty({ type: RetainedDatabaseDto, nullable: true })
  retainedDatabase!: RetainedDatabaseDto | null;
  @ApiProperty({ type: ManualDataRecordDto, nullable: true })
  lastManualBackupRecord!: ManualDataRecordDto | null;
}
export class CreateVolumeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() environmentId!: string;
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiProperty() @IsString() @MaxLength(63) slug!: string;
  @ApiProperty() @IsString() @MaxLength(253) storageClassName!: string;
  @ApiProperty({ type: String, example: '1073741824' })
  @IsString()
  @Matches(/^[1-9][0-9]{0,15}$/u)
  requestedBytes!: string;
}
export class SaveVolumeMountDto extends RevisionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() volumeId!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) volumeRevision!: number;
  @ApiProperty() @IsString() @MaxLength(512) mountPath!: string;
  @ApiProperty() @IsBoolean() readOnly!: boolean;
}
export class VolumeDeletionConfirmationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() volumeId!: string;
  @ApiProperty({ type: String, nullable: true })
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(128)
  pvcUid!: string | null;
  @ApiProperty({ type: String, enum: ['Delete', 'Retain'], nullable: true })
  @ValidateIf((_o, value) => value !== null)
  @IsIn(['Delete', 'Retain'])
  reclaimPolicy!: 'Delete' | 'Retain' | null;
  @ApiProperty() @IsString() @Matches(/^[a-f0-9]{64}$/u) previewDigest!: string;
  @ApiProperty() @IsString() @MaxLength(120) volumeName!: string;
}
export class DestroyVolumeDto extends RevisionDto {
  @ApiProperty({ type: VolumeDeletionConfirmationDto })
  @ValidateNested()
  @Type(() => VolumeDeletionConfirmationDto)
  confirmation!: VolumeDeletionConfirmationDto;
}
export class EnterVolumeMaintenanceDto extends RevisionDto {
  @ApiProperty({ enum: ['backup', 'restore'] }) @IsIn(['backup', 'restore']) purpose!:
    'backup' | 'restore';
}
export class ExitVolumeMaintenanceDto extends RevisionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() maintenanceId!: string;
}
export class VolumeQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 }) override limit = 50;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() environmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clusterId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  retained?: boolean;
}
export class ManualDataRecordQueryDto extends OmitType(PageQueryDto, ['search'] as const) {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 }) override limit = 50;
  @ApiPropertyOptional({ enum: ['backup', 'restore'] })
  @IsOptional()
  @IsIn(['backup', 'restore'])
  type?: 'backup' | 'restore';
}
export class VolumeMountParamsDto extends ResourceParamsDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() mountId!: string;
}
export class ClusterStorageEnvelopeDto {
  @ApiProperty({ type: ClusterStorageDto }) data!: ClusterStorageDto;
}
export class VolumeEnvelopeDto {
  @ApiProperty({ type: VolumeDto }) data!: VolumeDto;
}
export class VolumeListDto {
  @ApiProperty({ type: [VolumeDto] }) data!: VolumeDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
export class VolumeCreationDto {
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty({ type: OperationDto }) operation!: OperationDto;
}
export class VolumeCreationEnvelopeDto {
  @ApiProperty({ type: VolumeCreationDto }) data!: VolumeCreationDto;
}
export class VolumeDeletionPreviewEnvelopeDto {
  @ApiProperty({ type: VolumeDeletionPreviewDto }) data!: VolumeDeletionPreviewDto;
}
export class ManualDataRecordEnvelopeDto {
  @ApiProperty({ type: ManualDataRecordDto }) data!: ManualDataRecordDto;
}
export class ManualDataRecordListDto {
  @ApiProperty({ type: [ManualDataRecordDto] }) data!: ManualDataRecordDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
