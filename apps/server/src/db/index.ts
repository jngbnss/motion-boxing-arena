// DB 접근 계층. DATABASE_URL이 있으면 PostgreSQL(pg Pool), 없으면 임베디드 PGlite.
// 둘 다 같은 `query(sql, params) → { rows }` 인터페이스 뒤에 둔다.
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { MIGRATIONS } from './migrations.ts';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** 같은 커넥션에서 BEGIN … COMMIT. 예외 시 ROLLBACK */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  private readonly lite: PGlite;
  /** PGlite는 단일 커넥션이라 트랜잭션끼리 직렬화한다 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(lite: PGlite) {
    this.lite = lite;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    const res = await this.lite.query<T>(sql, params as unknown[]);
    return { rows: res.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.lite.exec(sql);
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const run = this.chain.then(() =>
      this.lite.transaction(async (t) =>
        fn({
          query: async <R>(sql: string, params: readonly unknown[] = []) => ({
            rows: (await t.query<R>(sql, params as unknown[])).rows,
          }),
        }),
      ),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.lite.close();
  }
}

class PgDb implements Db {
  readonly kind = 'pg' as const;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async <R>(sql: string, params: readonly unknown[] = []) => ({
          rows: (await client.query(sql, params as unknown[])).rows as R[],
        }),
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface OpenDbOptions {
  /** postgres:// URL. 없으면 PGlite */
  databaseUrl?: string | null;
  /** PGlite 데이터 디렉터리. 없으면 메모리 (테스트) */
  pgliteDir?: string | null;
}

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  let db: PgliteDb | PgDb;
  if (opts.databaseUrl) {
    db = new PgDb(new pg.Pool({ connectionString: opts.databaseUrl, max: 10 }));
  } else {
    if (opts.pgliteDir) mkdirSync(opts.pgliteDir, { recursive: true });
    const lite = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
    await lite.waitReady;
    db = new PgliteDb(lite);
  }
  await migrate(db);
  return db;
}

async function migrate(db: PgliteDb | PgDb): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.tx(async (q) => {
      // 여러 문장을 담은 SQL: 파라미터 없는 simple query로 실행
      for (const stmt of splitStatements(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
  }
}

/** 마이그레이션 SQL을 문장 단위로 나눈다 (문자열 리터럴·주석 안의 ;는 고려하지 않는 단순 규칙: 우리 SQL에는 없다) */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
