import { supabase } from '../lib/supabase'

const BASE = import.meta.env.VITE_API_URL

async function apiRequest(method, path, body) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { 'Content-Type': 'application/json' }
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `API error ${res.status}`)
  return json
}

// ── Workflows ──────────────────────────────────────────────
export const startWorkflow = (type, payload) =>
  apiRequest('POST', `/workflows/${type}`, payload)

// ── Approvals ──────────────────────────────────────────────
export const listApprovals = (status = 'pending', workflowType = '') => {
  let qs = `status=${status}`
  if (workflowType) qs += `&workflow_type=${workflowType}`
  return apiRequest('GET', `/approvals?${qs}`)
}

export const approveItem = (id, note = '') =>
  apiRequest('POST', `/approvals/${id}/approve`, { note })

export const rejectItem = (id, note = '') =>
  apiRequest('POST', `/approvals/${id}/reject`, { note })

// ── Data ───────────────────────────────────────────────────
export const getDashboard    = ()       => apiRequest('GET', '/data/dashboard')
export const getLeads        = (qs='')  => apiRequest('GET', `/data/leads?${qs}`)
export const getSocialPosts  = (qs='')  => apiRequest('GET', `/data/social-posts?${qs}`)
export const getBlogPosts    = (qs='')  => apiRequest('GET', `/data/blog-posts?${qs}`)
export const getWorkflowRuns = (qs='')  => apiRequest('GET', `/data/workflow-runs?${qs}`)
