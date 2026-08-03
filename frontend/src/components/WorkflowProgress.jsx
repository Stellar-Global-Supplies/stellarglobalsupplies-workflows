/**
 * WorkflowProgress — reusable live progress panel
 * Polls /workflows/:runId/status every 2s and shows step-by-step progress.
 * Works for ALL workflows — just pass the right stepLabels map.
 *
 * Usage:
 *   <WorkflowProgress
 *     runId={runId}
 *     onComplete={(status) => ...}
 *     onClose={() => setRunId(null)}
 *     stepLabels={PAYMENT_STEPS}
 *   />
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle, XCircle, Clock, Loader2, ChevronDown, ChevronUp, X, AlertTriangle, Pause, Play, Square } from 'lucide-react'
import { getWorkflowStatus, stopWorkflow, pauseWorkflow, continueWorkflow } from '../services/api'
import toast from 'react-hot-toast'

// ── Step label maps per workflow type ─────────────────────────────────────

export const PAYMENT_STEPS = {
  payment_fetch_overdue:        'Fetching overdue orders',
  payment_bedrock_draft_email:  'AI drafting payment email',
  payment_approval_gate:        'Sending for approval',
  payment_send_email:           'Sending email to customer',
}

export const SOCIAL_STEPS = {
  social_get_orders:             'Fetching recent orders',
  social_bedrock_generate_post:  'AI generating social content',
  social_image_submit:           'Submitting image generation',
  social_image_poll:             'Generating image',
  social_post_to_platforms:      'Publishing to platforms',
}

export const BLOG_STEPS = {
  blog_generate_outline:   'AI generating blog outline',
  blog_generate_content:   'AI writing full blog post',
  blog_image_submit:       'Submitting image generation',
  blog_image_poll:         'Generating blog image',
  blog_create_github_pr:   'Creating GitHub pull request',
}

export const LEAD_GEN_STEPS = {
  lead_tavily_find_company:    'Searching for real companies',
  lead_groq_extract_company:   'Extracting company data',
  lead_check_duplicate:        'Checking for duplicates',
  lead_tavily_find_contact:    'Finding decision maker',
  lead_tavily_scrape_website:  'Scraping company website',
  lead_groq_extract_email:     'Extracting contact email',
  lead_save:                   'Saving lead to database',
  lead_bedrock_draft_email:    'AI drafting outreach email',
  lead_send_email:             'Sending outreach email',
}

export const LEAD_EMAIL_STEPS = {
  lead_load_existing:       'Loading lead data',
  lead_bedrock_draft_email: 'AI drafting outreach email',
  lead_send_email:          'Sending outreach email',
}

// ── Status colours ─────────────────────────────────────────────────────────

const STATUS = {
  pending:                { icon: Clock,    colour: 'text-slate-400', bg: 'bg-slate-50',   label: 'Waiting' },
  running:                { icon: Loader2,  colour: 'text-blue-500',  bg: 'bg-blue-50',    label: 'Running', spin: true },
  done:                   { icon: CheckCircle, colour: 'text-emerald-500', bg: 'bg-emerald-50', label: 'Done' },
  failed:                 { icon: XCircle,  colour: 'text-red-500',   bg: 'bg-red-50',     label: 'Failed' },
  waiting_for_approval:   { icon: Clock,    colour: 'text-amber-500', bg: 'bg-amber-50',   label: 'Awaiting approval' },
}

// ── WorkflowProgress ───────────────────────────────────────────────────────

export default function WorkflowProgress({ runId, onComplete, onClose, stepLabels = {} }) {
  const [jobs,       setJobs]       = useState([])
  const [runStatus,  setRunStatus]  = useState('running')
  const [error,      setError]      = useState(null)
  const [expanded,   setExpanded]   = useState(true)
  const [elapsed,    setElapsed]    = useState(0)
  const startRef   = useRef(Date.now())
  const intervalRef = useRef(null)
  const timerRef   = useRef(null)
  const doneRef    = useRef(false)

  // Poll status every 2s
  useEffect(() => {
    if (!runId) return

    // Reset state for new workflow
    setJobs([])
    setRunStatus('running')
    setError(null)
    doneRef.current = false
    startRef.current = Date.now()

    async function poll() {
      try {
        const data = await getWorkflowStatus(runId)
        setJobs(data.jobs || [])
        setRunStatus(data.status || 'running')

        const terminal = ['succeeded','failed','awaiting_approval'].includes(data.status)
        if (terminal && !doneRef.current) {
          doneRef.current = true
          clearInterval(intervalRef.current)
          clearInterval(timerRef.current)
          onComplete?.(data.status)
        }
      } catch (e) {
        setError(e.message)
        clearInterval(intervalRef.current)
        clearInterval(timerRef.current)
      }
    }

    const POLL_INTERVAL = parseInt(import.meta.env.VITE_POLL_INTERVAL) || 2000
    poll()
    intervalRef.current = setInterval(poll, POLL_INTERVAL)
    timerRef.current    = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)

    return () => {
      clearInterval(intervalRef.current)
      clearInterval(timerRef.current)
    }
  }, [runId])

  // Enrich jobs with labels
  const enriched = jobs.map(job => ({
    ...job,
    label: stepLabels[job.step_name] || job.step_name.replace(/_/g, ' '),
  }))

  const isTerminal  = ['succeeded','failed','awaiting_approval'].includes(runStatus)
  const hasFailed   = runStatus === 'failed' || jobs.some(j => j.status === 'failed')
  const isApproval  = runStatus === 'awaiting_approval'
  const isSuccess   = runStatus === 'succeeded'
  const isPaused     = runStatus === 'paused'
  const isRunning    = runStatus === 'running'

  const headerBg = hasFailed   ? 'bg-red-600'
    : isApproval  ? 'bg-amber-500'
    : isSuccess   ? 'bg-emerald-600'
    : isPaused    ? 'bg-slate-500'
    : 'bg-navy'

  const headerLabel = hasFailed  ? 'Workflow failed'
    : isApproval ? 'Awaiting your approval'
    : isSuccess  ? 'Workflow complete'
    : isPaused   ? 'Workflow paused'
    : 'Workflow running…'

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  async function handleControl(action) {
    try {
      if (action === 'stop')       await stopWorkflow(runId)
      else if (action === 'pause')  await pauseWorkflow(runId)
      else if (action === 'continue') await continueWorkflow(runId)
      toast.success(`Workflow ${action}ed`)
      // Refresh status immediately
      const data = await getWorkflowStatus(runId)
      setJobs(data.jobs || [])
      setRunStatus(data.status || 'running')
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm bg-white">

      {/* Header */}
      <div className={`${headerBg} px-4 py-3 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          {!isTerminal && !isPaused && <Loader2 size={15} className="text-white/80 animate-spin" />}
          {isSuccess   && <CheckCircle size={15} className="text-white" />}
          {hasFailed   && <XCircle     size={15} className="text-white" />}
          {isApproval  && <Clock       size={15} className="text-white" />}
          {isPaused    && <Pause       size={15} className="text-white" />}
          <span className="text-white text-sm font-semibold">{headerLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-white/70 text-xs font-mono">{elapsedStr}</span>
          {/* Control buttons — only show when not terminal */}
          {!isTerminal && !isApproval && (
            <>
              {isPaused ? (
                <button onClick={() => handleControl('continue')} title="Continue"
                  className="text-white/70 hover:text-white transition-colors">
                  <Play size={14}/>
                </button>
              ) : (
                <button onClick={() => handleControl('pause')} title="Pause"
                  className="text-white/70 hover:text-white transition-colors">
                  <Pause size={14}/>
                </button>
              )}
              <button onClick={() => handleControl('stop')} title="Stop"
                className="text-white/70 hover:text-red-300 transition-colors">
                <Square size={13}/>
              </button>
            </>
          )}
          <button onClick={() => setExpanded(v => !v)}
            className="text-white/70 hover:text-white transition-colors">
            {expanded ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
          </button>
          {isTerminal && (
            <button onClick={onClose} className="text-white/70 hover:text-white transition-colors ml-1">
              <X size={15}/>
            </button>
          )}
        </div>
      </div>

      {/* Steps */}
      {expanded && (
        <div className="divide-y divide-slate-50">
          {error && (
            <div className="flex items-center gap-2 px-4 py-3 bg-red-50">
              <AlertTriangle size={13} className="text-red-500 flex-shrink-0"/>
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}

          {enriched.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-4">
              <Loader2 size={13} className="text-slate-400 animate-spin"/>
              <p className="text-xs text-slate-500">Starting workflow…</p>
            </div>
          )}

          {enriched.map((job, i) => {
            const s = STATUS[job.status] || STATUS.pending
            const Icon = s.icon
            const duration = job.picked_up_at && job.completed_at
              ? Math.round((new Date(job.completed_at) - new Date(job.picked_up_at)) / 1000)
              : null

            return (
              <div key={job.id || i}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${s.bg}`}>

                {/* Step number or icon */}
                <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
                  {job.status === 'done' ? (
                    <CheckCircle size={16} className="text-emerald-500"/>
                  ) : job.status === 'failed' ? (
                    <XCircle size={16} className="text-red-500"/>
                  ) : job.status === 'running' ? (
                    <Loader2 size={16} className="text-blue-500 animate-spin"/>
                  ) : job.status === 'waiting_for_approval' ? (
                    <Clock size={16} className="text-amber-500"/>
                  ) : (
                    <span className="text-xs font-medium text-slate-400 w-full text-center">{i + 1}</span>
                  )}
                </div>

                {/* Label */}
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium truncate
                    ${job.status === 'done'                 ? 'text-emerald-700'
                    : job.status === 'failed'               ? 'text-red-700'
                    : job.status === 'running'              ? 'text-blue-700'
                    : job.status === 'waiting_for_approval' ? 'text-amber-700'
                    : 'text-slate-400'}`}>
                    {job.label}
                  </p>
                  {job.status === 'failed' && job.error_msg && (
                    <p className="text-xs text-red-500 mt-0.5 truncate">{job.error_msg}</p>
                  )}
                  {job.status === 'waiting_for_approval' && (
                    <p className="text-xs text-amber-600 mt-0.5">Check Approval Queue →</p>
                  )}
                </div>

                {/* Duration */}
                {duration !== null && (
                  <span className="text-xs text-slate-400 font-mono flex-shrink-0">{duration}s</span>
                )}

                {/* Status pill */}
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0
                  ${job.status === 'done'                 ? 'bg-emerald-100 text-emerald-700'
                  : job.status === 'failed'               ? 'bg-red-100 text-red-700'
                  : job.status === 'running'              ? 'bg-blue-100 text-blue-700'
                  : job.status === 'waiting_for_approval' ? 'bg-amber-100 text-amber-700'
                  : 'bg-slate-100 text-slate-400'}`}>
                  {s.label}
                </span>
              </div>
            )
          })}

          {/* Terminal messages */}
          {isApproval && !hasFailed && (
            <div className="flex items-center gap-2 px-4 py-3 bg-amber-50 border-t border-amber-100">
              <Clock size={13} className="text-amber-500 flex-shrink-0"/>
              <p className="text-xs text-amber-700">
                A notification has been sent. Review the draft in the
                <strong> Approval Queue</strong> to send.
              </p>
            </div>
          )}
          {isSuccess && (
            <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border-t border-emerald-100">
              <CheckCircle size={13} className="text-emerald-500 flex-shrink-0"/>
              <p className="text-xs text-emerald-700 font-medium">All steps completed successfully.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}