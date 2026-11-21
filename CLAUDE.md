# ITop Med — engineering guide for Claude Code and contributors

Multi-tenant healthcare SaaS (Uzbekistan first). ONE codebase, strict tenant isolation.
Read `docs/ARCHITECTURE.md` and `docs/SECURITY-AND-PRIVACY.md` before changing anything security-relevant.

## Stack
Next.js 16 App Router · React 19 · TypeScript strict · Tailwind v4 · PostgreSQL + Prisma 7 (driver adapter `@prisma/adapter-pg`) · next-intl 4 · Zod 4 · argon2id (`@node-rs/argon2`) · Vitest.

## Commands
| Task | Command |
|---|---|
| Start local PostgreSQL (embedded, no Docker) | `npm run db:start` (keep running) |
| Apply migrations / seed plans | `npm run db:migrate` · `npm run db:seed` |
| Create a platform admin | `npm run admin:create -- --login admin --name "Name" --role SUPER_ADMIN` |
| Dev server | `npm run dev` → http://localhost:3000/admin/login and /login |
| Local installation (one PC serves the clinic network; self-healing supervisor in `scripts/local.ts`) | `npm run app` / `app:stop` / `app:status` / `app:doctor` (checks + phone address) / `app:firewall` / `app:autostart`; devices join via `http://<pc-ip>/connect` |
| Packaged Windows app for clinics (one zip: own Node runtime + PostgreSQL + prebuilt app; data in `%LOCALAPPDATA%\ITopMed`; first start = /welcome form) | `npm run package:win` → `dist/ITopMed-Windows.zip` (see `scripts/package/build-win.ts`) |
| Notification worker | `npm run worker` (or `-- --once`); clinics can also "Send due messages now" |
| Encrypted backup / restore drill | `npm run backup` · `npm run backup:verify -- <file>` (see docs/DEPLOYMENT.md) |
| Layout audit (every screen at phone/tablet/desktop, light+dark) | `npm run app` then `ITM_AUDIT_LOGIN=… ITM_AUDIT_PASSWORD=… npm run ui:audit -- --slug <clinic>` (login of an account that is clinic owner + SUPER_ADMIN); must report no problems after any UI change |
| End-to-end clinical walkthrough in the browser (registration → visit → prescription → invoice → payment) | `npm run app`, then the same ITM_AUDIT_* variables: `npm run e2e:walkthrough -- --slug <clinic>` (creates synthetic records — dev/demo data only) |
| Checks (run all after every change) | `npm run lint` · `npm run typecheck` · `npm test` · `npm run i18n:check` · `npm run build` — read each exit code; never pipe a check into `tail`/`grep` when judging pass/fail |

Tests boot their own throw-away PostgreSQL on port 54339 and apply the real migrations.

## Non-negotiable rules
1. **Tenant isolation.** Clinic data is only ever read/written through `withAppContext()` (`src/server/db.ts`) with `tenantId` + `userId`. Never use the platform client for clinic workflows.
2. **Every new table** ships, in the same migration, with: explicit `GRANT`s for `itopmed_app` / `itopmed_platform`, `ENABLE ROW LEVEL SECURITY`, and policies. `tests/db-security.test.ts` fails if RLS is missing.
   - Some policies deliberately expose a user's *own* rows across clinics (e.g. `Membership` for the clinic switcher). When querying such tables inside a clinic, **always add an explicit `tenantId` filter** as well.
   - Prisma does not model hand-written SQL (RLS policies, exclusion constraints, trigram indexes, triggers). **Review every generated migration** and delete any `DROP` of those objects before applying it.
   - Page loaders must use helpers whose permissions match every role that can open the page (e.g. `listOperationalBranches`, not the admin-only `listBranches`).
3. **Patient portal data only through `withPortal()`** (role `itopmed_portal`). Its policies derive the patient from the session hash in PostgreSQL; every new table a patient may see needs explicit column grants and `portal_*` policies, and clinical notes/diagnoses are never granted to it. Use explicit `select`s and `updateMany`/`createMany` there (column grants break Prisma's `RETURNING *`).
4. **Platform hierarchy:** SUPER_ADMIN → NETWORK_ADMIN (one `Network` of clinics; every platform tenant query/change goes through `tenantScope()` / `assertTenantInScope()` in `src/server/tenancy/provisioning.ts`) → clinic owner (`clinic_owner`, the clinic Admin). **Clinical tables are never granted to `itopmed_platform`.** Platform staff do not read medical records. Break-glass access goes through `SupportAccessGrant` (clinic approval, time-limited, audited).
5. **Authorization on the server, every time:** pages call `requirePlatform()` / `requireClinic(slug, permission)` / `requirePatient(slug)`; services re-check permissions. Deny by default. UI hiding is cosmetic. `tests/authz-sweep.test.ts` enforces this for every page, action and route; never widen its public allowlist without a reason.
6. **Audit** every security-relevant or clinical action with `recordAudit()` inside the same transaction. Audit metadata must never contain clinical content, secrets or tokens.
7. **No PHI in logs, URLs, emails, notifications, analytics or error trackers.** Use IDs, not content. Use `logger` (redacting), never `console.log` in app code.
8. **Accessible by default (WCAG 2.1 AA).** Text and UI states use the colour tokens (raw hex only for brand artwork such as the logo gradient); white text only on `*-solid` fills; scroll containers must be keyboard-focusable; icon-only controls need accessible names.
9. **No hard-coded UI text.** Add keys to all four catalogs in `messages/` (`uz-Latn` default, `uz-Cyrl`, `ru`, `en`). Clinical record content is never machine-translated.
10. **Never** store plaintext passwords/tokens, email passwords, commit secrets, or use real patient data (tests, screenshots, prompts). Synthetic data only (`*.test` domains).
11. **Timestamps are UTC** (`timestamp(3)` columns; DB timezone pinned to UTC). Use `now() AT TIME ZONE 'UTC'` in raw SQL.
12. **One transaction = one connection.** Never `Promise.all` queries on the same `tx`; use `sequential([...])` from `src/server/db.ts` (Prisma queries are lazy, so they run in order). The driver adapter also serializes each transaction's statements (Prisma itself sends an `include`'s relation queries concurrently), and tests run with `--throw-deprecation`, so any overlap fails CI.
13. **Modules.** A permission that belongs to an optional module must be listed in `MODULE_PERMISSIONS` (`src/server/modules/catalog.ts`); features without their own permission (e.g. the dental chart) check `ctx.modules.has(...)` in the service.
14. **Nothing may leave its box, on any screen.** Money only through `moneyFormatter()` (it lets the currency, never the digits, wrap); lists of records use `<Table>` (phone = cards; give ambiguous numeric cells a `label`); no fixed widths on text; grid/flex children that hold tables must be able to shrink (`min-w-0`, already global for `.grid > *`). Verify with `npm run ui:audit` and real large sums (tens of millions of so'm).
15. **Be honest about status.** Mark simulated/prototype functionality as such (e.g. the `dev-outbox` SMS and Telegram transports, the Integrations status page, modules with `status: "planned"`). Don't call a feature done without tests.

16. **Sign-in = login + password only.** No email anywhere and no Telegram sign-in for staff or the console. Accounts get a login + first password from their administrator (at least 8 characters, no other rule); a forgotten password is replaced by the clinic's Administrator (Staff page). Telegram serves patients only (clinic bots: notifications, Mini App). Never add email fields, email sending, or Telegram sign-in.

## Layout
- `prisma/schema.prisma`, `prisma/migrations/*` (RLS/grants/audit SQL lives in migrations)
- `src/server/` — domain services (no React): `auth/`, `authz/`, `tenancy/`, `clinic/`, `security/`, `audit.ts`, `db.ts`
- `src/app/admin/` platform console · `src/app/c/[slug]/` clinic workspace · `src/app/p/[slug]/` patient portal · `src/app/(public)/` login, password reset · `src/app/auth/telegram/webapp` patients' Mini App sign-in
- `src/components/ui` design system · `src/components/shell` app chrome
- `docs/` product, architecture, security, roadmap
