-- ============================================================================
-- Patients reach their portal with the phone number Telegram verified for them
-- (the clinic's decision, 2026-11-24): when the number a person shared about
-- THEMSELVES with the clinic's bot is the phone on an ACTIVE patient card of
-- that clinic, the portal account is opened without an activation code.
-- Several cards with the same number (a family) are all offered; the person
-- chooses. Accounts opened this way have no login/password and no creator.
-- ============================================================================

ALTER TABLE "PatientAccount" ALTER COLUMN "createdById" DROP NOT NULL;
-- An account opened through Telegram is ACTIVE without a login and password.
ALTER TABLE "PatientAccount" ADD COLUMN "telegramOpened" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PatientAccount" DROP CONSTRAINT "PatientAccount_active_chk";
ALTER TABLE "PatientAccount" ADD CONSTRAINT "PatientAccount_active_chk"
  CHECK (status <> 'ACTIVE' OR "telegramOpened" OR (login IS NOT NULL AND "passwordHash" IS NOT NULL));
GRANT SELECT ("telegramOpened") ON "PatientAccount" TO itopmed_app;

-- Opens (or activates an invited) portal account for every ACTIVE patient of
-- p_tenant whose card phone is this Telegram user's verified phone. Disabled
-- accounts (the clinic switched the portal off for that patient) stay disabled.
CREATE FUNCTION portal_telegram_open(p_tg bigint, p_tenant uuid)
RETURNS TABLE ("accountId" uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_phone text;
  v_now   timestamp(3) := now() AT TIME ZONE 'UTC';
  v_id    uuid;
  r       record;
BEGIN
  SELECT c.phone INTO v_phone FROM "TelegramContact" c WHERE c."telegramId" = p_tg;
  IF v_phone IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t.id = p_tenant AND t.status IN ('TRIAL', 'ACTIVE')) THEN RETURN; END IF;
  IF NOT portal_module_enabled(p_tenant, 'patient_portal') THEN RETURN; END IF;
  FOR r IN
    SELECT p.id AS pid, a.id AS aid, a.status AS astatus
      FROM "Patient" p LEFT JOIN "PatientAccount" a ON a."patientId" = p.id
     WHERE p."tenantId" = p_tenant AND p.status = 'ACTIVE' AND p.phone = v_phone
  LOOP
    IF r.aid IS NULL THEN
      v_id := gen_random_uuid();
      INSERT INTO "PatientAccount" (id, "tenantId", "patientId", status, "telegramOpened", "activatedAt", "createdAt", "updatedAt")
      VALUES (v_id, p_tenant, r.pid, 'ACTIVE', true, v_now, v_now, v_now);
      "accountId" := v_id; created := true;
      RETURN NEXT;
    ELSIF r.astatus = 'INVITED' THEN
      UPDATE "PatientAccount" pa
         SET status = 'ACTIVE', "telegramOpened" = true, "activatedAt" = v_now, "activationCodeHash" = NULL, "activationExpiresAt" = NULL, "updatedAt" = v_now
       WHERE pa.id = r.aid;
      "accountId" := r.aid; created := false;
      RETURN NEXT;
    END IF;
  END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION portal_telegram_open(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_telegram_open(bigint, uuid) TO itopmed_portal;

-- ACTIVE portal accounts this Telegram user may enter: the account's login is
-- their verified phone, or the patient card's phone is. The patient's first
-- name and last-name initial let a family member pick the right card.
DROP FUNCTION portal_telegram_accounts(bigint);
CREATE FUNCTION portal_telegram_accounts(p_tg bigint)
RETURNS TABLE (id uuid, "tenantId" uuid, slug text, name text, "lockedUntil" timestamp(3), "patientName" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT a.id, a."tenantId", t.slug, t.name, a."lockedUntil",
         trim(p."firstName" || ' ' || left(p."lastName", 1) || '.') AS "patientName"
    FROM "TelegramContact" c
    JOIN "PatientAccount" a ON a.status = 'ACTIVE'
    JOIN "Patient" p ON p.id = a."patientId"
    JOIN "Tenant" t ON t.id = a."tenantId" AND t.status IN ('TRIAL', 'ACTIVE')
   WHERE c."telegramId" = p_tg
     AND (a.login = c.phone OR (p.phone = c.phone AND p.status = 'ACTIVE'))
     AND portal_module_enabled(t.id, 'patient_portal')
   ORDER BY t.name, p."firstName"
$fn$;
REVOKE ALL ON FUNCTION portal_telegram_accounts(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_telegram_accounts(bigint) TO itopmed_portal;
