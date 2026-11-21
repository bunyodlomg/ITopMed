-- Dispensary follow-up ("dispanser kuzatuvi"): long-term patients of a doctor with a
-- follow-up interval, the next due date and the tests to repeat; a reminder the day before.

ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'DISPENSARY_REMINDER';

CREATE TYPE "DispensaryGroup" AS ENUM ('HYPERTENSION', 'HEART_FAILURE', 'ATRIAL_FIBRILLATION', 'POST_MI', 'ANTICOAGULANT', 'OTHER');

CREATE TABLE "DispensaryPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "doctorProfileId" UUID NOT NULL,
    "group" "DispensaryGroup" NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "nextDueDate" DATE NOT NULL,
    "labs" TEXT,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,

    CONSTRAINT "DispensaryPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DispensaryPlan_tenantId_doctorProfileId_nextDueDate_idx" ON "DispensaryPlan"("tenantId", "doctorProfileId", "nextDueDate");
CREATE INDEX "DispensaryPlan_tenantId_patientId_idx" ON "DispensaryPlan"("tenantId", "patientId");

ALTER TABLE "DispensaryPlan" ADD CONSTRAINT "DispensaryPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DispensaryPlan" ADD CONSTRAINT "DispensaryPlan_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DispensaryPlan" ADD CONSTRAINT "DispensaryPlan_doctorProfileId_fkey" FOREIGN KEY ("doctorProfileId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Security: clinical data — clinic role only (never the platform or portal role).
-- ============================================================================
ALTER TABLE "DispensaryPlan" ADD CONSTRAINT "DispensaryPlan_chk" CHECK (
  "intervalDays" BETWEEN 7 AND 365
  AND ("labs" IS NULL OR char_length("labs") BETWEEN 1 AND 500)
  AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000)
  AND (("closedAt" IS NULL) = ("closedById" IS NULL)));
-- One open plan per patient, doctor and group.
CREATE UNIQUE INDEX "DispensaryPlan_open_uq" ON "DispensaryPlan"("tenantId", "patientId", "doctorProfileId", "group") WHERE "closedAt" IS NULL;

REVOKE ALL ON "DispensaryPlan" FROM PUBLIC;
GRANT SELECT, INSERT ON "DispensaryPlan" TO itopmed_app;
GRANT UPDATE ("intervalDays", "nextDueDate", "labs", "note", "lastSeenAt", "closedAt", "closedById", "updatedAt") ON "DispensaryPlan" TO itopmed_app;
ALTER TABLE "DispensaryPlan" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DispensaryPlan" TO itopmed_app
  USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());
