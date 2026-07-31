/**
 * Lightweight Supabase REST client for Cloudflare Workers.
 */
export class SupabaseClient {
    constructor(url, key) {
      if (!url) throw new Error('Missing secret: SUPABASE_URL is not set on this Worker')
      if (!key) throw new Error('Missing secret: SUPABASE_SERVICE_KEY is not set on this Worker')
      this.url = url.replace(/\/$/, '')
      this.key = key
      this.headers = {
        apikey:         key,
        Authorization:  `Bearer ${key}`,
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