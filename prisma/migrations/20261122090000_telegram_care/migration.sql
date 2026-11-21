-- Telegram care features: home blood pressure / pulse from the patient, an offer
-- to book again after a missed visit, "how are you feeling?" a few days after a
-- visit, and medicine reminders at the prescription's intake times.
-- Messages never name a medicine, diagnosis or value (see notifications.ts).

ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'NO_SHOW_REBOOK';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'VISIT_CHECKIN';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'MEDICATION_REMINDER';

ALTER TABLE "NotificationSettings"
  ADD COLUMN "noShowRebook" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "visitCheckIn" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "checkInDays" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "medicationReminders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_checkInDays_chk" CHECK ("checkInDays" BETWEEN 1 AND 30);

ALTER TABLE "TelegramLink" ADD COLUMN "medRemindersOff" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "ReadingSource" AS ENUM ('TELEGRAM', 'PORTAL');
CREATE TYPE "CheckInAnswer" AS ENUM ('BETTER', 'SAME', 'WORSE');

CREATE TABLE "PatientReading" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "systolic" INTEGER NOT NULL,
    "diastolic" INTEGER NOT NULL,
    "pulse" INTEGER,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "source" "ReadingSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientReading_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PatientReading_tenantId_patientId_measuredAt_idx" ON "PatientReading"("tenantId", "patientId", "measuredAt");
ALTER TABLE "PatientReading" ADD CONSTRAINT "PatientReading_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientReading" ADD CONSTRAINT "PatientReading_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Physiologically possible values only (typing mistakes are rejected, not stored).
ALTER TABLE "PatientReading" ADD CONSTRAINT "PatientReading_chk" CHECK (
  "systolic" BETWEEN 50 AND 300 AND "diastolic" BETWEEN 20 AND 200 AND "systolic" > "diastolic"
  AND ("pulse" IS NULL OR "pulse" BETWEEN 20 AND 250));

CREATE TABLE "VisitCheckIn" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "doctorProfileId" UUID NOT NULL,
    "askAt" TIMESTAMP(3) NOT NULL,
    "answer" "CheckInAnswer",
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitCheckIn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VisitCheckIn_encounterId_key" ON "VisitCheckIn"("encounterId");
CREATE INDEX "VisitCheckIn_tenantId_doctorProfileId_answeredAt_idx" ON "VisitCheckIn"("tenantId", "doctorProfileId", "answeredAt");
ALTER TABLE "VisitCheckIn" ADD CONSTRAINT "VisitCheckIn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisitCheckIn" ADD CONSTRAINT "VisitCheckIn_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisitCheckIn" ADD CONSTRAINT "VisitCheckIn_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisitCheckIn" ADD CONSTRAINT "VisitCheckIn_chk" CHECK (("answer" IS NULL) = ("answeredAt" IS NULL));

-- ============================================================================
-- Security
-- ============================================================================
-- PatientReading: clinic role reads and inserts (the bot runs as the clinic role
-- in tenant context); append-only. The patient reads and adds their own via the
-- portal. Never the platform role.
REVOKE ALL ON "PatientReading" FROM PUBLIC;
GRANT SELECT, INSERT ON "PatientReading" TO itopmed_app;
GRANT SELECT ("id", "tenantId", "patientId", "systolic", "diastolic", "pulse", "measuredAt", "source", "createdAt") ON "PatientReading" TO itopmed_portal;
-- ("createdAt" too: Prisma sends its default value with the insert.)
GRANT INSERT ("id", "tenantId", "patientId", "systolic", "diastolic", "pulse", "measuredAt", "source", "createdAt") ON "PatientReading" TO itopmed_portal;
ALTER TABLE "PatientReading" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PatientReading" TO itopmed_app
  USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());
CREATE POLICY portal_own ON "PatientReading" FOR SELECT TO itopmed_portal
  USING ("patientId" = (SELECT portal_current_patient()));
CREATE POLICY portal_add ON "PatientReading" FOR INSERT TO itopmed_portal
  WITH CHECK ("patientId" = (SELECT portal_current_patient()) AND "tenantId" = (SELECT portal_current_tenant()) AND "source" = 'PORTAL');

-- VisitCheckIn: clinic role only (the answer arrives through the bot).
REVOKE ALL ON "VisitCheckIn" FROM PUBLIC;
GRANT SELECT, INSERT ON "VisitCheckIn" TO itopmed_app;
GRANT UPDATE ("answer", "answeredAt") ON "VisitCheckIn" TO itopmed_app;
ALTER TABLE "VisitCheckIn" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "VisitCheckIn" TO itopmed_app
  USING ("tenantId" = app_current_tenant()) WITH CHECK ("tenantId" = app_current_tenant());

-- The patient sees their own prescriptions (they hold the printed copy anyway):
-- medicine, dose and schedule only — never the visit, notes or diagnoses.
GRANT SELECT ("id", "tenantId", "patientId", "drug", "inn", "dose", "frequency", "route", "durationDays", "times", "instructions", "status", "createdAt") ON "Prescription" TO itopmed_portal;
CREATE POLICY portal_own ON "Prescription" FOR SELECT TO itopmed_portal
  USING ("patientId" = (SELECT portal_current_patient()) AND "status" = 'ACTIVE');
