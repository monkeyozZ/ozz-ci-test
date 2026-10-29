BEGIN;

-- Removing a Cluster registration retains its resource identities and receipts.
-- targetJson keeps the original installation/cluster identity; a later registration
-- must never treat a detached ledger row as its own inventory.
ALTER TABLE "ManagedResource" DROP CONSTRAINT "ManagedResource_clusterId_fkey";
ALTER TABLE "ManagedResource" ALTER COLUMN "clusterId" DROP NOT NULL;
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_clusterId_fkey"
    FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "appsDomainSuffix" VARCHAR(253),
    "acmeEmail" VARCHAR(254),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterNetworking" (
    "clusterId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "subdomain" VARCHAR(63) NOT NULL,
    "entryAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cnameTarget" VARCHAR(253),
    "capabilitiesJson" JSONB,
    "capabilitiesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterNetworking_pkey" PRIMARY KEY ("clusterId")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "servicePortId" UUID NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'default',
    "targetJson" JSONB NOT NULL,
    "portJson" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "desiredState" VARCHAR(16) NOT NULL DEFAULT 'active',
    "certificateEnvironment" VARCHAR(16) NOT NULL DEFAULT 'staging',
    "dnsJson" JSONB,
    "routeJson" JSONB,
    "certificateJson" JSONB,
    "lastObservedAt" TIMESTAMP(3),
    "observationErrorCode" VARCHAR(80),
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(80),
    "lastErrorMessage" VARCHAR(1000),
    "nextObservationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationLeaseToken" UUID,
    "observationLeaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkManagedResource" (
    "id" UUID NOT NULL,
    "clusterId" UUID,
    "domainId" UUID,
    "apiVersion" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "namespace" VARCHAR(63) NOT NULL,
    "name" VARCHAR(253) NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "ledgerVersion" INTEGER NOT NULL DEFAULT 0,
    "targetJson" JSONB NOT NULL,
    "creationNonce" UUID NOT NULL,
    "creationAttempted" BOOLEAN NOT NULL DEFAULT false,
    "uid" VARCHAR(128),
    "resourceVersion" VARCHAR(128),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "receiptJson" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkManagedResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClusterNetworking_subdomain_key" ON "ClusterNetworking"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_serviceId_key" ON "Domain"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

-- CreateIndex
CREATE INDEX "Domain_createdAt_id_idx" ON "Domain"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Domain_nextObservationAt_idx" ON "Domain"("nextObservationAt");

-- CreateIndex
CREATE INDEX "NetworkManagedResource_domainId_idx" ON "NetworkManagedResource"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkManagedResource_clusterId_kind_namespace_name_key" ON "NetworkManagedResource"("clusterId", "kind", "namespace", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePort_id_serviceId_key" ON "ServicePort"("id", "serviceId");

-- AddForeignKey
ALTER TABLE "ClusterNetworking" ADD CONSTRAINT "ClusterNetworking_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_servicePortId_serviceId_fkey" FOREIGN KEY ("servicePortId", "serviceId") REFERENCES "ServicePort"("id", "serviceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkManagedResource" ADD CONSTRAINT "NetworkManagedResource_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkManagedResource" ADD CONSTRAINT "NetworkManagedResource_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Global names are stored in their ASCII/lowercase form, so ordinary uniqueness
-- also covers casing and a service cannot bind another service's port identity.
ALTER TABLE "PlatformSettings"
    ADD CONSTRAINT "PlatformSettings_singleton" CHECK ("id" = 1),
    ADD CONSTRAINT "PlatformSettings_revision_positive" CHECK ("revision" > 0),
    ADD CONSTRAINT "PlatformSettings_suffix_normalized" CHECK ("appsDomainSuffix" IS NULL OR ("appsDomainSuffix" = lower("appsDomainSuffix") AND "appsDomainSuffix" ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'));
ALTER TABLE "ClusterNetworking"
    ALTER COLUMN "entryAddresses" SET NOT NULL,
    ADD CONSTRAINT "ClusterNetworking_revision_positive" CHECK ("revision" > 0),
    ADD CONSTRAINT "ClusterNetworking_subdomain_normalized" CHECK ("subdomain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
    ADD CONSTRAINT "ClusterNetworking_entry_bounds" CHECK (cardinality("entryAddresses") <= 8 AND (cardinality("entryAddresses") > 0 OR "cnameTarget" IS NOT NULL));
ALTER TABLE "Domain"
    ADD CONSTRAINT "Domain_revision_positive" CHECK ("revision" > 0),
    ADD CONSTRAINT "Domain_default_kind" CHECK ("kind" = 'default'),
    ADD CONSTRAINT "Domain_desired_state" CHECK ("desiredState" IN ('active', 'deleting')),
    ADD CONSTRAINT "Domain_certificate_environment" CHECK ("certificateEnvironment" IN ('staging', 'production')),
    ADD CONSTRAINT "Domain_hostname_normalized" CHECK ("hostname" = lower("hostname") AND "hostname" ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$');
ALTER TABLE "NetworkManagedResource"
    ADD CONSTRAINT "NetworkManagedResource_scope" CHECK ("scope" IN ('domain', 'environment', 'cluster')),
    ADD CONSTRAINT "NetworkManagedResource_ledger_version" CHECK ("ledgerVersion" >= 0),
    ADD CONSTRAINT "NetworkManagedResource_revision" CHECK ("revision" >= 0);

COMMIT;
