import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { startWorkflow } from '../services/api'
import { PageHeader } from '../components/ui'
import WorkflowProgress, { TECH_JOB_STEPS } from '../components/WorkflowProgress'
import {
  Activity, Play, Database, BarChart3, Cloud, RefreshCw, Brain,
  Trash2, Mail, Send, ChevronDown, ChevronUp, X,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ─── Simple tech jobs (no parameters) ───────────────────────────────────────
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
  {
    key:        'brevo-sync',
    title:      'Brevo Contact Sync',
    icon:       Mail,
    color:      'bg-sky-50 text-sky-700 border-sky-200',
    iconBg:     'bg-sky-600',
    schedule:   'Every 6 hours (D1 schedule)',
    description:
      'Fetches marketing contacts from Supabase (orders, quote_customers, leads), mirrors them into NeonDB slim tables, then batch-imports them into 4 separate Brevo lists.',
    whatItDoes: [
      'Pulls orders, quote_customers, leads from Supabase REST API (paginated)',
      'Upserts contact rows into NeonDB orders_contacts, quote_contacts, leads_contacts',
      'Reads word_emails from NeonDB (manually imported from Word docs)',
      'Batch-imports into 4 Brevo lists — creates lists automatically if missing',
    ],
    secrets: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ADMIN_NEON_DB_URL', 'BREVO_API_KEY'],
  },
]

// ─── Default form values ─────────────────────────────────────────────────────
const DEFAULT_CAMPAIGN_FORM = {
  productTitle:    '',
  productSubtitle: '',
  productImageUrl: '',
  productDesc:     '',
  campaignSubject: '',
  listIds:         '',
  campaignName:    '',
  heroEyebrow:     'Featured Product',
  ctaUrl:          'https://www.stellarglobalsupplies.com/contact',
  availableSizes:  'M5 × 0.80\nM6 × 1.00\nM8 × 1.25\nM10 × 1.00\nM10 × 1.50',
  scheduledAt:     '',
  showAdvanced:    false,
}

// ─── Campaign Card ───────────────────────────────────────────────────────────
function CampaignCard({ activeRun, running, onLaunch }) {
  const [expanded, setExpanded] = useState(false)
  const [form, setForm]         = useState(DEFAULT_CAMPAIGN_FORM)

  const isActive  = activeRun?.key === 'brevo-campaign'
  const isBusy    = running !== null || isActive

  function field(key, value) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function parseAndValidate() {
    const listIds = form.listIds
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n > 0)

    if (!form.productTitle.trim())    return { error: 'Product title is required' }
    if (!form.productSubtitle.trim()) return { error: 'Product subtitle is required' }
    if (!form.productImageUrl.trim()) return { error: 'Product image URL is required' }
    if (!form.productDesc.trim())     return { error: 'Product description is required' }
    if (!form.campaignSubject.trim()) return { error: 'Email subject is required' }
    if (!listIds.length)              return { error: 'At least one Brevo list ID is required' }

    const sizes = form.availableSizes.trim()
      ? form.availableSizes.trim().split('\n')
          .map(line => {
            const parts = line.trim().split(/\s+/)
            return { size: parts[0] || '', pitch: parts.slice(1).join(' ') }
          })
          .filter(s => s.size && s.pitch)
      : []

    const payload = {
      productTitle:    form.productTitle.trim(),
      productSubtitle: form.productSubtitle.trim(),
      productImageUrl: form.productImageUrl.trim(),
      productDesc:     form.productDesc.trim(),
      campaignSubject: form.campaignSubject.trim(),
      listIds,
    }

    if (form.campaignName.trim())  payload.campaignName  = form.campaignName.trim()
    if (form.heroEyebrow.trim())   payload.heroEyebrow   = form.heroEyebrow.trim()
    if (form.ctaUrl.trim())        payload.ctaUrl        = form.ctaUrl.trim()
    if (sizes.length)              payload.availableSizes = sizes
    if (form.scheduledAt)          payload.scheduledAt   = new Date(form.scheduledAt).toISOString()

    return { payload }
  }

  function handleSubmit() {
    const { error, payload } = parseAndValidate()
    if (error) { toast.error(error); return }
    onLaunch('brevo-campaign', payload)
    setExpanded(false)
  }

  return (
    <div className="card overflow-hidden flex flex-col md:col-span-2">
      {/* Header */}
      <div className="p-5 border-b border-slate-100">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-amber-600 flex items-center justify-center flex-shrink-0">
            <Send size={18} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-navy text-sm">Brevo Email Campaign</h2>
            <p className="flex items-center gap-1 text-xs text-slate-400">
              <Cloud size={11} /> On-demand (configure below)
            </p>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-amber-50 text-amber-700 border-amber-200">
            Worker
          </span>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          Builds a branded Stellar HTML email from your product parameters, creates an email campaign in Brevo,
          and sends it to the selected contact lists — all in one step.
        </p>
      </div>

      {/* What it does */}
      <div className="px-5 py-4 flex-1">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">What It Does</p>
        <ul className="space-y-2">
          {[
            'Builds the full branded Stellar HTML email from your product parameters',
            'Creates the campaign in Brevo with your subject and sender details',
            'Sends immediately to selected contact lists (or schedules for a future date)',
            'Returns campaign ID and delivery confirmation from Brevo API',
          ].map(item => (
            <li key={item} className="flex items-start gap-2 text-xs text-slate-700">
              <RefreshCw size={12} className="text-slate-400 flex-shrink-0 mt-0.5" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Footer row */}
      <div className="px-5 py-4 border-t border-slate-100 bg-slate-50/60">
        <div className="mb-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Required Secrets</p>
          <div className="flex flex-wrap gap-1.5">
            {['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'].map(s => (
              <code key={s} className="text-[11px] bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-600 font-mono">{s}</code>
            ))}
          </div>
        </div>

        {isActive ? (
          <button disabled className="btn-primary w-full justify-center py-2.5 opacity-50">
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Running…
          </button>
        ) : (
          <button
            onClick={() => setExpanded(e => !e)}
            disabled={running !== null}
            className="btn-primary w-full justify-center py-2.5 disabled:opacity-50"
          >
            {expanded ? <><X size={14} /> Cancel</> : <><Send size={14} /> Configure &amp; Send Campaign</>}
            {!expanded && <ChevronDown size={14} className="ml-auto" />}
            {expanded  && null}
          </button>
        )}
      </div>

      {/* ── Inline Campaign Form ─────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t-2 border-amber-200 bg-amber-50/30">
          {/* Required fields */}
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <h3 className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-4 flex items-center gap-2">
                <span className="flex-1 h-px bg-slate-200" />
                Campaign Content
                <span className="flex-1 h-px bg-slate-200" />
              </h3>
            </div>

            {/* Product Title */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Product Title <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.productTitle}
                onChange={e => field('productTitle', e.target.value)}
                placeholder="MS Nylock Nuts"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white"
              />
            </div>

            {/* Product Subtitle */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Product Subtitle <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.productSubtitle}
                onChange={e => field('productSubtitle', e.target.value)}
                placeholder="DIN 982 Standard"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white"
              />
            </div>

            {/* Product Image URL */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Product Image URL <span className="text-red-500">*</span>
              </label>
              <input
                type="url"
                value={form.productImageUrl}
                onChange={e => field('productImageUrl', e.target.value)}
                placeholder="https://your-storage.supabase.co/..."
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white"
              />
            </div>

            {/* Product Description */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Product Description <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={3}
                value={form.productDesc}
                onChange={e => field('productDesc', e.target.value)}
                placeholder="Engineered for vibration-resistant fastening, our premium products deliver secure and reliable performance…"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white resize-none"
              />
            </div>

            {/* Campaign Subject */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Email Subject Line <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.campaignSubject}
                onChange={e => field('campaignSubject', e.target.value)}
                placeholder="Premium MS Nylock Nuts — DIN 982 Standard | Stellar Global Supplies"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white"
              />
            </div>

            {/* List IDs */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Brevo List IDs <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.listIds}
                onChange={e => field('listIds', e.target.value)}
                placeholder="1, 2, 3"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Comma-separated. Find IDs in Brevo → Contacts → Lists.
              </p>
            </div>

            {/* Available Sizes */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Available Sizes <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <textarea
                rows={5}
                value={form.availableSizes}
                onChange={e => field('availableSizes', e.target.value)}
                placeholder={"M5 × 0.80\nM6 × 1.00\nM8 × 1.25"}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-white font-mono resize-none"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                One per line: <code className="bg-white border border-slate-200 rounded px-1">Size × Pitch</code> — leave blank to omit the sizes table.
              </p>
            </div>
          </div>

          {/* Advanced toggle */}
          <div className="px-5 pb-2">
            <button
              type="button"
              onClick={() => field('showAdvanced', !form.showAdvanced)}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 font-medium"
            >
              {form.showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {form.showAdvanced ? 'Hide' : 'Show'} Advanced Options
            </button>
          </div>

          {form.showAdvanced && (
            <div className="px-5 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <div className="h-px bg-slate-200 mb-4" />
              </div>

              {/* Campaign Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Internal Campaign Name</label>
                <input
                  type="text"
                  value={form.campaignName}
                  onChange={e => field('campaignName', e.target.value)}
                  placeholder="Auto-generated if blank"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                />
              </div>

              {/* Hero Eyebrow */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Hero Eyebrow Label</label>
                <input
                  type="text"
                  value={form.heroEyebrow}
                  onChange={e => field('heroEyebrow', e.target.value)}
                  placeholder="Featured Product"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                />
              </div>

              {/* CTA URL */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">CTA Button URL</label>
                <input
                  type="url"
                  value={form.ctaUrl}
                  onChange={e => field('ctaUrl', e.target.value)}
                  placeholder="https://www.stellarglobalsupplies.com/contact"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                />
              </div>

              {/* Scheduled At */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Schedule Send At <span className="text-slate-400 font-normal">(leave blank = send now)</span>
                </label>
                <input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={e => field('scheduledAt', e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                />
              </div>
            </div>
          )}

          {/* Submit */}
          <div className="px-5 pb-5">
            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                disabled={isBusy}
                className="flex-1 btn-primary justify-center py-3 disabled:opacity-50 text-sm"
              >
                <Send size={15} />
                {form.scheduledAt ? 'Schedule Campaign' : 'Send Campaign Now'}
              </button>
              <button
                onClick={() => { setExpanded(false); setForm(DEFAULT_CAMPAIGN_FORM) }}
                className="px-4 py-3 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-2 text-center">
              The email will be created in Brevo and sent immediately (or at the scheduled time). This action cannot be undone.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function TechJobs() {
  const qc = useQueryClient()
  const [activeRun, setActiveRun] = useState(null) // { key, runId }
  const [running,   setRunning]   = useState(null) // job key

  async function launch(jobKey, payload = {}) {
    setRunning(jobKey)
    setActiveRun(null)
    try {
      const res = await startWorkflow(jobKey, payload)
      setActiveRun({ key: jobKey, runId: res.workflowRunId })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(null)
    }
  }

  function handleComplete(status) {
    if (status === 'succeeded') {
      toast.success('Job completed successfully')
    } else if (status === 'failed') {
      toast.error('Job failed — check progress panel for details')
    } else if (status === 'stopped') {
      toast('Job stopped', { icon: '⚠️' })
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

      {/* Job cards grid */}
      <div className="grid md:grid-cols-2 gap-5">

        {/* Simple no-param jobs */}
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
                <p className="text-xs text-slate-600 leading-relaxed">{job.description}</p>
              </div>

              {/* What it does */}
              <div className="px-5 py-4 flex-1">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">What It Does</p>
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
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Required Secrets</p>
                  <div className="flex flex-wrap gap-1.5">
                    {job.secrets.map(s => (
                      <code key={s} className="text-[11px] bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-600 font-mono">{s}</code>
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

        {/* Campaign card — full width, has inline form */}
        <CampaignCard
          activeRun={activeRun}
          running={running}
          onLaunch={launch}
        />

      </div>

      {/* Note */}
      <div className="mt-6 flex items-start gap-2.5 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
        <Activity size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-blue-700 leading-relaxed">
          <p className="font-medium mb-1">Automated runs are scheduled via D1</p>
          <p>
            All workers are triggered by the schedule-runner reading <code className="bg-white/60 px-1 rounded">workflow_schedules</code> in D1 —
            <code className="bg-white/60 px-1 rounded">0 */8 * * *</code> for CUR,
            <code className="bg-white/60 px-1 rounded">0 * * * *</code> for Postgres &amp; AI Sync,
            <code className="bg-white/60 px-1 rounded">0 2 * * *</code> for S3 Cleanup,
            <code className="bg-white/60 px-1 rounded">0 */6 * * *</code> for Brevo Sync.
            The Email Campaign worker is triggered on-demand only — fill the form above and click Send.
          </p>
        </div>
      </div>
    </div>
  )
}