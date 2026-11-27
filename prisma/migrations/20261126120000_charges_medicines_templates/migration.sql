-- 1) billing.charge: doctors, nurses, lab and diagnostics staff put the services they
--    order or perform on the patient's bill as UNPAID (catalogue price, no discount,
--    no payment). The patient pays everything at the cashier before leaving.
--    medicines.manage: who may write the clinic's medicine catalog.
INSERT INTO "RolePermission" ("tenantId", "roleId", permission)
SELECT r."tenantId", r.id, v.permission
FROM "Role" r
JOIN (VALUES ('doctor', 'billing.charge'), ('head_doctor', 'billing.charge'), ('nurse', 'billing.charge'),
             ('lab_staff', 'billing.charge'), ('diagnostics', 'billing.charge'),
             ('doctor', 'medicines.manage'), ('head_doctor', 'medicines.manage'),
             ('pharmacist', 'medicines.manage'), ('clinic_owner', 'medicines.manage')) AS v(key, permission)
  ON v.key = r.key AND r."isSystem"
ON CONFLICT DO NOTHING;

-- 2) The clinic's medicine catalog ("Dori bazasi"). Reference data written by the
--    clinic itself (no patient data); clinic role only, never platform or portal.
CREATE TABLE "Medicine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "inn" TEXT,
    "strength" TEXT,
    "form" TEXT NOT NULL,
    "manufacturer" TEXT,
    "drugGroup" TEXT,
    "defaultDose" TEXT,
    "defaultFrequency" TEXT,
    "defaultRoute" TEXT,
    "defaultTimes" TEXT,
    "defaultDays" INTEGER,
    "instructions" TEXT,
    "searchKey" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "photo" BYTEA,
    "photoMime" TEXT,
    "photoUpdatedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Medicine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Medicine_tenantId_usageCount_idx" ON "Medicine"("tenantId", "usageCount");
CREATE INDEX "Medicine_searchKey_trgm_idx" ON "Medicine" USING gin ("searchKey" gin_trgm_ops);
-- One active entry per trade name and strength in a clinic.
CREATE UNIQUE INDEX "Medicine_active_uq" ON "Medicine"("tenantId", lower("name"), lower(coalesce("strength", ''))) WHERE "archivedAt" IS NULL;

ALTER TABLE "Medicine" ADD CONSTRAINT "Medicine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Medicine" ADD CONSTRAINT "Medicine_chk" CHECK (
  char_length("name") BETWEEN 2 AND 120
  AND "form" ~ '^[a-z_]{2,20}$'
  AND ("inn" IS NULL OR char_length("inn") BETWEEN 1 AND 120)
  AND ("strength" IS NULL OR char_length("strength") BETWEEN 1 AND 60)
  AND ("manufacturer" IS NULL OR char_length("manufacturer") BETWEEN 1 AND 120)
  AND ("drugGroup" IS NULL OR char_length("drugGroup") BETWEEN 1 AND 120)
  AND ("defaultDose" IS NULL OR char_length("defaultDose") BETWEEN 1 AND 100)
  AND ("defaultFrequency" IS NULL OR char_length("defaultFrequency") BETWEEN 1 AND 120)
  AND ("defaultRoute" IS NULL OR char_length("defaultRoute") BETWEEN 1 AND 60)
  AND ("defaultTimes" IS NULL OR char_length("defaultTimes") BETWEEN 1 AND 60)
  AND ("defaultDays" IS NULL OR "defaultDays" BETWEEN 1 AND 3650)
  AND ("instructions" IS NULL OR char_length("instructions") BETWEEN 1 AND 1000)
  AND char_length("searchKey") <= 600
  AND "usageCount" >= 0
  AND (("photo" IS NULL) = ("photoMime" IS NULL))
  AND ("photo" IS NULL OR octet_length("photo") <= 2097152)
  AND ("photoMime" IS NULL OR "photoMime" IN ('image/jpeg', 'image/png', 'image/webp')));

REVOKE ALL ON "Medicine" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON "Medicine" TO itopmed_app;
ALTER TABLE "Medicine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Medicine" TO itopmed_app
  USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());

-- 3) A prescription remembers the catalog entry it came from (statistics, photo).
ALTER TABLE "Prescription" ADD COLUMN "medicineId" UUID;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Prescription_medicineId_idx" ON "Prescription"("medicineId");

-- 4) A template may belong to one service (the echo form to "EhoKG"): offered first in
--    visits with that service and to the doctors who provide it.
ALTER TABLE "ClinicTemplate" ADD COLUMN "serviceId" UUID;
ALTER TABLE "ClinicTemplate" ADD CONSTRAINT "ClinicTemplate_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ClinicTemplate_serviceId_idx" ON "ClinicTemplate"("serviceId");
