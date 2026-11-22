-- Start-of-work cleanup: the clinic owner removes every patient entered while
-- trying the system out, with everything that hangs on them (queue, visits,
-- notes, results, prescriptions, invoices, payments, portal and Telegram links,
-- cash shifts). Staff, services, prices, templates, schedules and settings stay.
--
-- The app role still has no DELETE on clinical tables and the guard triggers
-- stay in force for everyone else: only this function (run as the table
-- owner) may delete, and only for the caller's own clinic, only when the
-- caller is an ACTIVE clinic owner. The guard triggers are switched off inside
-- this transaction only; ALTER TABLE holds an exclusive lock until commit, so
-- no other session can write to those tables meanwhile. The audit trail
-- (AuditEvent, ids only) is kept and records the cleanup.

CREATE FUNCTION app_purge_patients() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_actor  uuid := app_current_user();
  v_counts jsonb := '{}'::jsonb;
  v_n      bigint;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Membership" m
      JOIN "MembershipRole" mr ON mr."membershipId" = m.id
      JOIN "Role" r ON r.id = mr."roleId"
     WHERE m."tenantId" = v_tenant AND m."userId" = v_actor AND m.status = 'ACTIVE' AND r.key = 'clinic_owner' AND r."tenantId" = v_tenant
  ) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;

  ALTER TABLE "ClinicalNote" DISABLE TRIGGER clinical_note_guard;
  ALTER TABLE "Invoice" DISABLE TRIGGER invoice_guard;
  ALTER TABLE "InvoiceLine" DISABLE TRIGGER invoice_line_guard;
  ALTER TABLE "LabOrder" DISABLE TRIGGER lab_order_guard;
  ALTER TABLE "LabResult" DISABLE TRIGGER lab_result_guard;
  ALTER TABLE "Prescription" DISABLE TRIGGER prescription_guard;
  ALTER TABLE "DentalChartEntry" DISABLE TRIGGER dental_chart_no_change;
  ALTER TABLE "StockMovement" DISABLE TRIGGER stock_movement_no_change;

  -- Laboratory
  DELETE FROM "LabResult" WHERE "tenantId" = v_tenant;
  DELETE FROM "LabOrderItem" WHERE "tenantId" = v_tenant;
  DELETE FROM "LabOrder" WHERE "tenantId" = v_tenant;
  -- Money
  DELETE FROM "Refund" WHERE "tenantId" = v_tenant;
  DELETE FROM "Payment" WHERE "tenantId" = v_tenant;
  DELETE FROM "InvoiceLine" WHERE "tenantId" = v_tenant;
  DELETE FROM "Invoice" WHERE "tenantId" = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('invoices', v_n);
  DELETE FROM "CashShift" WHERE "tenantId" = v_tenant;
  -- Clinical record
  DELETE FROM "ClinicalNoteAmendment" a USING "ClinicalNote" n WHERE a."noteId" = n.id AND n."tenantId" = v_tenant;
  DELETE FROM "ClinicalNote" WHERE "tenantId" = v_tenant;
  DELETE FROM "Diagnosis" WHERE "tenantId" = v_tenant;
  DELETE FROM "VitalSign" WHERE "tenantId" = v_tenant;
  DELETE FROM "Prescription" WHERE "tenantId" = v_tenant;
  DELETE FROM "DentalChartEntry" WHERE "tenantId" = v_tenant;
  DELETE FROM "VisitCheckIn" WHERE "tenantId" = v_tenant;
  DELETE FROM "DiagnosticFile" WHERE "tenantId" = v_tenant;
  DELETE FROM "DiagnosticResult" WHERE "tenantId" = v_tenant;
  DELETE FROM "NursingRecord" WHERE "tenantId" = v_tenant;
  DELETE FROM "PatientHistory" WHERE "tenantId" = v_tenant;
  DELETE FROM "Allergy" WHERE "tenantId" = v_tenant;
  DELETE FROM "DispensaryPlan" WHERE "tenantId" = v_tenant;
  DELETE FROM "PatientReading" WHERE "tenantId" = v_tenant;
  -- Messages, portal, Telegram
  DELETE FROM "Notification" WHERE "tenantId" = v_tenant;
  DELETE FROM "TelegramLinkCode" WHERE "tenantId" = v_tenant;
  DELETE FROM "TelegramLink" WHERE "tenantId" = v_tenant;
  DELETE FROM "PatientSession" WHERE "tenantId" = v_tenant;
  DELETE FROM "PatientAccount" WHERE "tenantId" = v_tenant;
  -- Stock dispensed to a patient stays in the stock log, without the patient.
  UPDATE "StockMovement" SET "patientId" = NULL WHERE "tenantId" = v_tenant AND "patientId" IS NOT NULL;
  -- Visits and the queue
  DELETE FROM "Encounter" WHERE "tenantId" = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('encounters', v_n);
  DELETE FROM "Appointment" WHERE "tenantId" = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointments', v_n);
  -- Patients
  DELETE FROM "PatientConsent" WHERE "tenantId" = v_tenant;
  DELETE FROM "PatientIdentifier" WHERE "tenantId" = v_tenant;
  DELETE FROM "Patient" WHERE "tenantId" = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('patients', v_n);

  ALTER TABLE "ClinicalNote" ENABLE TRIGGER clinical_note_guard;
  ALTER TABLE "Invoice" ENABLE TRIGGER invoice_guard;
  ALTER TABLE "InvoiceLine" ENABLE TRIGGER invoice_line_guard;
  ALTER TABLE "LabOrder" ENABLE TRIGGER lab_order_guard;
  ALTER TABLE "LabResult" ENABLE TRIGGER lab_result_guard;
  ALTER TABLE "Prescription" ENABLE TRIGGER prescription_guard;
  ALTER TABLE "DentalChartEntry" ENABLE TRIGGER dental_chart_no_change;
  ALTER TABLE "StockMovement" ENABLE TRIGGER stock_movement_no_change;
  RETURN v_counts;
END $fn$;

REVOKE ALL ON FUNCTION app_purge_patients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_patients() TO itopmed_app;
