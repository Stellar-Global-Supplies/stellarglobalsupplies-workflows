import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { startWorkflow } from '../services/api'
import { PageHeader } from '../components/ui'
import WorkflowProgress, { TECH_JOB_STEPS } from '../components/WorkflowProgress'
import {
  Activity, Play, Database, BarChart3, Cloud, RefreshCw, Brain, Trash2,
} from 'lucide-react'
import toast from 'react-hot-toast'

const JOBS = [
  {
    key:        'cur-forwarder',
    title:      'CUR Forwarder',
    icon:       BarChart3,
    color:      'bg-blue-50 text-blue-700 border-blue-200',
    iconBg:     'bg-blue-600',
    schedule:   'Every 8 hours (cron)',
    description:
      'Reads AWS Cost & Usage Report JSON files from Supabase Storage, deduplicates metrics, pushes gauges to New Relic under aws.cur.v2.*, and deletes consumed files.',
    whatItDoes: [
      'Downloads 5 CUR JSON files from Supabase Storage (cur-forwarder/)',
      'Deduplicates per-row by fingerprint stored in Cloudflare KV',
      'Pushes new/revised metrics as gauges to New Relic Metric API',
      'Deletes consumed files after successful processing',
    ],
    secrets: ['NEW_RELIC_LICENSE_KEY'],
  },
  {
    key:        'postgres-forwarder',
    title:      'Postgres Forwarder',
    icon:       Database,
    color:      'bg-emerald-50 text-emerald-700 border-emerald-200',
    iconBg:     'bg-emerald-600',
    schedule:   'Every hour (cron)',
    description:
      'Collects pg_stat_* metrics from Supabase and NeonDB Postgres and ships them to New Relic EU as separate namespaces (supabase.* and neon.*).',
    whatItDoes: [
      'Connects to Supabase + NeonDB in parallel',
      'Collects db size, connections, table stats, bgwriter, statements',
      'Deduplicates per-source by SHA-256 fingerprint in KV',
      'Ships to New Relic with per-source service.name tags',
    ],
    secrets: ['NEW_RELIC_LICENSE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ADMIN_NEON_DB_URL'],
  },
  {
    key:        's3-cleanup',
    title:      'S3 Cleanup',
    icon:       Trash2,
    color:      'bg-orange-50 text-orange-700 border-orange-200',
    iconBg:     'bg-orange-600',
    schedule:   'Daily at 02:00 UTC (cron)',
    description:
      'Enforces per-bucket object-age retention policies across all Stellar S3 buckets and ships structured cleanup logs to New Relic EU.',
    whatItDoes: [
      'Scans 7 S3 bucket/prefix policies for expired objects',
      'Skips blog-images/ and other excluded prefixes',
      'Batch-deletes expired objects (up to 1000 per request)',
      'Ships per-bucket cleanup events to New Relic Log API',
    ],
    secrets: ['BEDROCK_ACCESS_KEY_ID', 'BEDROCK_SECRET_ACCESS_KEY', 'BEDROCK_REGION', 'NEW_RELIC_LICENSE_KEY'],
  },
  {
    key:        'ai-sync',
    title:      'AI Sync',
    icon:       Brain,
    color:      'bg-purple-50 text-purple-700 border-purple-200',
    iconBg:     'bg-purple-600',
    schedule:   'Every hour (cron)',
    description:
      'Syncs whitelisted business data from Supabase to Neon Postgres for Stellar AI enterprise context — no PII ever leaves the platform.',
    whatItDoes: [
      'Fetches whitelisted columns from 9 Supabase tables (paginated)',
      'Aggregates orders & quotes into monthly buckets — raw rows never reach Neon',
      'Ensures Neon schema and upserts everything (never deletes)',
      'Writes per-table results to _sync_log audit table',
    ],
    secrets: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ADMIN_NEON_DB_URL'],
  },
]

export default function TechJobs() {
  const qc = useQueryClient()
  const [activeRun, setActiveRun] = useState(null) // { key, runId }
  const [running,  setRunning]   = useState(null) // job key

  async function launch(jobKey) {
    setRunning(jobKey)
    setActiveRun(null)
    try {
      const res = await startWorkflow(jobKey, {})
      setActiveRun({ key: jobKey, runId: res.workflowRunId })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(null)
    }
  }

  function handleComplete(status) {
    if (status === 'succeeded') {
      toast.success('Forwarder run completed successfully')
    } else if (status === 'failed') {
      toast.error('Forwarder run failed — check progress panel for details')
    } else if (status === 'stopped') {
      toast('Forwarder run stopped', { icon: '⚠️' })
    }
    qc.invalidateQueries({ queryKey: ['workflow-runs'] })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader icon={Activity} title="Tech Jobs"
        sub="On-demand triggers for internal Cloudflare Workers — monitor live progress and run history" />

      {/* Active workflow progress */}
      {activeRun && (
        <div className="mb-6">
          <WorkflowProgress
            runId={activeRun.runId}
            stepLabels={TECH_JOB_STEPS}
            onComplete={handleComplete}
            onClose={() => setActiveRun(null)}
          />
        </div>
      )}

      {/* Job cards */}
      <div className="grid md:grid-cols-2 gap-5">
        {JOBS.map(job => {
          const Icon     = job.icon
          const isActive = activeRun?.key === job.key

          return (
            <div key={job.key} className="card overflow-hidden flex flex-col">
              {/* Header */}
              <div className="p-5 border-b border-slate-100">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-xl ${job.iconBg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={18} className="text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="font-semibold text-navy text-sm">{job.title}</h2>
                    <p className="flex items-center gap-1 text-xs text-slate-400">
                      <Cloud size={11} /> {job.schedule}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${job.color}`}>
                    Worker
                  </span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {job.description}
                </p>
              </div>

              {/* What it does */}
              <div className="px-5 py-4 flex-1">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                  What It Does
                </p>
                <ul className="space-y-2">
                  {job.whatItDoes.map(item => (
                    <li key={item} className="flex items-start gap-2 text-xs text-slate-700">
                      <RefreshCw size={12} className="text-slate-400 flex-shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Details + trigger */}
              <div className="px-5 py-4 border-t border-slate-100 bg-slate-50/60">
                <div className="mb-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                    Required Secrets
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {job.secrets.map(s => (
                      <code key={s} className="text-[11px] bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-600 font-mono">
                        {s}
                      </code>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => launch(job.key)}
                  disabled={running !== null || isActive}
                  className="btn-primary w-full justify-center py-2.5 disabled:opacity-50"
                >
                  {running === job.key ? (
                    <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Starting…</>
                  ) : isActive ? (
                    <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Running…</>
                  ) : (
                    <><Play size={14} /> Run Now</>
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Note */}
      <div className="mt-6 flex items-start gap-2.5 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
        <Activity size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-blue-700 leading-relaxed">
          <p className="font-medium mb-1">Automated runs still happen via cron</p>
          <p>
            All workers keep their own Cloudflare Cron schedules —
            <code className="bg-white/60 px-1 rounded">0 */8 * * *</code> for CUR,
            <code className="bg-white/60 px-1 rounded">0 * * * *</code> for Postgres &amp; AI Sync,
            <code className="bg-white/60 px-1 rounded">0 2 * * *</code> for S3 Cleanup.
            This page is for on-demand runs with live workflow progress.
          </p>
        </div>
      </div>
    </div>
  )
}