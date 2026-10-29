-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "bootstrapConfig" JSONB,
ADD COLUMN     "bootstrapServerId" UUID,
ADD COLUMN     "caFingerprint" VARCHAR(128),
ADD COLUMN     "connectionRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "kubeSystemUid" VARCHAR(128),
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorCode" VARCHAR(80),
ADD COLUMN     "lastErrorMessage" VARCHAR(1000),
ADD COLUMN     "nextObservationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "observationFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "observationJson" JSONB,
ADD COLUMN     "observationLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "observationLeaseToken" UUID;

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "candidateCredentialRefId" UUID,
ADD COLUMN     "clusterId" UUID,
ADD COLUMN     "serverId" UUID;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "connectionRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "hostKeyAlgorithm" VARCHAR(80),
ADD COLUMN     "hostKeyDiscoveryOperationId" UUID,
ADD COLUMN     "hostKeyFingerprint" VARCHAR(128),
ADD COLUMN     "hostKeyTrustSource" VARCHAR(500),
ADD COLUMN     "hostKeyTrustedAt" TIMESTAMP(3),
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorCode" VARCHAR(80),
ADD COLUMN     "lastErrorMessage" VARCHAR(1000),
ADD COLUMN     "machineId" VARCHAR(128),
ADD COLUMN     "observedHostKeyAlgorithm" VARCHAR(80),
ADD COLUMN     "observedHostKeyAt" TIMESTAMP(3),
ADD COLUMN     "observedHostKeyFingerprint" VARCHAR(128),
ADD COLUMN     "preflightAt" TIMESTAMP(3),
ADD COLUMN     "preflightJson" JSONB;

-- CreateTable
CREATE TABLE "Node" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "uid" VARCHAR(128) NOT NULL,
    "name" VARCHAR(253) NOT NULL,
    "serverId" UUID,
    "snapshotJson" JSONB NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Node_serverId_idx" ON "Node"("serverId");

-- CreateIndex
CREATE INDEX "Node_createdAt_id_idx" ON "Node"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Node_clusterId_uid_key" ON "Node"("clusterId", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_kubeSystemUid_key" ON "Cluster"("kubeSystemUid");

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_bootstrapServerId_key" ON "Cluster"("bootstrapServerId");

-- CreateIndex
CREATE INDEX "Cluster_nextObservationAt_idx" ON "Cluster"("nextObservationAt");

-- CreateIndex
CREATE INDEX "Operation_serverId_createdAt_idx" ON "Operation"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_clusterId_createdAt_idx" ON "Operation"("clusterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Server_machineId_key" ON "Server"("machineId");

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_bootstrapServerId_fkey" FOREIGN KEY ("bootstrapServerId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_candidateCredentialRefId_fkey" FOREIGN KEY ("candidateCredentialRefId") REFERENCES "SecretReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PostgreSQL, not a process-local mutex, serializes active work per resource.
CREATE UNIQUE INDEX "Operation_active_server_key" ON "Operation" ("serverId") WHERE "serverId" IS NOT NULL AND "status" IN ('queued', 'running');
CREATE UNIQUE INDEX "Operation_active_cluster_key" ON "Operation" ("clusterId") WHERE "clusterId" IS NOT NULL AND "status" IN ('queued', 'running');
ALTER TABLE "Server" ADD CONSTRAINT "Server_connectionRevision_positive" CHECK ("connectionRevision" > 0);
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_connectionRevision_positive" CHECK ("connectionRevision" > 0);
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_observationFailures_nonnegative" CHECK ("observationFailures" >= 0);
