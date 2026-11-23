-- Clinic rule: documents (visit papers, diagnostic reports, prescriptions) are printed only at the
-- reception desk, after the cashier has settled the bill. Doctors then see "printed at the desk".
ALTER TABLE "ClinicPolicy" ADD COLUMN "printOnlyAtDesk" BOOLEAN NOT NULL DEFAULT false;
