-- 1) Clinic decision (owner turns it on): the desk may send a finished visit's papers
--    (PDF / Word) to the patient's own linked Telegram chat, under the printing rules.
ALTER TABLE "ClinicPolicy" ADD COLUMN "telegramDocuments" BOOLEAN NOT NULL DEFAULT false;

-- 2) Functional diagnostics (ECG, echo, ultrasound devices): a staff member who is not a
--    doctor records study results and attaches the device's pictures / PDFs for today's
--    patients. New permission diagnostics.record and a new standard role "diagnostics".
INSERT INTO "Role" (id, "tenantId", key, "isSystem", "createdAt", "updatedAt")
SELECT gen_random_uuid(), t.id, 'diagnostics', true, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Tenant" t
WHERE NOT EXISTS (SELECT 1 FROM "Role" r WHERE r."tenantId" = t.id AND r.key = 'diagnostics');

INSERT INTO "RolePermission" ("tenantId", "roleId", permission)
SELECT r."tenantId", r.id, v.permission
FROM "Role" r
JOIN (VALUES ('diagnostics', 'patients.read'), ('diagnostics', 'appointments.read'), ('diagnostics', 'emr.read'),
             ('diagnostics', 'diagnostics.record'), ('diagnostics', 'documents.read'), ('diagnostics', 'services.read')) AS v(key, permission)
  ON v.key = r.key AND r."isSystem"
ON CONFLICT DO NOTHING;
