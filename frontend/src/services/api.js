import { supabase } from '../lib/supabase'

const BASE = import.meta.env.VITE_API_URL

async function apiRequest(method, path, body, timeout = 30000) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { 'Content-Type': 'application/json' }
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || `API error ${res.status}`)
    return json
  } catch (e) {
    clearTimeout(timeoutId)
    if (e.name === 'AbortError') throw new Error('Request timeout — please try again')
    throw e
  }
}

// ── Workflows ──────────────────────────────────────────────
export const startWorkflow      = (type, payload) =>
  apiRequest('POST', `/workflows/${type}`, payload)

export const getWorkflowStatus  = (runId) =>
  apiRequest('GET', `/workflows/${runId}/status`)

export const stopWorkflow      = (runId) =>
  apiRequest('POST', `/workflows/${runId}/stop`)

export const pauseWorkflow     = (runId) =>
  apiRequest('POST', `/workflows/${runId}/pause`)

export const continueWorkflow  = (runId) =>
  apiRequest('POST', `/workflows/${runId}/continue`)

// ── Approvals ──────────────────────────────────────────────
export const listApprovals = (status = 'pending', workflowType = '') => {
  let qs = `status=${status}`
  if (workflowType) qs += `&workflow_type=${workflowType}`
  return apiRequest('GET', `/approvals?${qs}`)
}

export const approveItem    = (id, note = '', edits = {}) =>
  apiRequest('POST', `/approvals/${id}/approve`, { note, edits })

export const rejectItem     = (id, note = '') =>
  apiRequest('POST', `/approvals/${id}/reject`, { note })

export const regenerateItem = (id, feedback = '') =>
  apiRequest('POST', `/approvals/${id}/regenerate`, { feedback })

// ── Data ───────────────────────────────────────────────────
export const getDashboard        = ()      => apiRequest('GET', '/data/dashboard')
export const getLeads            = (qs='') => apiRequest('GET', `/data/leads?${qs}`)
export const getSocialPosts      = (qs='') => apiRequest('GET', `/data/social-posts?${qs}`)
export const getBlogPosts        = (qs='') => apiRequest('GET', `/data/blog-posts?${qs}`)
export const getOrders           = (qs='') => apiRequest('GET', `/data/orders?${qs}`)
export const getWorkflowRuns     = (qs='') => apiRequest('GET', `/data/workflow-runs?${qs}`)
export const getGeneratedContent = (key)   => apiRequest('GET', `/data/content?key=${encodeURIComponent(key)}`)
export const lookupOrder         = (orderId = '', productType = '') =>
  apiRequest('GET', `/data/orders/lookup?order_id=${encodeURIComponent(orderId)}&product_type=${encodeURIComponent(productType)}`)
export const repostSocialPost    = (id) => apiRequest('POST', `/data/social-posts/${id}/repost`, {})
export const publishSocialPost   = (id) => apiRequest('POST', `/data/social-posts/${id}/publish`, {})
export const republishBlogPost   = (id) => apiRequest('POST', `/data/blog-posts/${id}/republish`, {})

// ── Schedules ──────────────────────────────────────────────
export const getSchedules   = (qs = '') => apiRequest('GET',    `/schedules?${qs}`)
export const createSchedule = (body)    => apiRequest('POST',   '/schedules', body)
export const updateSchedule = (id, body)=> apiRequest('PATCH',  `/schedules/${id}`, body)
export const deleteSchedule = (id)      => apiRequest('DELETE', `/schedules/${id}`)
export const toggleSchedule = (id, enabled) => apiRequest('PATCH', `/schedules/${id}/toggle`, { enabled })