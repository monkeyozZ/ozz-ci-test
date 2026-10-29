BEGIN;

-- Named ports may swap numbers atomically without changing their stable IDs.
ALTER TABLE "ServicePort" ADD CONSTRAINT "ServicePort_serviceId_servicePort_unique"
  UNIQUE USING INDEX "ServicePort_serviceId_servicePort_key" DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "Operation" ADD CONSTRAINT "Operation_active_service_reference"
  CHECK ("scope" <> 'service' OR "status" NOT IN ('queued', 'running') OR "serviceId" IS NOT NULL);

-- Validate the complete shared slot, including a deletion or replacement of
-- the slot alone. An active task cannot be orphaned by bypassing its lifecycle.
CREATE FUNCTION "ozz_check_service_mutation"(affected_service uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  active_count bigint;
  slot "ServiceMutation"%ROWTYPE;
BEGIN
  IF affected_service IS NULL THEN RETURN; END IF;
  SELECT
    (SELECT count(*) FROM "Deployment" WHERE "serviceId" = affected_service AND "status" IN ('queued', 'running')) +
    (SELECT count(*) FROM "Operation" WHERE "serviceId" = affected_service AND "status" IN ('queued', 'running'))
    INTO active_count;
  SELECT * INTO slot FROM "ServiceMutation" WHERE "serviceId" = affected_service;
  IF active_count = 0 AND slot."serviceId" IS NULL THEN RETURN; END IF;
  IF active_count <> 1 OR slot."serviceId" IS NULL THEN
    RAISE EXCEPTION 'A service must have one shared slot for its active task' USING ERRCODE = '23514';
  END IF;
  IF slot."deploymentId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Deployment" WHERE "id" = slot."deploymentId" AND "serviceId" = affected_service AND "status" IN ('queued', 'running')
  ) THEN RETURN; END IF;
  IF slot."operationId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Operation" WHERE "id" = slot."operationId" AND "serviceId" = affected_service AND "status" IN ('queued', 'running')
  ) THEN RETURN; END IF;
  RAISE EXCEPTION 'The service mutation slot does not own the active task' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION "ozz_validate_service_task"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_service uuid;
  task_status "OperationStatus";
BEGIN
  IF TG_TABLE_NAME = 'Deployment' THEN
    SELECT "serviceId", "status" INTO affected_service, task_status FROM "Deployment" WHERE "id" = NEW."id";
    IF affected_service IS NULL AND task_status IN ('queued', 'running') THEN
      RAISE EXCEPTION 'Active deployment requires a service' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "serviceId" INTO affected_service FROM "Operation" WHERE "id" = NEW."id";
  END IF;
  PERFORM "ozz_check_service_mutation"(affected_service);
  IF TG_OP = 'UPDATE' AND OLD."serviceId" IS DISTINCT FROM affected_service THEN
    PERFORM "ozz_check_service_mutation"(OLD."serviceId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "ozz_validate_service_slot"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM "ozz_check_service_mutation"(NEW."serviceId");
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM "ozz_check_service_mutation"(OLD."serviceId");
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER "ServiceMutation_active_task" ON "ServiceMutation";
CREATE CONSTRAINT TRIGGER "ServiceMutation_active_task"
  AFTER INSERT OR UPDATE OR DELETE ON "ServiceMutation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ozz_validate_service_slot"();

COMMIT;
