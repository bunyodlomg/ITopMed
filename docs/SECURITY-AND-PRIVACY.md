# Security and privacy

Status legend: ✅ implemented & tested · 🟡 partial · ⏳ planned

## Controls
| Control | Status | Where |
|---|---|---|
| Tenant isolation via PostgreSQL RLS + tenant context per transaction | ✅ | migration `security_foundation`; `tests/tenant-isolation.test.ts` |
| Deny-by-default grants; runtime roles without BYPASSRLS/superuser | ✅ | `tests/db-security.test.ts` |
| Platform role cannot read password hashes, Telegram links, sessions (and future clinical tables) | ✅ | column-level grants |
| Server-side authorization on every page/action/service | ✅ | `auth/guards.ts`, service checks |
| argon2id password hashing, password policy | ✅ | `security/password.ts` |
| Account lockout + rate limiting | ✅ | DB lockout; rate limits shared across instances in PostgreSQL, hashed keys, fail closed (Phase 9) |
| Sign-in = **login name + password** only (at least 8 characters; lockout after 5 failures and per-IP limits). No email, no Telegram sign-in for staff or the console; the clinic's Administrator gives a new password. |
| Each clinic has its OWN bot (created by ITop Med, connected by the SuperAdmin in the console). The platform role hands the token over already encrypted and can never read it back (`platform_set_clinic_bot`; no grant on `TelegramBot`). That bot serves patients only: notifications and the Mini App `/tg/<slug>`. It never signs staff in | ✅ | `telegram/clinic-bot.ts`; migration `clinic_bot_login` |
| Mini App (patients only): Telegram's initData verified with HMAC(that clinic's bot token), ≤ 24 h old, bots refused; same-origin POST only (no login CSRF). Only that clinic's portal patients count: one → portal, several → the person chooses (re-checked server side), nobody → patient page. There is no central bot sign-in and no staff/console sign-in through Telegram | ✅ | `auth/telegram-webapp.ts`; `tests/telegram-miniapp.test.ts` |
| Patients are recognised by the phone Telegram verified: the bot accepts only a contact the sender shared about themselves (`contact.user_id` = sender). Stored in `TelegramContact`, which no runtime role can read; only `tg_contact_save` / `portal_telegram_accounts` (ACTIVE portal accounts of usable clinics with the portal on). Clinical notes and diagnoses are still never shown in the portal | ✅ | migration `telegram_identity` |
| Session expiry (absolute + idle), revocation | ✅ | |
| Platform staff invitations: single-use 48 h token (hash stored), SUPER_ADMIN only; the invitee chooses login and password | ✅ | `platform/staff.ts` |
| The console (`/admin`, own address via `ADMIN_URL`) is for SUPER_ADMIN only: other platform accounts are signed out at login and refused by `requirePlatform` | ✅ | `auth/guards.ts`, `admin/actions.ts` |
| ITop Med billing of clinics (`ClinicInvoice`, `ClinicPayment`, `BillingSettings`): platform role only; clinics see just their own debt through `app_billing_status()`. Console activity is counts only from `platform_tenant_activity()` (SECURITY DEFINER), so the platform role still reads no clinical rows | ✅ | `platform/billing.ts`; `tests/platform-billing.test.ts` |
| HttpOnly, Secure, SameSite cookies, `__Host-` prefix in production | ✅ | `auth/cookies.ts` |
| CSRF | ✅ | SameSite cookies + Next.js server-action Origin check |
| XSS | ✅ | React escaping, nonce CSP with `strict-dynamic` |
| SQL injection | ✅ | Prisma + tagged-template raw SQL only |
| IDOR | ✅ | RLS hides foreign rows even when queried by id (tested) |
| Security headers (CSP, HSTS, XFO, nosniff, Referrer, Permissions) | ✅ | `src/proxy.ts`, `next.config.ts` |
| Secrets at rest (AES-256-GCM with AAD) | ✅ | `security/crypto.ts` |
| Tamper-evident append-only audit (hash chain; UPDATE/DELETE/TRUNCATE blocked even for owner) | ✅ | trigger + `audit_verify_chain` |
| PHI-free audit metadata and logs | ✅ | `assertSafeMetadata`, `logger` |
| Invitations single-use, expiring, hash-only, rotated on resend | ✅ | `tenancy/*` |
| Break-glass support access (request → clinic approval → time-boxed → audited) | ✅ | `support/access.ts`; CLINICAL_READ hard-disabled (`CLINICAL_SUPPORT_ACCESS_ENABLED = false`) |
| No self-service password reset (no email, no Telegram): `/forgot-password` only says to ask the clinic's Administrator, who sets a new password on the Staff page (revokes the member's sessions; audited) | ✅ | `clinic/members.ts`; `tests/staff-password.test.ts` |
| Role editor guardrails (owner role immutable; clinical-permission grants flagged in audit) | ✅ | `clinic/roles.ts` |
| Member access guardrails (no self-change, only owners change owners, at least one active owner) | ✅ | `clinic/members.ts` |
| Open-redirect protection for post-login `next` | ✅ | `lib/safe-next.ts` |
| Branch scope (ABAC): branch-restricted members only see/change resources of their branches | ✅ | `clinic/context.ts` (`assertBranch`, `branchWhere`); tested |
| Operational tables (rooms, services, schedules) granted to the clinic role only — none to the platform role | ✅ | migration `clinic_resources_scheduling` |
| Staff absences stored as categories only (no free-text health information about employees) | ✅ | `ScheduleExceptionKind` |
| Read-access audit for medical records (`emr.viewed`, `emr.access_denied`, `emr.break_glass`, `patient.viewed`) | ✅ | `emr/access.ts`, `patients.ts` |
| Care-relationship ABAC for the EMR (doctor: visit within 365 days back / 30 ahead; nurse: visit today in own branch; head doctor: oversight) | ✅ | `emr/access.ts`; tested |
| Break-the-glass: POST-only, reason category (no free text in the audit trail), 10-minute patient-scoped cookie | ✅ | `care-actions.ts` |
| Signed notes immutable and undeletable at database level; tamper evidence via SHA-256 content hash shown in the UI | ✅ | trigger `clinical_note_guard`; tested incl. owner-level tampering |
| No deletion grants on clinical tables; corrections via status (`ENTERED_IN_ERROR`) or amendments | ✅ | migration `patients_appointments_emr` |
| Clinical and patient tables have no grants for the platform role | ✅ | tested |
| Search terms and clinical text never written to logs or audit metadata | ✅ | |
| Laboratory: four-eyes verification (verifier ≠ person who entered results) in the service **and** as a DB CHECK; verified results immutable by trigger; lab staff work from the order and patient header only — no EMR access; values hidden from the clinical views until verified; no lab tables granted to the platform role | ✅ | `lab/lab.ts`, migration `laboratory`; tested |
| Patient portal isolation: separate DB role; patient identity derived from the session hash inside PostgreSQL; own rows only; unreleased results and draft invoices hidden by policy; no grants on clinical notes, diagnoses, allergies, vitals, encounters, staff or audit tables; internal columns (lab indication, appointment admin note, payment references, staff ids) not granted | ✅ | migration `patient_portal`; `tests/portal.test.ts` |
| Patient onboarding without sending secrets: one-time activation code handed over in person (hash-only, 72 h), date-of-birth check, consent recorded before issue, lockout and code burning, staff never set or see patient passwords (column grants) | ✅ | `portal/staff.ts`, `portal/auth.ts` |
| Results released to patients only by a doctor in a care relationship (not break-the-glass), one-way and audited | ✅ | `lab/lab.ts` `releaseLabOrder` |
| Stock integrity: quantities changed only through an append-only ledger; negative stock, expired issue and ledger edits refused by the database; clinic role has no UPDATE on batches; every movement attributed and audited | ✅ | migration `inventory_hr`; `tests/inventory-hr.test.ts` |
| Staff privacy in HR: minimal fields, leave by category only, sick leave never shown to colleagues (generic absence in schedules) and kept out of audit metadata; HR and inventory tables not granted to the platform role | ✅ | `hr/hr.ts` |
| Notifications: consent per channel checked when queuing and again when sending; outbox stores no text, addresses or clinical content; messages limited to clinic, time, branch and portal links; simulated SMS/email transports refused in production | ✅ | `notifications/*`, `env.ts`; tested |
| Telegram care (bot): home blood pressure / pulse is accepted only from a chat linked to the patient (one-time portal deep link), strictly parsed, range-checked in PostgreSQL, rate-limited, never echoed back or logged; check-in answers and "stop reminders" buttons carry ids only (callback data) and count only from the patient's own linked chat, once; medicine reminders name the time, never the medicine, and are re-checked against the active prescription at send time | ✅ | `telegram/updates.ts`, migration `telegram_care`; `tests/telegram-care.test.ts` |
| Portal sees the patient's own active prescriptions (medicine, dose, schedule columns only — they hold the printed copy) and their own home readings (insert only as `PORTAL`, own rows); still no grants on notes, diagnoses, encounters or check-in answers | ✅ | migration `telegram_care`; tested |
| FHIR export: care relationship or oversight only, never break-the-glass, POST + Origin check, no-store, audited without content | ✅ | `emr/fhir.ts`, `record/fhir/route.ts`; tested |
| Module enforcement: permissions of a disabled module are removed when the clinic context is resolved, so pages, actions and services deny by default; the patient portal and its sessions stop when its module is off | ✅ | `modules/catalog.ts`, `auth/clinic-auth.ts`; tested |
| Owner self-assignment of doctor / front-desk roles only through the setup assistant (owner only, explicit choice, audited `clinic.owner_clinical_role` / `clinic.owner_front_desk_role`); clinical access still requires a care relationship | ✅ | `clinic/practice.ts`; tested |
| Dental chart: append-only, treating doctor in an open visit only, no platform or portal grants | ✅ | migration `practice_profiles_dental`; tested |
| Automated authorization sweep: every page, server action and route handler must call a server-side guard; public entry points are an explicit, minimal allowlist (negative control verified) | ✅ | `tests/authz-sweep.test.ts` |
| Security headers tested (nonce CSP per request, frame-ancestors none, nosniff, no-referrer, permissions policy, no-store on pages, no x-powered-by) | ✅ | `tests/security-hardening.test.ts` |
| Encrypted backups (AES-256-GCM, separate key) with an automated restore drill that re-verifies every audit chain | ✅ | `scripts/lib/backup.ts`, `tests/backup.test.ts` |
| Dependency audit | 🟡 | production dependencies: 0 known vulnerabilities (2026-11-13). Dev-only: 7 moderate (minimatch ReDoS via typescript-eslint's lint tooling; no fixed release yet; only reachable through our own lint globs) — accepted, re-check monthly |
| Patient MFA / SMS one-time codes | ⏳ | needs the SMS provider (Phase 8d) |
| Protected document storage + short-lived URLs | ⏳ | Phase 6 |
| Encrypted backups, PITR, tested restores | ⏳ | infrastructure, Phase 9 |
| Dependency / SAST / secret scanning in CI | ⏳ | Phase 9 (`npm audit` currently reports advisories in dev dependencies — review) |
| Security monitoring, incident runbook | ⏳ | Phase 9 |
| Export / retention / deletion policies | ⏳ | needs legal input |

## Emergency (break-glass) support access
1. Platform SUPPORT staff file a `SupportAccessGrant` (scope CONFIGURATION / OPERATIONAL / CLINICAL_READ, reason ≥ 10 chars, ticket, 5–480 minutes).
2. The platform DB role **cannot** approve it (no UPDATE grant — tested). Only a clinic user with `support_access.decide` (owner) approves or denies.
3. While active, support acts through the clinic path with the grant id in context; every access is audited; automatic expiry.
4. CLINICAL_READ stays disabled until the legal assessment below is complete.

## Lost password or Telegram account
1. Clinic staff: the owner or an administrator with `staff.manage` sets a new password on the member's page (only after verifying the person in person). This signs the member out everywhere and removes their Telegram link. Owners only by an owner; accounts that also work in another clinic are refused.
2. Platform staff: no self-service reset; a SUPER_ADMIN or the server CLI handles it.
3. A person can unlink their own Telegram on the account security page at any time.

## Data handling rules
* No real patient data in development, tests, screenshots or AI prompts. Test data uses `*.test` domains.
* Email/SMS/Telegram never carry diagnoses, results or clinical details — only "sign in to view".
* Clinical content is never machine-translated and never sent to external AI providers without legal basis, agreements and security review.
* Logs/analytics/error tracking contain identifiers only.

## Uzbekistan legal requirements — to be confirmed by counsel
Engineering checklist, **not legal advice**; each item needs sign-off from a qualified Uzbek lawyer.
* Law "On Personal Data" (ZRU-547, 2019, as amended), including the data-localisation requirement for citizens' personal data processed with IT systems and registration of personal-data databases.
* Medical confidentiality under health-protection legislation.
* Ministry of Health rules on electronic medical records, DMED / Digital Health Platform obligations, retention periods.
* Controller/processor roles between ITop Med and clinics; data-processing agreements.
* A documented legal basis per purpose — consent is not assumed to cover everything:

| Purpose | Data | Proposed basis (to confirm) |
|---|---|---|
| Providing care, EMR | health data | law / medical necessity |
| Appointment reminders | name, phone, time | contract / legitimate interest, opt-out |
| Billing | identity, services, payments | contract / tax law |
| Staff accounts & audit | staff identity, activity | employment / legal obligation |
| Platform analytics | aggregated, de-identified | legitimate interest |
| Marketing | contacts | explicit consent only |

Hosting and cross-border transfer are configurable (`Tenant.dataResidency`, default `UZ`); any change needs a documented assessment.

## Incident response (outline)
Detect (lockouts, RLS errors, audit-chain failures) → triage within 1 h → contain (revoke sessions, suspend tenant, rotate keys) → assess personal-data impact → notify clinics/authorities as legally required → post-mortem.
