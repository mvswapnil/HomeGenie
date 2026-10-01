import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

// timestamptz → ISO strings, not Date objects, so values round-trip into the shared types unchanged.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    const out = await fn(tx);
    await tx.query("commit");
    return out;
  } catch (err) {
    await tx.query("rollback").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
