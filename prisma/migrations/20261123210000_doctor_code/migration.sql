-- Short doctor code ("01", "02"…): the desk types it and presses Enter to choose the doctor.
-- Grants of "DoctorProfile" are table-wide (see 20261111032045) and cover the new column.
ALTER TABLE "DoctorProfile" ADD COLUMN "code" TEXT;
ALTER TABLE "DoctorProfile" ADD CONSTRAINT "DoctorProfile_code_chk" CHECK ("code" IS NULL OR "code" ~ '^[0-9]{1,4}$');
CREATE UNIQUE INDEX "DoctorProfile_tenantId_code_key" ON "DoctorProfile"("tenantId", "code");
