/**
 * Lightweight Supabase REST client for Cloudflare Workers.
 * Handles both plain string secrets and Secrets Store object bindings.
 */

function resolveSecret(val) {
    if (!val) return undefined
    // Secrets Store delivers an object with a .get() method
    if (typeof val === 'object' && typeof val.get === 'function') return val.get()
    // Plain string (legacy env var)
    if (typeof val === 'string') return val
    // Fallback — try toString
    return String(val)
  }
  
  export class SupabaseClient {
    constructor(url, key) {
      const resolvedUrl = resolveSecret(url)
      const resolvedKey = resolveSecret(key)
  
      if (!resolvedUrl) throw new Error('Missing secret: SUPABASE_URL is not set on this Worker')
      if (!resolvedKey) throw new Error('Missing secret: SUPABASE_SERVICE_KEY is not set on this Worker')
  
      this.url = resolvedUrl.replace(/\/$/, '')
      this.key = resolvedKey
      this.headers = {
        apikey:         resolvedKey,
        Authorization:  `Bearer ${resolvedKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
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
  
    async select(table, params = '')  { return this._request('GET',    table, null, params) }
    async insert(table, row)          { const r = await this._request('POST',  table, row);  return Array.isArray(r) ? r[0] : r }
    async update(table, row, params)  { return this._request('PATCH',  table, row, params) }
    async delete(table, params)       { return this._request('DELETE', table, null, params) }
  }
  
  export function getClient(env) {
    return new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  }