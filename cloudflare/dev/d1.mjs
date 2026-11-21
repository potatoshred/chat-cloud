/**
 * 本地测试用的 D1 替身：用 node:sqlite 实现 worker 用到的那一小部分 D1 API。
 * 只用于 node --test，不参与部署。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const toSqlValue = (value) => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return value
}

const fromRow = (row) => {
  if (!row) return null
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Uint8Array
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value
  }
  return out
}

export const createD1 = (path = ':memory:') => {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')

  const executions = new WeakMap()
  const statement = (sql, args) => {
    const execute = () => {
      const result = db.prepare(sql).run(...args.map(toSqlValue))
      return {
        success: true,
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      }
    }
    const prepared = {
      bind: (...next) => statement(sql, next),
      all: async () => ({
        results: db
          .prepare(sql)
          .all(...args.map(toSqlValue))
          .map(fromRow),
        success: true,
        meta: {},
      }),
      first: async () => fromRow(db.prepare(sql).get(...args.map(toSqlValue))),
      run: async () => execute(),
    }
    executions.set(prepared, execute)
    return prepared
  }

  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      db.exec('BEGIN')
      try {
        // 真正的 D1 批次不会让其他请求插入事务中间。
        const results = statements.map((item) => executions.get(item)())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

/** 建表：与 wrangler 部署时执行的 schema.sql 完全一致。 */
export const migrate = (d1, path = new URL('../schema.sql', import.meta.url)) => {
  d1.exec(readFileSync(path, 'utf8'))
  d1.exec("INSERT OR IGNORE INTO meta VALUES ('generation', 'test-generation')")
  d1.exec("INSERT OR IGNORE INTO meta VALUES ('version', '0')")
}
