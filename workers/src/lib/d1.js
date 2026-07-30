/**
 * D1 client for Cloudflare Workers.
 * Wraps env.DB (D1 binding) with a clean API.
 *
 * Stores: job_queue, workflow_runs, workflow_schedules, approval_queue
 *
 * env.DB = D1 binding (set in wrangler.toml)
 */

export class D1Client {
    constructor(db) {
      this.db = db
    }
  
    /**
     * Select rows. params is a plain object of filters:
     * { status: 'pending', workflow_type: 'blog' }
     * Plus optional: _order, _limit, _offset, _select
     */
    async select(table, params = {}) {
      const { _order, _limit = 100, _offset = 0, _select = '*', ...filters } = params
  
      let sql    = `SELECT ${_select} FROM ${table}`
      const args = []
      const where = []
  
      for (const [key, val] of Object.entries(filters)) {
        if (val === null) {
          where.push(`${key} IS NULL`)
        } else if (typeof val === 'object' && val._in) {
          const placeholders = val._in.map(() => '?').join(',')
          where.push(`${key} IN (${placeholders})`)
          args.push(...val._in)
        } else if (typeof val === 'object' && val._neq !== undefined) {
          where.push(`${key} != ?`)
          args.push(val._neq)
        } else {
          where.push(`${key} = ?`)
          args.push(val)
        }
      }
  
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`
      if (_order)       sql += ` ORDER BY ${_order}`
      if (_limit)       sql += ` LIMIT ${_limit}`
      if (_offset)      sql += ` OFFSET ${_offset}`
  
      const result = await this.db.prepare(sql).bind(...args).all()
      return result.results || []
    }
  
    /** Insert a row. Returns the inserted row. */
    async insert(table, row) {
      // Serialize any objects/arrays to JSON strings for D1
      const serialized = serializeRow(row)
      const keys   = Object.keys(serialized)
      const values = Object.values(serialized)
      const placeholders = keys.map(() => '?').join(', ')
  
      const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`
      const result = await this.db.prepare(sql).bind(...values).first()
      return result ? deserializeRow(result) : null
    }
  
    /** Update rows matching filters. Returns count of updated rows. */
    async update(table, updates, filters = {}) {
      const serialized = serializeRow(updates)
      const setClauses   = Object.keys(serialized).map(k => `${k} = ?`)
      const setValues    = Object.values(serialized)
  
      const whereClauses = []
      const whereValues  = []
      for (const [k, v] of Object.entries(filters)) {
        whereClauses.push(`${k} = ?`)
        whereValues.push(v)
      }
  
      let sql = `UPDATE ${table} SET ${setClauses.join(', ')}`
      if (whereClauses.length) sql += ` WHERE ${whereClauses.join(' AND ')}`
  
      await this.db.prepare(sql).bind(...setValues, ...whereValues).run()
    }
  
    /** Delete rows matching filters. */
    async delete(table, filters = {}) {
      const whereClauses = Object.keys(filters).map(k => `${k} = ?`)
      const whereValues  = Object.values(filters)
  
      let sql = `DELETE FROM ${table}`
      if (whereClauses.length) sql += ` WHERE ${whereClauses.join(' AND ')}`
  
      await this.db.prepare(sql).bind(...whereValues).run()
    }
  }
  
  export function getD1(env) {
    return new D1Client(env.DB)
  }
  
  /** Serialize objects/arrays to JSON strings for D1 storage */
  function serializeRow(row) {
    const out = {}
    for (const [k, v] of Object.entries(row)) {
      out[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
    }
    return out
  }
  
  /** Deserialize JSON string columns back to objects */
  function deserializeRow(row) {
    const out = {}
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v)
          // Only deserialize if it's actually an object/array, not a plain string
          out[k] = (parsed !== null && typeof parsed === 'object') ? parsed : v
        } catch {
          out[k] = v
        }
      } else {
        out[k] = v
      }
    }
    return out
  }