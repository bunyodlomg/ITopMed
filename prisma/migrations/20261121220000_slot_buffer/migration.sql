-- Doctor's buffer between appointments (minutes), e.g. 15-minute visits with a 2-minute
-- buffer give slots 09:00, 09:17, 09:34 … so the queue does not drift. Covered by the
-- existing table-level grants on "DoctorProfile"; the portal gets it only through the
-- SECURITY DEFINER booking functions below.
ALTER TABLE "DoctorProfile" ADD COLUMN "bufferMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DoctorProfile" ADD CONSTRAINT "DoctorProfile_buffer_chk" CHECK ("bufferMinutes" BETWEEN 0 AND 30);

-- The return type changes, so the function is re-created (and re-granted).
DROP FUNCTION portal_booking_doctors();
CREATE FUNCTION portal_booking_doctors()
RETURNS TABLE (id uuid, "fullName" text, specialty text, "slotMinutes" int, "bufferMinutes" int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT d.id, u."fullName", d.specialty, d."defaultSlotMinutes", d."bufferMinutes" FROM "DoctorProfile" d
    JOIN "Membership" m ON m.id = d."membershipId" AND m."tenantId" = d."tenantId"
    JOIN "User" u ON u.id = m."userId"
   WHERE d."tenantId" = portal_current_tenant() AND portal_bookable_doctor(d.id)
   ORDER BY u."fullName"
$fn$;
REVOKE ALL ON FUNCTION portal_booking_doctors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_booking_doctors() TO itopmed_portal;

-- Same as before, except that slots step by visit length + buffer.
CREATE OR REPLACE FUNCTION portal_book(p_id uuid, p_doctor uuid, p_starts timestamp) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_patient uuid := portal_current_patient();
  v_tenant  uuid := portal_current_tenant();
  v_now     timestamp(3) := now() AT TIME ZONE 'UTC';
  v_tz text; v_days int; v_lead int; v_max int; v_active int; v_dur int; v_buf int;
  v_local timestamp; v_minute int; v_block record;
BEGIN
  IF v_patient IS NULL OR v_tenant IS NULL THEN RETURN 'forbidden'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Patient" WHERE id = v_patient AND status = 'ACTIVE') THEN RETURN 'forbidden'; END IF;
  IF NOT portal_bookable_doctor(p_doctor) THEN RETURN 'doctor_unavailable'; END IF;
  SELECT r.days, r."leadMinutes", r."maxActive", r.timezone, r."activeCount" INTO v_days, v_lead, v_max, v_tz, v_active FROM portal_booking_rules() r;
  IF p_starts < v_now + make_interval(mins => v_lead) THEN RETURN 'too_soon'; END IF;
  IF p_starts > v_now + make_interval(days => v_days) THEN RETURN 'too_far'; END IF;
  IF v_active >= v_max THEN RETURN 'too_many'; END IF;
  SELECT "defaultSlotMinutes", "bufferMinutes" INTO v_dur, v_buf FROM "DoctorProfile" WHERE id = p_doctor;
  v_local := (p_starts AT TIME ZONE 'UTC') AT TIME ZONE v_tz;
  IF date_part('second', v_local) <> 0 THEN RETURN 'outside_schedule'; END IF;
  v_minute := date_part('hour', v_local)::int * 60 + date_part('minute', v_local)::int;
  IF EXISTS (SELECT 1 FROM "ScheduleException" e WHERE e."doctorProfileId" = p_doctor AND e.date = v_local::date) THEN RETURN 'outside_schedule'; END IF;
  SELECT w."branchId", w."roomId" INTO v_block FROM "WorkSchedule" w
   WHERE w."doctorProfileId" = p_doctor AND w.weekday = date_part('isodow', v_local)::int
     AND w."startMinute" <= v_minute AND v_minute + v_dur <= w."endMinute" AND (v_minute - w."startMinute") % (v_dur + v_buf) = 0
   LIMIT 1;
  IF NOT FOUND THEN RETURN 'outside_schedule'; END IF;
  INSERT INTO "Appointment" (id, "tenantId", "patientId", "doctorProfileId", "branchId", "roomId", "startsAt", "endsAt", status, source, "createdById", "updatedAt")
  VALUES (p_id, v_tenant, v_patient, p_doctor, v_block."branchId", v_block."roomId", p_starts, p_starts + make_interval(mins => v_dur), 'BOOKED', 'PORTAL', NULL, v_now);
  RETURN 'ok';
END $fn$;
