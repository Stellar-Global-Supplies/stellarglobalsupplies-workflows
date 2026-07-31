/**
 * Lightweight Supabase REST client for Cloudflare Workers.
 * Secrets Store bindings require async .get() to unwrap the value.
 */

async function resolveSecret(val) {
    if (!val) return undefined
    // Secrets Store binding — async .get()
    if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
    // Plain string
    if (typeof val === 'string') return val
    return String(val)
  }
  
  export class SupabaseClient {
    constructor(url, key) {
      // Store raw values — resolve async in _init()
      this._rawUrl = url
      this._rawKey = key
      this._ready  = null
    }
  
    async _init() {
      if (this._ready) return
      this.url = await resolveSecret(this._rawUrl)
      this.key = await resolveSecret(this._rawKey)
  
      if (!this.url) throw new Error('Missing secret: SUPABASE_URL is not set')
      if (!this.key) throw new Error('Missing secret: SUPABASE_SERVICE_KEY is not set')
  
      this.url = this.url.replace(/\/$/, '')
      this.headers = {
        apikey:         this.key,
        Authorization:  `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
      }
      this._ready = true
    }
  
    async _request(method, table, body = null, params = '') {
      await this._init()
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