import { ApiProperty } from '@nestjs/swagger';
import type { DatabaseSnapshot, DatabaseBindingSnapshot } from '@ozz/control-plane/databases';
import type { VolumeSnapshotReference } from '@ozz/control-plane/storage';
import { VolumeOperationTargetDto } from '../storage/execution.dto.js';
import { DatabaseOutputMappingDto } from '../databases/database.dto.js';

export class ServiceControllerConfigurationDto {
  @ApiProperty({ enum: ['Deployment', 'StatefulSet'] }) kind!: 'Deployment' | 'StatefulSet';
  @ApiProperty({ enum: ['RollingUpdate', 'Recreate', 'OnDelete'] }) strategy!:
    'RollingUpdate' | 'Recreate' | 'OnDelete';
}
export class ServiceTemplateIdentityDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: string;
}
export class ServiceVolumeSnapshotDto implements VolumeSnapshotReference {
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty({ format: 'uuid' }) mountId!: string;
  @ApiProperty() volumeRevision!: number;
  @ApiProperty({ type: VolumeOperationTargetDto }) target!: VolumeOperationTargetDto;
  @ApiProperty() pvcName!: string;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
  @ApiProperty() creationNonce!: string;
  @ApiProperty() storageClassName!: string;
  @ApiProperty({ type: String, nullable: true }) storageClassUid!: string | null;
  @ApiProperty() requestedBytes!: string;
  @ApiProperty() mountPath!: string;
  @ApiProperty() readOnly!: boolean;
}
export class ServiceDatabaseSnapshotDto implements DatabaseSnapshot {
  @ApiProperty({ enum: [1] }) version!: 1;
  @ApiProperty({ format: 'uuid' }) databaseInstanceId!: string;
  @ApiProperty({ format: 'uuid' }) dataVolumeId!: string;
  @ApiProperty({ enum: ['postgresql', 'redis'] }) engine!: DatabaseSnapshot['engine'];
  @ApiProperty() majorVersion!: number;
  @ApiProperty() exactVersion!: string;
  @ApiProperty() image!: string;
  @ApiProperty({ enum: ['docker', 'node-example', 'static-example', 'postgresql', 'redis'] })
  templateId!: DatabaseSnapshot['templateId'];
  @ApiProperty() templateVersion!: string;
  @ApiProperty() dataLayout!: string;
  @ApiProperty({ format: 'uuid' }) credentialRefId!: string;
  @ApiProperty() credentialContentRevision!: number;
  @ApiProperty() username!: string;
  @ApiProperty({ type: String, nullable: true }) databaseName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) redisDatabase!: number | null;
  @ApiProperty() protectionRevision!: number;
}
export class ServiceDatabaseBindingSnapshotDto implements DatabaseBindingSnapshot {
  @ApiProperty({ enum: [1] }) version!: 1;
  @ApiProperty({ format: 'uuid' }) bindingId!: string;
  @ApiProperty({ format: 'uuid' }) databaseInstanceId!: string;
  @ApiProperty({ format: 'uuid' }) providerServiceId!: string;
  @ApiProperty({ format: 'uuid' }) providerDeploymentId!: string;
  @ApiProperty() providerServiceUid!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty() host!: string;
  @ApiProperty() port!: number;
  @ApiProperty({ enum: ['postgresql', 'redis'] }) engine!: DatabaseBindingSnapshot['engine'];
  @ApiProperty({ type: String, nullable: true }) databaseName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) redisDatabase!: number | null;
  @ApiProperty() username!: string;
  @ApiProperty({ format: 'uuid' }) credentialRefId!: string;
  @ApiProperty() credentialContentRevision!: number;
  @ApiProperty({ enum: ['fields', 'url'] }) profile!: 'fields' | 'url';
  @ApiProperty({ type: DatabaseOutputMappingDto }) mapping!: DatabaseOutputMappingDto;
}
