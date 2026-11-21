import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { env } from "./env";

/**
 * Three physically separate connection pools, one per PostgreSQL role:
 *
 *  - appDb       → itopmed_app       clinic workspaces, Row-Level Security enforced.
 *                   Must ONLY be used through `withAppContext`, which binds the
 *                   tenant/user for the duration of one transaction.
 *  - platformDb  → itopmed_platform  ITop Med administration. The role has no
 *                   grants on clinical tables, so platform code cannot read
 *                   medical records even if it tried.
 *  - portalDb    → itopmed_portal    patient portal. Policies derive the patient from
 *                   the presented session hash inside PostgreSQL; the role sees only
 *                   that patient's own released data and has no grants on clinical notes.
 */
type Clients = { app?: PrismaClient; platform?: PrismaClient; portal?: PrismaClient };
const g = globalThis as unknown as { __itmDb?: Clients };
const clients: Clients = (g.__itmDb ??= {});

function make(url: string) {
  // Pool size per app instance; tune with DB_POOL_MAX to the database max_connections budget.
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  return new PrismaClient({ adapter: serialTransactions(new PrismaPg({ connectionString: url, max: Number.isFinite(max) && max > 0 ? max : 10, idleTimeoutMillis: 30_000 })) });
}

type QueuedTx = { queryRaw(...a: unknown[]): Promise<unknown>; executeRaw(...a: unknown[]): Promise<unknown>; commit(): Promise<unknown>; rollback(): Promise<unknown> };

/**
 * One transaction = one connection, and node-pg runs one query at a time per
 * connection. Prisma's query interpreter still sends some statements of one
 * transaction concurrently (e.g. the relations of an `include`), which node-pg
 * only queues internally — deprecated, and removed in pg 9. This wraps the
 * driver adapter so each transaction's statements (and its commit/rollback)
 * go out strictly one after another, in the order Prisma issued them.
 */
function serialTransactions<F extends { connect(): Promise<unknown> }>(factory: F): F {
  const connect = factory.connect.bind(factory);
  (factory as { connect(): Promise<unknown> }).connect = async () => {
    const adapter = (await connect()) as { startTransaction(...a: unknown[]): Promise<QueuedTx> };
    const start = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args: unknown[]) => inOrder(await start(...args));
    return adapter;
  };
  return factory;
}

function inOrder(tx: QueuedTx): QueuedTx {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  for (const m of ["queryRaw", "executeRaw"] as const) {
    const f = tx[m].bind(tx);
    tx[m] = (...a: unknown[]) => queue(() => f(...a));
  }
  for (const m of ["commit", "rollback"] as const) {
    const f = tx[m].bind(tx);
    tx[m] = () => queue(() => f());
  }
  return tx;
}

function appClient(): PrismaClient {
  return (clients.app ??= make(env().DATABASE_URL));
}

export function platformDb(): PrismaClient {
  return (clients.platform ??= make(env().PLATFORM_DATABASE_URL));
}

function portalClient(): PrismaClient {
  return (clients.portal ??= make(env().PORTAL_DATABASE_URL));
}

export type Tx = Prisma.TransactionClient;

/**
 * Runs several queries of ONE transaction one after another. A transaction
 * owns a single connection, so Promise.all would only queue them inside the
 * driver (deprecated by node-pg). Prisma query promises are lazy — they start
 * when awaited — so awaiting them in order runs them sequentially.
 */
export async function sequential<T extends readonly unknown[]>(queries: readonly [...{ [K in keyof T]: PromiseLike<T[K]> }]): Promise<T> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await q);
  return out as unknown as T;
}

export interface AppContext {
  tenantId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  inviteTokenHash?: string | null;
  resetTokenHash?: string | null;
}

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * Runs `fn` in a transaction whose PostgreSQL session variables carry the
 * request context. RLS policies read these via app_current_tenant() etc.
 * `set_config(..., true)` scopes values to this transaction only, so pooled
 * connections can never leak context between requests.
 */
export async function withAppContext<T>(ctx: AppContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appClient().$transaction(async (tx) => {
    await setContext(tx, ctx);
    return fn(tx);
  }, TX_OPTIONS);
}

export async function setContext(tx: Tx, ctx: AppContext) {
  await tx.$queryRaw`SELECT
    set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true),
    set_config('app.user_id', ${ctx.userId ?? ""}, true),
    set_config('app.session_id', ${ctx.sessionId ?? ""}, true),
    set_config('app.invite_token_hash', ${ctx.inviteTokenHash ?? ""}, true),
    set_config('app.reset_token_hash', ${ctx.resetTokenHash ?? ""}, true)`;
}

/**
 * Patient portal transaction. Only the session hash (or, during activation,
 * the activation-code hash) is passed in; who the patient is, is decided by
 * the database from that value.
 */
export async function withPortal<T>(ctx: { sessionId?: string | null; inviteTokenHash?: string | null }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return portalClient().$transaction(async (tx) => {
    await setContext(tx, { sessionId: ctx.sessionId, inviteTokenHash: ctx.inviteTokenHash });
    return fn(tx);
  }, TX_OPTIONS);
}

export async function withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return platformDb().$transaction(fn, TX_OPTIONS);
}

/** For tests and graceful shutdown. */
export async function disconnectAll() {
  await Promise.all([clients.app?.$disconnect(), clients.platform?.$disconnect(), clients.portal?.$disconnect()]);
  clients.app = undefined;
  clients.platform = undefined;
  clients.portal = undefined;
}
