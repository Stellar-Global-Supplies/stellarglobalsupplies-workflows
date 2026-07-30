/**
 * Lightweight Supabase REST client for Cloudflare Workers.
 * Mirrors the Python SupabaseClient in shared/supabase_client.py exactly.
 */
export class SupabaseClient {
    constructor(url, key) {
      this.url = url.replace(/\/$/, '')
      this.key = key
      this.headers = {
        apikey:        key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer:        'return=representation',
      }
    }
  
    async _request(method, table, body = null, params = '') {
      let url = `${this.url}/rest/v1/${table}`
      if (params) url += `?${params}`
  
      const res = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
      })
  
      const text = await res.text()
      if (!res.ok) throw new Error(`Supabase ${method} ${table} failed ${res.status}: ${text}`)
      return text ? JSON.parse(text) : []
    }
  
    async select(table, params = '')  { return this._request('GET',    table, null,  params) }
    async insert(table, row)          { const r = await this._request('POST',   table, row);   return Array.isArray(r) ? r[0] : r }
    async update(table, row, params)  { return this._request('PATCH',  table, row,   params) }
    async delete(table, params)       { return this._request('DELETE', table, null,  params) }
    async upsert(table, row, onConflict = '') {
      const params = onConflict ? `on_conflict=${onConflict}` : ''
      const saved  = this._headers_with({ Prefer: 'return=representation,resolution=merge-duplicates' },
        () => this._request('POST', table, row, params))
      return saved
    }
  
    _headers_with(extra, fn) {
      const orig = { ...this.headers }
      Object.assign(this.headers, extra)
      const result = fn()
      this.headers = orig
      return result
    }
  }
  
  export function getClient(env) {
    return new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  }