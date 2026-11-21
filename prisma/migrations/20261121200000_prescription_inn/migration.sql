-- Prescription: international non-proprietary name (INN) next to the trade name.
-- Covered by the existing table-level SELECT/INSERT grant to itopmed_app; not granted to the portal.
ALTER TABLE "Prescription" ADD COLUMN "inn" TEXT;
