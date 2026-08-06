/**
 * Shared utilities — mirrors backend/lambdas/shared/utils.py
 */

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  }
  
  export function ok(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
  
  export function err(msg, status = 400) {
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
  
  export function preflight() {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  
  export function nowIso() {
    return new Date().toISOString()
  }
  
  export function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
  }
  
  export function contentHash(text) {
    // Simple djb2 hash (no crypto needed for dedup key)
    let h = 5381
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i)
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  
  /** IST → UTC: IST = UTC+5:30 */
  export function istToUtc(timeStr) {
    const [hh, mm] = timeStr.split(':').map(Number)
    let totalMin = hh * 60 + mm - 330
    if (totalMin < 0) totalMin += 1440
    return { hour: Math.floor(totalMin / 60) % 24, minute: totalMin % 60 }
  }
  
  /** Normalize days_of_week — D1 stores it as a JSON string (e.g. "[1,3]") */
  function normalizeDow(value) {
    if (Array.isArray(value)) return value
    if (typeof value === 'string' && value.trim()) {
      try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
    }
    return []
  }

  /** Build a cron expression (CF format: min hour dom month dow) from a schedule row */
  export function buildCron(schedule) {
    const { hour, minute } = istToUtc(schedule.run_time || '09:00')
    const freq = schedule.frequency || 'monthly'
  
    if (freq === 'daily')   return `${minute} ${hour} * * *`
    if (freq === 'weekly') {
      const days = normalizeDow(schedule.days_of_week)
      if (!days.length) return `${minute} ${hour} * * 1` // default to Monday
      return `${minute} ${hour} * * ${days.map(d => d % 7).join(',')}`
    }
    // monthly
    return `${minute} ${hour} ${schedule.day_of_month || 1} * *`
  }

  /** Validate IST time string format */
  export function validateIstTime(timeStr) {
    const match = timeStr?.match(/^(\d{1,2}):(\d{2})$/)
    if (!match) return false
    const hour = parseInt(match[1])
    const minute = parseInt(match[2])
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
  }
  
  /** Check if a cron expression is due at a given Date */
  export function cronIsDue(cronExpr, now = new Date()) {
    const [min, hour, dom, mon, dow] = cronExpr.split(' ')
    const match = (expr, val) => {
      if (expr === '*') return true
      return expr.split(',').some(p => {
        if (p.includes('/')) {
          const [, step] = p.split('/')
          return val % parseInt(step) === 0
        }
        return parseInt(p) === val
      })
    }
    return (
      match(min,  now.getUTCMinutes())  &&
      match(hour, now.getUTCHours())    &&
      match(dom,  now.getUTCDate())     &&
      match(mon,  now.getUTCMonth() + 1) &&
      match(dow,  now.getUTCDay())
    )
  }