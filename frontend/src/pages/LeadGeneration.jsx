import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getLeads } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, FormField, Skeleton } from '../components/ui'
import { Users, Play, ExternalLink, AlertCircle, Info } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const INDUSTRIES = ['Manufacturing','Retail','Healthcare','Logistics','Construction','Education','Hospitality','Technology','Agriculture','Finance']
const COUNTRIES  = ['India','United States','United Kingdom','Germany','UAE','Singapore','Australia','Canada','South Africa','Brazil']

export default function LeadGeneration() {
  const qc = useQueryClient()
  const [form, setForm] = useState({ target_industry: 'Manufacturing', target_country: 'India', additional_context: '' })
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState('launch')

  const { data: leadsData, isLoading } = useQuery({
    queryKey: ['leads'],
    queryFn:  () => getLeads('order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const leads = leadsData?.leads || []

  async function launch() {
    setRunning(true)
    try {
      const res = await startWorkflow('lead-generation', form)
      toast.success(`Workflow started — run ID: ${res.workflowRunId?.slice(0,8)}`)
      qc.invalidateQueries(['leads'])
      qc.invalidateQueries(['dashboard'])
      setTab('leads')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Users} title="Lead Generation" sub="AI discovers companies · Hunter.io finds real emails · Gmail sends outreach" />

      {/* Hunter.io info bar */}
      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6 text-sm text-amber-800">
        <Info size={16} className="flex-shrink-0 mt-0.5" />
        <div>
          <strong>Hunter.io Credit Policy — 50 searches/month:</strong> Each workflow first checks remaining credits.
          If credits are above the minimum reserve (3), Hunter.io finds a <em>real verified email</em> for a real company domain.
          When credits run low the workflow automatically falls back to an AI-generated free email (Gmail/Outlook/Yahoo)
          so you never waste a credit on a duplicate or already-known domain.
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['launch','leads'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
              ${tab === t ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'leads' ? `All Leads (${leads.length})` : 'Launch Workflow'}
          </button>
        ))}
      </div>

      {tab === 'launch' && (
        <div className="card p-6 max-w-lg">
          <h2 className="font-semibold text-navy mb-4">New Lead Search</h2>
          <div className="space-y-4">
            <FormField label="Target Industry">
              <select value={form.target_industry} onChange={e => setForm(f => ({...f, target_industry: e.target.value}))} className="input">
                {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
              </select>
            </FormField>
            <FormField label="Target Country / Region">
              <select value={form.target_country} onChange={e => setForm(f => ({...f, target_country: e.target.value}))} className="input">
                {COUNTRIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </FormField>
            <FormField label="Additional Context (optional)" hint="e.g. 'mid-size companies, procurement managers'">
              <textarea value={form.additional_context} onChange={e => setForm(f => ({...f, additional_context: e.target.value}))}
                className="input resize-none h-20" placeholder="Any specific targeting details…" />
            </FormField>
          </div>

          <div className="mt-5 flex flex-col gap-3">
            <button onClick={launch} disabled={running} className="btn-primary justify-center py-2.5">
              {running ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
                : <><Play size={15} /> Generate Lead</>}
            </button>
            <div className="text-xs text-slate-400 text-center">
              Workflow: AI generates company → Hunter.io email lookup → dedup check → save → draft email → await approval → send → schedule follow-up
            </div>
          </div>
        </div>
      )}

      {tab === 'leads' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">
            All Leads ({leads.length})
          </div>
          {isLoading ? (
            <div className="p-4 space-y-3">{Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-14"/>)}</div>
          ) : leads.length === 0 ? (
            <EmptyState icon={Users} title="No leads yet" sub="Launch a workflow to generate your first lead" />
          ) : (
            <div className="divide-y divide-slate-100">
              {leads.map(lead => (
                <div key={lead.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                  <div className="w-8 h-8 rounded-full bg-navy/10 flex items-center justify-center text-navy text-xs font-bold flex-shrink-0">
                    {lead.company_name?.[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-navy truncate">{lead.company_name}</span>
                      {lead.source === 'hunter.io' && (
                        <span className="badge bg-blue-50 text-blue-700 border border-blue-200 text-xs">Hunter.io</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-3">
                      <span>{lead.email}</span>
                      <span className="text-slate-300">·</span>
                      <span>{lead.industry}</span>
                      <span className="text-slate-300">·</span>
                      <span>{formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}</span>
                    </div>
                  </div>
                  <StatusBadge status={lead.status} />
                  {lead.website && (
                    <a href={lead.website} target="_blank" rel="noopener noreferrer"
                      className="text-slate-400 hover:text-navy transition-colors">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
