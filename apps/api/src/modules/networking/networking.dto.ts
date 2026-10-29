import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type {
  PlatformSettingsView,
  ClusterNetworkingView,
  ServiceNetworkingView,
  DomainView,
  EligibleHttpPort,
  DomainDnsObservation,
  DomainRouteObservation,
  DomainCertificateObservation,
  NetworkingCapabilities,
} from '@ozz/control-plane/networking';
import { PageQueryDto } from '../../common/pagination.js';
import { PageInfoDto, RevisionDto } from '../projects/metadata.dto.js';

export class NetworkIdentityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}
export class NetworkIssueDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}
export class NetworkTaskDto {
  @ApiProperty({ enum: ['operation', 'deployment'] }) type!: 'operation' | 'deployment';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() status!: string;
}
export class PlatformSettingsDto implements PlatformSettingsView {
  @ApiProperty({ minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, nullable: true }) appsDomainSuffix!: string | null;
  @ApiProperty({ type: String, nullable: true }) acmeEmail!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) updatedAt!: string | null;
}
export class NetworkingCapabilitiesDto implements NetworkingCapabilities {
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ enum: ['ready', 'missing', 'unknown'] })
  ingressClass!: NetworkingCapabilities['ingressClass'];
  @ApiProperty() ingressClassName!: string;
  @ApiProperty({ enum: ['ready', 'missing', 'unknown'] })
  traefikMiddleware!: NetworkingCapabilities['traefikMiddleware'];
  @ApiProperty({ enum: ['ready', 'missing', 'incompatible', 'unknown'] })
  certManager!: NetworkingCapabilities['certManager'];
  @ApiProperty({ type: String, nullable: true }) certManagerVersion!: string | null;
  @ApiProperty({ enum: ['ready', 'insufficient', 'unknown'] })
  permissions!: NetworkingCapabilities['permissions'];
  @ApiProperty({ type: [NetworkIssueDto] }) issues!: NetworkIssueDto[];
}
export class ClusterNetworkingDto implements ClusterNetworkingView {
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, nullable: true }) subdomain!: string | null;
  @ApiProperty({ type: [String] }) entryAddresses!: string[];
  @ApiProperty({ type: String, nullable: true }) cnameTarget!: string | null;
  @ApiProperty({ type: String, nullable: true }) domainSuffix!: string | null;
  @ApiProperty({ enum: ['traefik'] }) ingressClassName!: 'traefik';
  @ApiProperty({ type: NetworkingCapabilitiesDto, nullable: true })
  capabilities!: NetworkingCapabilitiesDto | null;
  @ApiProperty() capabilitiesStale!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) updatedAt!: string | null;
}
export class EligibleHttpPortDto implements EligibleHttpPort {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['http'] }) protocol!: 'http';
  @ApiProperty() containerPort!: number;
  @ApiProperty() servicePort!: number;
  @ApiProperty() publishedConfigRevision!: number;
}
export class DomainDnsObservationDto implements DomainDnsObservation {
  @ApiProperty({ enum: ['unconfigured', 'matched', 'mismatch', 'not_found', 'error'] })
  state!: DomainDnsObservation['state'];
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ type: [String] }) addresses!: string[];
  @ApiProperty({ type: [String] }) cnameChain!: string[];
  @ApiProperty({ type: [String] }) expectedAddresses!: string[];
  @ApiProperty({ type: String, nullable: true }) expectedCname!: string | null;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty() message!: string;
}
export class DomainRouteObservationDto implements DomainRouteObservation {
  @ApiProperty({
    enum: ['pending', 'ready', 'backend_pending', 'missing', 'drifted', 'unknown', 'removed'],
  })
  state!: DomainRouteObservation['state'];
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ type: [String] }) ingressNames!: string[];
  @ApiProperty() backendServiceName!: string;
  @ApiProperty() portName!: string;
  @ApiProperty({ type: Number, nullable: true }) readyEndpoints!: number | null;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty() message!: string;
}
export class DomainCertificateObservationDto implements DomainCertificateObservation {
  @ApiProperty({ enum: ['letsencrypt', 'local_test', 'unknown'] })
  authority!: DomainCertificateObservation['authority'];
  @ApiProperty({
    enum: [
      'pending',
      'issuing',
      'staging_ready',
      'ready',
      'renewing',
      'failed',
      'expired',
      'missing',
      'unknown',
      'removed',
    ],
  })
  state!: DomainCertificateObservation['state'];
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ enum: ['staging', 'production'] }) environment!: 'staging' | 'production';
  @ApiProperty() certificateName!: string;
  @ApiProperty() issuerName!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) notBefore!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) notAfter!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) renewalTime!: string | null;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
  @ApiProperty() message!: string;
}
export class DomainDto implements DomainView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() hostname!: string;
  @ApiProperty({ enum: ['default'] }) kind!: 'default';
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty({ type: EligibleHttpPortDto }) servicePort!: EligibleHttpPortDto;
  @ApiProperty({ type: NetworkIdentityDto }) project!: NetworkIdentityDto;
  @ApiProperty({ type: NetworkIdentityDto }) environment!: NetworkIdentityDto;
  @ApiProperty({ type: NetworkIdentityDto }) cluster!: NetworkIdentityDto;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['active', 'deleting'] }) desiredState!: 'active' | 'deleting';
  @ApiProperty({ enum: ['staging', 'production'] }) certificateEnvironment!:
    'staging' | 'production';
  @ApiProperty({ type: DomainDnsObservationDto, nullable: true })
  dns!: DomainDnsObservationDto | null;
  @ApiProperty({ type: DomainRouteObservationDto, nullable: true })
  route!: DomainRouteObservationDto | null;
  @ApiProperty({ type: DomainCertificateObservationDto, nullable: true })
  certificate!: DomainCertificateObservationDto | null;
  @ApiProperty() observationStale!: boolean;
  @ApiProperty({ type: NetworkTaskDto, nullable: true }) activeTask!: NetworkTaskDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastErrorMessage!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class ServiceNetworkingDto implements ServiceNetworkingView {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceRevision!: number;
  @ApiProperty({ type: Number, nullable: true }) publishedConfigRevision!: number | null;
  @ApiProperty({ type: NetworkIdentityDto }) project!: NetworkIdentityDto;
  @ApiProperty({ type: NetworkIdentityDto }) environment!: NetworkIdentityDto;
  @ApiProperty({ type: NetworkIdentityDto }) cluster!: NetworkIdentityDto;
  @ApiProperty({ type: [EligibleHttpPortDto] }) eligiblePorts!: EligibleHttpPortDto[];
  @ApiProperty({ type: [NetworkIssueDto] }) blockers!: NetworkIssueDto[];
  @ApiProperty({ type: PlatformSettingsDto }) platformSettings!: PlatformSettingsDto;
  @ApiProperty({ type: ClusterNetworkingDto }) clusterNetworking!: ClusterNetworkingDto;
  @ApiProperty({ type: [DomainDto] }) domains!: DomainDto[];
}

export class InitialNetworkingRevisionDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  revision!: number;
}
export class UpdatePlatformSettingsDto extends InitialNetworkingRevisionDto {
  @ApiProperty({ type: String, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(1024)
  appsDomainSuffix!: string | null;
  @ApiProperty({ type: String, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(254)
  acmeEmail!: string | null;
}
export class UpdateClusterNetworkingDto extends InitialNetworkingRevisionDto {
  @ApiProperty() @IsString() @MaxLength(256) subdomain!: string;
  @ApiProperty({ type: [String], maxItems: 8 })
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  entryAddresses!: string[];
  @ApiProperty({ type: String, nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(1024)
  cnameTarget!: string | null;
}
export class CreateDomainDto extends RevisionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() portId!: string;
}
export class DomainQueryDto extends OmitType(PageQueryDto, ['search'] as const) {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(253) search?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() environmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() clusterId?: string;
}
export class PlatformSettingsEnvelopeDto {
  @ApiProperty({ type: PlatformSettingsDto }) data!: PlatformSettingsDto;
}
export class ClusterNetworkingEnvelopeDto {
  @ApiProperty({ type: ClusterNetworkingDto }) data!: ClusterNetworkingDto;
}
export class ServiceNetworkingEnvelopeDto {
  @ApiProperty({ type: ServiceNetworkingDto }) data!: ServiceNetworkingDto;
}
export class DomainEnvelopeDto {
  @ApiProperty({ type: DomainDto }) data!: DomainDto;
}
export class DomainListDto {
  @ApiProperty({ type: [DomainDto] }) data!: DomainDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}
