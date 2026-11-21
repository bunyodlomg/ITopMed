-- Doctor's share of the money received for their patients (percent), set by the clinic's finance manager.
-- Covered by the existing table-level grants on "DoctorProfile".
ALTER TABLE "DoctorProfile" ADD COLUMN "commissionPercent" INTEGER;
ALTER TABLE "DoctorProfile" ADD CONSTRAINT "DoctorProfile_commission_chk" CHECK ("commissionPercent" IS NULL OR "commissionPercent" BETWEEN 0 AND 100);
