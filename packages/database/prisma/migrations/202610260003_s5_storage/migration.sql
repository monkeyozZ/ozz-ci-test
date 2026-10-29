BEGIN;

-- AlterTable
ALTER TABLE "SecretReference" ADD COLUMN     "contentRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "storageCapabilitiesAt" TIMESTAMP(3),
ADD COLUMN     "storageCapabilitiesJson" JSONB,
ADD COLUMN     "storageLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "storageErrorCode" VARCHAR(80),
ADD COLUMN     "storageLeaseToken" UUID,
ADD COLUMN     "storageLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "storageNextObservationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Service" ADD COLUMN "templateId" VARCHAR(64), ADD COLUMN "templateVersion" VARCHAR(64),
  ADD CONSTRAINT "Service_template_pair" CHECK (("templateId" IS NULL) = ("templateVersion" IS NULL));

-- VolumeMutation owns per-volume exclusion. Only server/cluster work occupies
-- this slot, so independent data tasks can coexist with each other and cluster_sync.
DROP INDEX "Operation_active_cluster_key";
CREATE UNIQUE INDEX "Operation_active_cluster_key" ON "Operation" ("clusterId")
  WHERE "clusterId" IS NOT NULL AND "scope" IN ('server', 'cluster') AND "status" IN ('queued', 'running');

-- CreateTable
CREATE TABLE "Volume" (
    "id" UUID NOT NULL,
    "environmentId" UUID,
    "clusterId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "targetJson" JSONB NOT NULL,
    "namespace" VARCHAR(63) NOT NULL,
    "requestedBytes" BIGINT NOT NULL,
    "storageClassName" VARCHAR(253) NOT NULL,
    "storageClassUid" VARCHAR(128),
    "volumeMode" VARCHAR(16) NOT NULL DEFAULT 'Filesystem',
    "accessModes" TEXT[] DEFAULT ARRAY['ReadWriteOnce']::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "mutationRevision" INTEGER NOT NULL DEFAULT 0,
    "ledgerVersion" INTEGER NOT NULL DEFAULT 0,
    "pvcName" VARCHAR(253) NOT NULL,
    "creationNonce" UUID NOT NULL,
    "creationAttempted" BOOLEAN NOT NULL DEFAULT false,
    "pvcUid" VARCHAR(128),
    "resourceVersion" VARCHAR(128),
    "specFingerprint" CHAR(64),
    "receiptJson" JSONB,
    "deletionIntentJson" JSONB,
    "destroyedAt" TIMESTAMP(3),
    "observationJson" JSONB,
    "lastObservedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "observationErrorCode" VARCHAR(80),
    "lastErrorCode" VARCHAR(80),
    "lastErrorMessage" VARCHAR(1000),
    "nextObservationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationLeaseToken" UUID,
    "observationLeaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Volume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolumeMount" (
    "id" UUID NOT NULL,
    "serviceId" UUID,
    "volumeId" UUID NOT NULL,
    "mountPath" VARCHAR(512) NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "desired" BOOLEAN NOT NULL DEFAULT true,
    "detachedAt" TIMESTAMP(3),
    "lastPublishedDeploymentId" UUID,
    "originalServiceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolumeMount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolumeMutation" (
    "volumeId" UUID NOT NULL,
    "operationId" UUID,
    "deploymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolumeMutation_pkey" PRIMARY KEY ("volumeId")
);

-- CreateTable
CREATE TABLE "VolumeMaintenance" (
    "id" UUID NOT NULL,
    "volumeId" UUID NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'entering',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "intentJson" JSONB NOT NULL,
    "enteredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "exitedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolumeMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatabaseInstance" (
    "id" UUID NOT NULL,
    "serviceId" UUID,
    "dataVolumeId" UUID NOT NULL,
    "originalServiceJson" JSONB NOT NULL,
    "engine" VARCHAR(16) NOT NULL,
    "majorVersion" INTEGER NOT NULL,
    "exactVersion" VARCHAR(80) NOT NULL,
    "templateId" VARCHAR(64) NOT NULL,
    "templateVersion" VARCHAR(64) NOT NULL,
    "image" VARCHAR(2048) NOT NULL,
    "dataLayout" VARCHAR(100) NOT NULL,
    "credentialRefId" UUID NOT NULL,
    "credentialContentRevision" INTEGER NOT NULL DEFAULT 1,
    "username" VARCHAR(63) NOT NULL,
    "databaseName" VARCHAR(63),
    "redisDatabase" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "protectionRevision" INTEGER NOT NULL DEFAULT 0,
    "initializationFenceAt" TIMESTAMP(3),
    "initializationIntentJson" JSONB,
    "initializationPvcUid" VARCHAR(128),
    "initializedAt" TIMESTAMP(3),
    "initializationState" VARCHAR(24) NOT NULL DEFAULT 'not_started',
    "observationJson" JSONB,
    "lastObservedAt" TIMESTAMP(3),
    "observationErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatabaseInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatabaseBinding" (
    "id" UUID NOT NULL,
    "consumerServiceId" UUID NOT NULL,
    "databaseInstanceId" UUID NOT NULL,
    "profile" VARCHAR(16) NOT NULL,
    "mappingJson" JSONB NOT NULL,
    "desired" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatabaseBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentVolumeReference" (
    "deploymentId" UUID NOT NULL,
    "volumeId" UUID NOT NULL,
    "referenceJson" JSONB NOT NULL,
    "resolutionJson" JSONB,

    CONSTRAINT "DeploymentVolumeReference_pkey" PRIMARY KEY ("deploymentId","volumeId")
);

-- CreateTable
CREATE TABLE "DeploymentDatabaseReference" (
    "deploymentId" UUID NOT NULL,
    "databaseInstanceId" UUID NOT NULL,
    "bindingId" UUID,
    "referenceJson" JSONB NOT NULL,

    CONSTRAINT "DeploymentDatabaseReference_pkey" PRIMARY KEY ("deploymentId","databaseInstanceId")
);

-- CreateTable
CREATE TABLE "CommandReceipt" (
    "id" UUID NOT NULL,
    "idempotencyScope" VARCHAR(160) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Volume_createdAt_id_idx" ON "Volume"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Volume_nextObservationAt_idx" ON "Volume"("nextObservationAt");

-- CreateIndex
CREATE UNIQUE INDEX "Volume_environmentId_slug_key" ON "Volume"("environmentId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Volume_clusterId_namespace_pvcName_key" ON "Volume"("clusterId", "namespace", "pvcName");

-- CreateIndex
CREATE INDEX "VolumeMount_serviceId_idx" ON "VolumeMount"("serviceId");

-- CreateIndex
CREATE INDEX "VolumeMount_volumeId_idx" ON "VolumeMount"("volumeId");

-- CreateIndex
CREATE INDEX "VolumeMutation_operationId_idx" ON "VolumeMutation"("operationId");

-- CreateIndex
CREATE INDEX "VolumeMutation_deploymentId_idx" ON "VolumeMutation"("deploymentId");

-- CreateIndex
CREATE INDEX "VolumeMaintenance_volumeId_createdAt_idx" ON "VolumeMaintenance"("volumeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseInstance_serviceId_key" ON "DatabaseInstance"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseInstance_dataVolumeId_key" ON "DatabaseInstance"("dataVolumeId");

-- CreateIndex
CREATE INDEX "DatabaseInstance_createdAt_id_idx" ON "DatabaseInstance"("createdAt", "id");

-- CreateIndex
CREATE INDEX "DatabaseInstance_credentialRefId_idx" ON "DatabaseInstance"("credentialRefId");

-- CreateIndex
CREATE INDEX "DatabaseBinding_databaseInstanceId_idx" ON "DatabaseBinding"("databaseInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseBinding_consumerServiceId_databaseInstanceId_key" ON "DatabaseBinding"("consumerServiceId", "databaseInstanceId");

-- CreateIndex
CREATE INDEX "DeploymentVolumeReference_volumeId_idx" ON "DeploymentVolumeReference"("volumeId");

-- CreateIndex
CREATE INDEX "DeploymentDatabaseReference_databaseInstanceId_idx" ON "DeploymentDatabaseReference"("databaseInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "CommandReceipt_idempotencyScope_idempotencyKey_key" ON "CommandReceipt"("idempotencyScope", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeMount" ADD CONSTRAINT "VolumeMount_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeMount" ADD CONSTRAINT "VolumeMount_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeMutation" ADD CONSTRAINT "VolumeMutation_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeMutation" ADD CONSTRAINT "VolumeMutation_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeMutation" ADD CONSTRAINT "VolumeMutation_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeMaintenance" ADD CONSTRAINT "VolumeMaintenance_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatabaseInstance" ADD CONSTRAINT "DatabaseInstance_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatabaseInstance" ADD CONSTRAINT "DatabaseInstance_dataVolumeId_fkey" FOREIGN KEY ("dataVolumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatabaseInstance" ADD CONSTRAINT "DatabaseInstance_credentialRefId_fkey" FOREIGN KEY ("credentialRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatabaseBinding" ADD CONSTRAINT "DatabaseBinding_consumerServiceId_fkey" FOREIGN KEY ("consumerServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatabaseBinding" ADD CONSTRAINT "DatabaseBinding_databaseInstanceId_fkey" FOREIGN KEY ("databaseInstanceId") REFERENCES "DatabaseInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentVolumeReference" ADD CONSTRAINT "DeploymentVolumeReference_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentVolumeReference" ADD CONSTRAINT "DeploymentVolumeReference_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentDatabaseReference" ADD CONSTRAINT "DeploymentDatabaseReference_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentDatabaseReference" ADD CONSTRAINT "DeploymentDatabaseReference_databaseInstanceId_fkey" FOREIGN KEY ("databaseInstanceId") REFERENCES "DatabaseInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentDatabaseReference" ADD CONSTRAINT "DeploymentDatabaseReference_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "DatabaseBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecretReference" ADD CONSTRAINT "SecretReference_content_revision_positive" CHECK ("contentRevision" > 0);
ALTER TABLE "Volume"
  ALTER COLUMN "accessModes" SET NOT NULL,
  ADD CONSTRAINT "Volume_live_target" CHECK ("destroyedAt" IS NOT NULL OR ("environmentId" IS NOT NULL AND "clusterId" IS NOT NULL)),
  ADD CONSTRAINT "Volume_request_bounds" CHECK ("requestedBytes" >= 1048576 AND "requestedBytes" <= 1099511627776),
  ADD CONSTRAINT "Volume_filesystem_rwo" CHECK ("volumeMode" = 'Filesystem' AND "accessModes" = ARRAY['ReadWriteOnce']),
  ADD CONSTRAINT "Volume_revision_bounds" CHECK ("revision" > 0 AND "mutationRevision" >= 0 AND "ledgerVersion" >= 0),
  ADD CONSTRAINT "Volume_uid_requires_intent" CHECK ("pvcUid" IS NULL OR "creationAttempted");
ALTER TABLE "VolumeMount"
  ADD CONSTRAINT "VolumeMount_active_service" CHECK ("detachedAt" IS NOT NULL OR "serviceId" IS NOT NULL),
  ADD CONSTRAINT "VolumeMount_detached_draft" CHECK ("detachedAt" IS NULL OR NOT "desired");
CREATE UNIQUE INDEX "VolumeMount_active_path" ON "VolumeMount" ("serviceId", "mountPath") WHERE "detachedAt" IS NULL;
CREATE UNIQUE INDEX "VolumeMount_active_volume" ON "VolumeMount" ("serviceId", "volumeId") WHERE "detachedAt" IS NULL;
CREATE UNIQUE INDEX "VolumeMount_single_writer" ON "VolumeMount" ("volumeId") WHERE "detachedAt" IS NULL AND NOT "readOnly";
ALTER TABLE "VolumeMutation" ADD CONSTRAINT "VolumeMutation_one_task" CHECK (("operationId" IS NULL) <> ("deploymentId" IS NULL));
ALTER TABLE "VolumeMaintenance"
  ADD CONSTRAINT "VolumeMaintenance_purpose" CHECK ("purpose" IN ('backup', 'restore')),
  ADD CONSTRAINT "VolumeMaintenance_state" CHECK ("state" IN ('entering', 'active', 'exiting', 'failed', 'closed')),
  ADD CONSTRAINT "VolumeMaintenance_revision" CHECK ("revision" > 0),
  ADD CONSTRAINT "VolumeMaintenance_exit" CHECK (("state" = 'closed') = ("exitedAt" IS NOT NULL));
CREATE UNIQUE INDEX "VolumeMaintenance_one_active" ON "VolumeMaintenance" ("volumeId") WHERE "state" <> 'closed';
ALTER TABLE "DatabaseInstance"
  ADD CONSTRAINT "DatabaseInstance_engine" CHECK ("engine" IN ('postgresql', 'redis')),
  ADD CONSTRAINT "DatabaseInstance_revision" CHECK ("revision" > 0 AND "protectionRevision" >= 0 AND "credentialContentRevision" > 0),
  ADD CONSTRAINT "DatabaseInstance_fence" CHECK (("initializationFenceAt" IS NULL) = ("protectionRevision" = 0)),
  ADD CONSTRAINT "DatabaseInstance_initialized_protected" CHECK ("initializedAt" IS NULL OR ("initializationFenceAt" IS NOT NULL AND "initializationPvcUid" IS NOT NULL)),
  ADD CONSTRAINT "DatabaseInstance_engine_parameters" CHECK (
    ("engine" = 'postgresql' AND "databaseName" IS NOT NULL AND "redisDatabase" IS NULL) OR
    ("engine" = 'redis' AND "databaseName" IS NULL AND "redisDatabase" BETWEEN 0 AND 15)
  );
ALTER TABLE "DatabaseBinding" ADD CONSTRAINT "DatabaseBinding_profile" CHECK ("profile" IN ('fields', 'url'));

CREATE FUNCTION "ozz_guard_volume_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."creationAttempted" OR OLD."pvcUid" IS NOT NULL THEN
      RAISE EXCEPTION 'PVC identities and receipts must be retained' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."targetJson" IS DISTINCT FROM OLD."targetJson" OR
     NEW."namespace" IS DISTINCT FROM OLD."namespace" OR NEW."pvcName" IS DISTINCT FROM OLD."pvcName" OR
     NEW."creationNonce" IS DISTINCT FROM OLD."creationNonce" OR NEW."requestedBytes" IS DISTINCT FROM OLD."requestedBytes" OR
     NEW."storageClassName" IS DISTINCT FROM OLD."storageClassName" OR NEW."volumeMode" IS DISTINCT FROM OLD."volumeMode" OR
     NEW."accessModes" IS DISTINCT FROM OLD."accessModes" OR
     (OLD."pvcUid" IS NOT NULL AND NEW."pvcUid" IS DISTINCT FROM OLD."pvcUid") OR
     (OLD."storageClassUid" IS NOT NULL AND NEW."storageClassUid" IS DISTINCT FROM OLD."storageClassUid") OR
     (OLD."creationAttempted" AND NOT NEW."creationAttempted") OR
     (OLD."destroyedAt" IS NOT NULL AND NEW."destroyedAt" IS DISTINCT FROM OLD."destroyedAt") OR
     NEW."ledgerVersion" < OLD."ledgerVersion" OR NEW."mutationRevision" < OLD."mutationRevision" THEN
    RAISE EXCEPTION 'Volume data identity is immutable and monotonic' USING ERRCODE = '23514';
  END IF;
  IF (NEW."environmentId" IS DISTINCT FROM OLD."environmentId" OR NEW."clusterId" IS DISTINCT FROM OLD."clusterId") AND
    NOT (NEW."destroyedAt" IS NOT NULL AND
      (NEW."environmentId" IS NULL OR NEW."environmentId" = OLD."environmentId") AND
      (NEW."clusterId" IS NULL OR NEW."clusterId" = OLD."clusterId")) THEN
    RAISE EXCEPTION 'A live Volume cannot change or lose its target' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Volume_identity_guard" BEFORE UPDATE OR DELETE ON "Volume" FOR EACH ROW EXECUTE FUNCTION "ozz_guard_volume_identity"();

CREATE FUNCTION "ozz_check_volume_relations"(volume_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v "Volume"%ROWTYPE;
  data "DatabaseInstance"%ROWTYPE;
BEGIN
  SELECT * INTO v FROM "Volume" WHERE "id" = volume_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v."destroyedAt" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "Environment" e JOIN "Project" p ON p."id" = e."projectId" JOIN "Cluster" c ON c."id" = p."clusterId"
    WHERE e."id" = v."environmentId" AND c."id" = v."clusterId"
      AND v."targetJson"->>'environmentId' = e."id"::text AND v."targetJson"->>'projectId' = p."id"::text
      AND v."targetJson"->>'clusterId' = c."id"::text AND v."targetJson"->>'kubeSystemUid' = c."kubeSystemUid"
  ) THEN RAISE EXCEPTION 'Volume target does not match its environment' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "VolumeMount" m LEFT JOIN "Service" s ON s."id" = m."serviceId"
    WHERE m."volumeId" = volume_id AND m."detachedAt" IS NULL AND
      (s."id" IS NULL OR s."environmentId" IS DISTINCT FROM v."environmentId" OR v."destroyedAt" IS NOT NULL)
  ) THEN RAISE EXCEPTION 'An active mount requires a live Volume in the same environment' USING ERRCODE = '23514'; END IF;
  SELECT * INTO data FROM "DatabaseInstance" WHERE "dataVolumeId" = volume_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF (v."creationAttempted" OR v."pvcUid" IS NOT NULL) AND data."initializationFenceAt" IS NULL THEN
    RAISE EXCEPTION 'Database data must be protected before PVC creation intent' USING ERRCODE = '23514';
  END IF;
  IF data."serviceId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Service" WHERE "id" = data."serviceId" AND "environmentId" = v."environmentId" AND "kind" = 'database'
  ) THEN RAISE EXCEPTION 'Database service and data Volume must share the same target' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "VolumeMount" WHERE "volumeId" = volume_id AND "detachedAt" IS NULL AND NOT "readOnly"
      AND "serviceId" IS DISTINCT FROM data."serviceId"
  ) THEN RAISE EXCEPTION 'Database data cannot be attached as a generic writable Volume' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "SecretReference" WHERE "id" = data."credentialRefId" AND "kind" = 'database'
      AND "contentRevision" = data."credentialContentRevision"
  ) THEN RAISE EXCEPTION 'Database credential identity is invalid' USING ERRCODE = '23514'; END IF;
END;
$$;

CREATE FUNCTION "ozz_validate_volume_relations"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Volume' THEN
    PERFORM "ozz_check_volume_relations"(NEW."id");
  ELSIF TG_TABLE_NAME = 'DatabaseInstance' THEN
    PERFORM "ozz_check_volume_relations"(NEW."dataVolumeId");
  ELSE
    IF TG_OP <> 'DELETE' THEN PERFORM "ozz_check_volume_relations"(NEW."volumeId"); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM "ozz_check_volume_relations"(OLD."volumeId"); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Volume_target_relations" AFTER INSERT OR UPDATE ON "Volume" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_volume_relations"();
CREATE CONSTRAINT TRIGGER "VolumeMount_target_relations" AFTER INSERT OR UPDATE OR DELETE ON "VolumeMount" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_volume_relations"();
CREATE CONSTRAINT TRIGGER "DatabaseInstance_data_relations" AFTER INSERT OR UPDATE ON "DatabaseInstance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_volume_relations"();

CREATE FUNCTION "ozz_guard_database_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."initializationFenceAt" IS NOT NULL OR EXISTS (SELECT 1 FROM "Volume" WHERE "id" = OLD."dataVolumeId" AND "creationAttempted") THEN
      RAISE EXCEPTION 'Initialized data identity must survive service deletion' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."originalServiceJson" IS DISTINCT FROM OLD."originalServiceJson" OR
    (NEW."serviceId" IS NOT NULL AND NEW."serviceId"::text IS DISTINCT FROM (NEW."originalServiceJson"->>'id')) OR
    (OLD."serviceId" IS NOT NULL AND NEW."serviceId" IS NOT NULL AND NEW."serviceId" IS DISTINCT FROM OLD."serviceId") THEN
    RAISE EXCEPTION 'Database origin cannot be reassigned' USING ERRCODE = '23514';
  END IF;
  IF OLD."serviceId" IS NOT NULL AND NEW."serviceId" IS NULL AND (
    EXISTS (SELECT 1 FROM "DatabaseBinding" b WHERE b."databaseInstanceId" = OLD."id" AND b."desired") OR
    EXISTS (
      SELECT 1 FROM "DeploymentDatabaseReference" r JOIN "Deployment" d ON d."id" = r."deploymentId"
      WHERE r."databaseInstanceId" = OLD."id" AND (d."status" IN ('queued', 'running') OR
        EXISTS (SELECT 1 FROM "Service" s WHERE s."publishedDeploymentId" = d."id"))
    )
  ) THEN RAISE EXCEPTION 'Database consumers must detach before service deletion' USING ERRCODE = '23514'; END IF;
  IF OLD."initializationFenceAt" IS NOT NULL AND (
    NEW."initializationFenceAt" IS DISTINCT FROM OLD."initializationFenceAt" OR
    NEW."protectionRevision" < OLD."protectionRevision" OR NEW."dataVolumeId" IS DISTINCT FROM OLD."dataVolumeId" OR
    NEW."engine" IS DISTINCT FROM OLD."engine" OR NEW."majorVersion" IS DISTINCT FROM OLD."majorVersion" OR
    NEW."image" IS DISTINCT FROM OLD."image" OR NEW."exactVersion" IS DISTINCT FROM OLD."exactVersion" OR
    NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion" OR NEW."initializationIntentJson" IS DISTINCT FROM OLD."initializationIntentJson" OR
    NEW."dataLayout" IS DISTINCT FROM OLD."dataLayout" OR NEW."templateId" IS DISTINCT FROM OLD."templateId" OR
    NEW."credentialRefId" IS DISTINCT FROM OLD."credentialRefId" OR NEW."credentialContentRevision" IS DISTINCT FROM OLD."credentialContentRevision" OR
    NEW."username" IS DISTINCT FROM OLD."username" OR NEW."databaseName" IS DISTINCT FROM OLD."databaseName" OR
    NEW."redisDatabase" IS DISTINCT FROM OLD."redisDatabase" OR
    (OLD."initializationPvcUid" IS NOT NULL AND NEW."initializationPvcUid" IS DISTINCT FROM OLD."initializationPvcUid")
  ) THEN RAISE EXCEPTION 'Database initialization identity is protected' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DatabaseInstance_identity_guard" BEFORE UPDATE OR DELETE ON "DatabaseInstance" FOR EACH ROW EXECUTE FUNCTION "ozz_guard_database_identity"();

CREATE FUNCTION "ozz_guard_database_secret"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DatabaseInstance" WHERE "credentialRefId" = OLD."id") AND
    (NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."contentRevision" IS DISTINCT FROM OLD."contentRevision") THEN
    RAISE EXCEPTION 'A referenced database credential requires explicit engine maintenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SecretReference_database_identity" BEFORE UPDATE ON "SecretReference" FOR EACH ROW EXECUTE FUNCTION "ozz_guard_database_secret"();

CREATE FUNCTION "ozz_validate_database_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DatabaseBinding" b JOIN "Service" s ON s."id" = b."consumerServiceId"
      JOIN "DatabaseInstance" d ON d."id" = b."databaseInstanceId" JOIN "Volume" v ON v."id" = d."dataVolumeId"
    WHERE b."id" = NEW."id" AND b."desired" AND
      (d."serviceId" IS NULL OR s."environmentId" IS DISTINCT FROM v."environmentId" OR s."id" = d."serviceId" OR v."destroyedAt" IS NOT NULL)
  ) THEN RAISE EXCEPTION 'Database bindings require a distinct provider in the same environment' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "DatabaseBinding_target_relations" AFTER INSERT OR UPDATE ON "DatabaseBinding" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_database_binding"();

CREATE FUNCTION "ozz_guard_s5_service_target"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."environmentId" IS DISTINCT FROM OLD."environmentId" AND (
    EXISTS (SELECT 1 FROM "VolumeMount" WHERE "serviceId" = OLD."id" AND "detachedAt" IS NULL) OR
    EXISTS (SELECT 1 FROM "DatabaseInstance" WHERE "serviceId" = OLD."id") OR
    EXISTS (SELECT 1 FROM "DatabaseBinding" WHERE "consumerServiceId" = OLD."id" AND "desired")
  ) THEN RAISE EXCEPTION 'A service with data references cannot change environment' USING ERRCODE = '23514'; END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" AND EXISTS (SELECT 1 FROM "DatabaseInstance" WHERE "serviceId" = OLD."id") THEN
    RAISE EXCEPTION 'A database service cannot change its kind' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Service_s5_target_guard" BEFORE UPDATE ON "Service" FOR EACH ROW EXECUTE FUNCTION "ozz_guard_s5_service_target"();

CREATE FUNCTION "ozz_check_storage_task"(task_type text, task_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  task_status "OperationStatus";
  task_scope text;
  task_input jsonb;
  required_id text;
BEGIN
  IF task_id IS NULL THEN RETURN; END IF;
  IF task_type = 'operation' THEN
    SELECT "status", "scope", "input" INTO task_status, task_scope, task_input FROM "Operation" WHERE "id" = task_id;
  ELSE
    SELECT "status", "scope", "input" INTO task_status, task_scope, task_input FROM "Deployment" WHERE "id" = task_id;
  END IF;
  IF task_status IS NULL THEN RETURN; END IF;
  IF task_status NOT IN ('queued', 'running') THEN
    IF EXISTS (SELECT 1 FROM "VolumeMutation" WHERE (task_type = 'operation' AND "operationId" = task_id) OR (task_type = 'deployment' AND "deploymentId" = task_id)) THEN
      RAISE EXCEPTION 'A terminal task cannot retain an active Volume mutation' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF task_type = 'deployment' AND EXISTS (
    SELECT 1 FROM "DeploymentVolumeReference" r LEFT JOIN "VolumeMutation" m ON m."volumeId" = r."volumeId" AND m."deploymentId" = task_id
    WHERE r."deploymentId" = task_id AND m."volumeId" IS NULL
  ) THEN RAISE EXCEPTION 'Active deployment Volume references require matching mutation slots' USING ERRCODE = '23514'; END IF;
  IF task_type = 'operation' AND task_scope = 'volume' AND NOT EXISTS (
    SELECT 1 FROM "VolumeMutation" WHERE "operationId" = task_id AND "volumeId"::text = task_input->>'volumeId'
  ) THEN RAISE EXCEPTION 'Active Volume operation requires its mutation slot' USING ERRCODE = '23514'; END IF;
  IF task_type = 'operation' AND jsonb_typeof(task_input->'volumeIds') = 'array' THEN
    FOR required_id IN SELECT jsonb_array_elements_text(task_input->'volumeIds') LOOP
      IF NOT EXISTS (SELECT 1 FROM "VolumeMutation" WHERE "operationId" = task_id AND "volumeId"::text = required_id) THEN
        RAISE EXCEPTION 'Service data operation requires all Volume mutation slots' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
END;
$$;
CREATE FUNCTION "ozz_validate_storage_task"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'VolumeMutation' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM "ozz_check_storage_task"('operation', NEW."operationId");
      PERFORM "ozz_check_storage_task"('deployment', NEW."deploymentId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM "ozz_check_storage_task"('operation', OLD."operationId");
      PERFORM "ozz_check_storage_task"('deployment', OLD."deploymentId");
    END IF;
  ELSIF TG_TABLE_NAME = 'DeploymentVolumeReference' THEN
    PERFORM "ozz_check_storage_task"('deployment', NEW."deploymentId");
  ELSIF TG_TABLE_NAME = 'Operation' THEN
    PERFORM "ozz_check_storage_task"('operation', NEW."id");
  ELSE
    PERFORM "ozz_check_storage_task"('deployment', NEW."id");
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "VolumeMutation_task_integrity" AFTER INSERT OR UPDATE OR DELETE ON "VolumeMutation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_storage_task"();
CREATE CONSTRAINT TRIGGER "DeploymentVolumeReference_task_integrity" AFTER INSERT OR UPDATE ON "DeploymentVolumeReference" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_storage_task"();
CREATE CONSTRAINT TRIGGER "Operation_storage_task_integrity" AFTER INSERT OR UPDATE ON "Operation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_storage_task"();
CREATE CONSTRAINT TRIGGER "Deployment_storage_task_integrity" AFTER INSERT OR UPDATE ON "Deployment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_validate_storage_task"();

COMMIT;

