import { Fragment, useState } from 'react'
import { useQuery }           from '@tanstack/react-query'
import { getWorkflowRuns }    from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import WorkflowProgress, {
  PAYMENT_STEPS, SOCIAL_STEPS, BLOG_STEPS,
  LEAD_GEN_STEPS, LEAD_EMAIL_STEPS,
} from '../components/WorkflowProgress'
import {
  Activity, ChevronDown, ChevronRight,
  RefreshCw, AlertTriangle,
} from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUSES = ['all', 'running', 'awaiting_approval', 'succeeded', 'failed', 'stopped', 'timed_out']

const WF_LABELS = {
  lead_generation:     'Lead Generation',
  lead_email_existing: 'Lead Re-email',
  social_product:      'Product Post',
  social_tech:         'Tech Post',
  blog:                'Blog Post',
  payment_followup:    'Payment Follow-up',
}

// Map workflow_type → step labels for WorkflowProgress
const STEP_LABELS_MAP = {
  lead_generation:     LEAD_GEN_STEPS,
  lead_email_existing: LEAD_EMAIL_STEPS,
  social_product:      SOCIAL_STEPS,
  social_tech:         SOCIAL_STEPS,
  blog:                BLOG_STEPS,
  payment_followup:    PAYMENT_STEPS,
}

const STATUS_DOT = {
  running:            'bg-blue-400 animate-pulse',
  awaiting_approval:  'bg-amber-400',
  succeeded:          'bg-emerald-400',
  failed:             'bg-red-400',
  stopped:            'bg-slate-400',
  timed_out:          'bg-red-300',
}

function durationStr(run) {
  const end   = run.completed_at ? new Date(run.completed_at) : new Date()
  const start = new Date(run.started_at)
  const secs  = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60)  return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`
}

// ── RunDetail ─────────────────────────────────────────────────────────────────
// Shows WorkflowProgress for live runs, step list + JSON for completed runs

function RunDetail({ run }) {
  const isLive    = ['running', 'awaiting_approval'].includes(run.status)
  const stepLabels = STEP_LABELS_MAP[run.workflow_type] || {}

  return (
    <div className="px-5 py-4 bg-slate-50/70 border-t border-slate-100">
      {/* WorkflowProgress handles both live (polling) and completed (single fetch) */}
      <WorkflowProgress
        runId={run.id}
        stepLabels={stepLabels}
        pollInterval={isLive ? 2000 : null}  // null = fetch once, no polling
        onComplete={null}                     // no callback needed here
        onClose={null}                        // no close button in embedded mode
        embedded                              // compact embedded variant
      />

      {/* Input / Output JSON for context */}
      {(run.input || run.output || run.error_msg) && (
        <div className="mt-4 grid gap-3 md:grid-cols-3 text-xs">
          {run.input && (
            <div>
              <p className="font-semibold text-slate-500 mb-1">Input</p>
              <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap text-slate-600">
                {JSON.stringify(typeof run.input === 'string' ? JSON.parse(run.input) : run.input, null, 2)}
              </pre>
            </div>
          )}
          {run.output && (
            <div>
              <p className="font-semibold text-slate-500 mb-1">Output</p>
              <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap text-slate-600">
                {JSON.stringify(typeof run.output === 'string' ? JSON.parse(run.output) : run.output, null, 2)}
              </pre>
            </div>
          )}
          {run.error_msg && (
            <div>
              <p className="font-semibold text-red-500 mb-1">Error</p>
              <pre className="bg-red-50 border border-red-100 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap text-red-700">
                {run.error_msg}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ── WorkflowRuns Page ─────────────────────────────────────────────────────────

export default function WorkflowRuns() {
  const [status,    setStatus]    = useState('all')
  const [openRunId, setOpenRunId] = useState(null)

  const qs = status === 'all' ? 'limit=100' : `status=${status}&limit=100`

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey:       ['workflow-runs-page', status],
    queryFn:        () => getWorkflowRuns(qs),
    refetchInterval: ['running', 'all'].includes(status) ? 10_000 : false,
  })
  const runs = data?.runs || []

  function toggleRun(id) {
    setOpenRunId(prev => prev === id ? null : id)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={Activity} title="Workflow Runs"
        sub="Click any run to see step-by-step progress and execution details">
        <button onClick={() => refetch()} className="btn-secondary" disabled={isFetching}>
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh
        </button>
      </PageHeader>

      {/* Status filter tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6 flex-wrap">
        {STATUSES.map(s => (
          <button key={s} onClick={() => { setStatus(s); setOpenRunId(null) }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize
              ${status === s ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-medium text-navy">Runs ({runs.length})</span>
          {runs.some(r => r.status === 'running') && (
            <span className="flex items-center gap-1.5 text-xs text-blue-600">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Live updating
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : runs.length === 0 ? (
          <EmptyState icon={Activity} title="No workflow runs found"
            sub="Launch a workflow to see execution history here" />
        ) : (
          <div>
            {runs.map(run => {
              const isOpen = openRunId === run.id
              const isLive = ['running', 'awaiting_approval'].includes(run.status)
              const dot    = STATUS_DOT[run.status] || 'bg-slate-300'

              return (
                <Fragment key={run.id}>
                  {/* Run row */}
                  <button
                    onClick={() => toggleRun(run.id)}
                    className={`w-full text-left flex items-center gap-4 px-5 py-3.5 transition-colors border-b border-slate-50
                      ${isOpen ? 'bg-slate-50' : 'hover:bg-slate-50/60'}`}>

                    {/* Status dot */}
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />

                    {/* Workflow type */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-navy">
                          {WF_LABELS[run.workflow_type] || run.workflow_type?.replace(/_/g, ' ')}
                        </span>
                        <StatusBadge status={run.status} />
                        {isLive && (
                          <span className="text-xs text-blue-600 font-medium">● Live</span>
                        )}
                        {run.status === 'failed' && run.error_msg && (
                          <span className="flex items-center gap-1 text-xs text-red-500">
                            <AlertTriangle size={11} /> Failed
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-400">
                        <span>{format(new Date(run.started_at), 'dd MMM yy HH:mm')}</span>
                        <span>·</span>
                        <span>{formatDistanceToNowStrict(new Date(run.started_at), { addSuffix: true })}</span>
                        <span>·</span>
                        <span>{durationStr(run)}</span>
                        {parseFloat(run.cost_usd || 0) > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-emerald-600 font-medium">
                              ${parseFloat(run.cost_usd).toFixed(4)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Run ID */}
                    <span className="text-xs text-slate-300 font-mono hidden md:block flex-shrink-0">
                      {run.id.slice(0, 8)}
                    </span>

                    {/* Expand icon */}
                    <div className="text-slate-400 flex-shrink-0">
                      {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isOpen && <RunDetail run={run} />}
                </Fragment>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}