import { useState }              from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getLeads }  from '../services/api'
import { PageHeader, EmptyState, Skeleton } from '../components/ui'
import WorkflowProgress, { LEAD_GEN_STEPS, LEAD_GEN_PROMO_STEPS } from '../components/WorkflowProgress'
import {
  Users, MapPin, Play, RefreshCw,
  Globe, Mail, Phone, Building2,
  CheckCircle, Clock, AlertTriangle, Eye,
  Target,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

// ── Stellar products context (shown in UI so users understand what's targeted) ──
const PRODUCTS = [
  { name: 'MS Angles, Flats & Channels',  buyers: 'Steel fabricators, EPC contractors' },
  { name: 'MS Pipes & Square Tubes',      buyers: 'HVAC, plumbing, furniture makers' },
  { name: 'MS Sheet & Chequered Plate',   buyers: 'Press shops, auto ancillaries' },
  { name: 'Stainless Steel Products',     buyers: 'Food processing, pharma, hospitality' },
  { name: 'Industrial Fasteners',         buyers: 'OEM manufacturers, machine builders' },
]

// ── Promo products — fastener/locking line, fixed ICP (MIDC, medium/large, bulk) ──
const PROMO_PRODUCTS = [
  { name: 'MS Nylock Nuts',    detail: 'Vibration-resistant lock nuts' },
  { name: 'Nord-Lock Washers', detail: 'Wedge-locking washers' },
  { name: 'Internal Circlips', detail: 'DIN 472 retaining rings' },
  { name: 'External Circlips', detail: 'DIN 471 retaining rings' },
]

const STATUS_CONFIG = {
  pending:      { label: 'Pending',      dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-50'   },
  emailed:      { label: 'Emailed',      dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  needs_review: { label: 'Needs Review', dot: 'bg-slate-400',   text: 'text-slate-600',   bg: 'bg-slate-50'   },
  converted:    { label: 'Converted',    dot: 'bg-blue-400',    text: 'text-blue-700',     bg: 'bg-blue-50'    },
  rejected:     { label: 'Rejected',     dot: 'bg-red-400',     text: 'text-red-600',      bg: 'bg-red-50'     },
}

// ── Quick location presets ────────────────────────────────────────────────────
const PRESETS = [
  'Pune, Maharashtra',
  'Mumbai, Maharashtra',
  'Chennai, Tamil Nadu',
  'Ahmedabad, Gujarat',
  'Bengaluru, Karnataka',
  'Hyderabad, Telangana',
  'Delhi NCR',
  'Coimbatore, Tamil Nadu',
  'Surat, Gujarat',
  'Rajkot, Gujarat',
]

export default function LeadGeneration() {
  const qc = useQueryClient()
  const [mode,         setMode]         = useState('location') // 'location' | 'promo'
  const [location,    setLocation]    = useState('')
  const [promoProduct, setPromoProduct] = useState('')
  const [launching,   setLaunching]   = useState(false)
  const [activeRunId, setActiveRunId] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')

  const { data, isLoading, refetch } = useQuery({
    queryKey:       ['leads', statusFilter],
    queryFn:        () => getLeads(
      statusFilter === 'all' ? 'order=created_at.desc&limit=100'
                             : `status=eq.${statusFilter}&order=created_at.desc&limit=100`
    ),
    refetchInterval: 30_000,
  })
  const leads = data?.leads || []

  async function handleLaunch(e) {
    e?.preventDefault()
    const loc = location.trim()
    if (!loc) { toast.error('Please enter a location'); return }

    setLaunching(true)
    setActiveRunId(null)
    try {
      const res = await startWorkflow('lead-generation', { location: loc })
      setActiveRunId(res.workflowRunId)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLaunching(false)
    }
  }

  async function handleLaunchPromo(e) {
    e?.preventDefault()
    if (!promoProduct) { toast.error('Please select a product'); return }

    setLaunching(true)
    setActiveRunId(null)
    try {
      const res = await startWorkflow('lead-generation-promo', { product_name: promoProduct })
      setActiveRunId(res.workflowRunId)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLaunching(false)
    }
  }

  function handleComplete(status) {
    if (status === 'awaiting_approval') {
      toast.success('Lead found — check Approval Queue to review and send email')
      qc.invalidateQueries({ queryKey: ['pending-approvals-count'] })
    } else if (status === 'succeeded') {
      toast.success('Lead saved — needs email review')
      qc.invalidateQueries({ queryKey: ['leads'] })
    } else if (status === 'stopped') {
      toast('Company already in database — skipped', { icon: '⚠️' })
    } else if (status === 'failed') {
      toast.error('Workflow failed — check progress panel for details')
    }
    qc.invalidateQueries({ queryKey: ['leads'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const FILTERS = ['all','pending','emailed','needs_review','converted','rejected']

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Users} title="Lead Generation"
        sub="Enter a location — AI finds real buyer companies for Stellar's products and drafts a personalised outreach email">
        <button onClick={() => refetch()} className="btn-secondary">
          <RefreshCw size={14} /> Refresh
        </button>
      </PageHeader>

      {/* ── Mode Toggle ──────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5 mb-5 w-fit">
        <button onClick={() => setMode('location')}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors
            ${mode === 'location' ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-navy'}`}>
          <MapPin size={13} /> By Location
        </button>
        <button onClick={() => setMode('promo')}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors
            ${mode === 'promo' ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-navy'}`}>
          <Target size={13} /> By Promo Product
        </button>
      </div>

      {/* ── Launch Panel — By Location ───────────────────────────────────── */}
      {mode === 'location' && (
      <div className="card p-5 mb-5">
        <p className="text-sm font-semibold text-navy mb-4 flex items-center gap-2">
          <MapPin size={15} className="text-amber" /> Find Leads by Location
        </p>

        {/* Location input */}
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1">
            <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={location}
              onChange={e => setLocation(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLaunch()}
              placeholder="e.g. Pune, Mumbai, Chennai, Ahmedabad…"
              className="input pl-8 w-full"
            />
          </div>
          <button
            onClick={handleLaunch}
            disabled={launching || !location.trim()}
            className="btn-primary gap-2 px-5 disabled:opacity-50 whitespace-nowrap">
            {launching
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Finding…</>
              : <><Play size={14} />Find Lead</>
            }
          </button>
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-1.5 mb-5">
          {PRESETS.map(p => (
            <button key={p}
              onClick={() => setLocation(p)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors
                ${location === p
                  ? 'bg-navy text-white border-navy'
                  : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300'}`}>
              {p}
            </button>
          ))}
        </div>

        {/* Product targeting info */}
        <div className="border border-slate-100 rounded-xl overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              What the AI targets — rotates automatically across each run
            </p>
          </div>
          <div className="divide-y divide-slate-50">
            {PRODUCTS.map(p => (
              <div key={p.name} className="flex items-center gap-4 px-4 py-2.5">
                <div className="w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0" />
                <span className="text-xs font-medium text-navy w-52 flex-shrink-0">{p.name}</span>
                <span className="text-xs text-slate-400">{p.buyers}</span>
              </div>
            ))}
          </div>
          <div className="bg-blue-50 px-4 py-2.5 border-t border-blue-100">
            <p className="text-xs text-blue-700">
              <strong>How it works:</strong> Each run automatically selects a different product category and buyer industry
              for your location — so running it multiple times finds diverse leads across all 5 product lines.
            </p>
          </div>
        </div>
      </div>
      )}

      {/* ── Launch Panel — By Promo Product ──────────────────────────────── */}
      {mode === 'promo' && (
      <div className="card p-5 mb-5">
        <p className="text-sm font-semibold text-navy mb-4 flex items-center gap-2">
          <Target size={15} className="text-amber" /> Find Leads by Promo Product
        </p>

        {/* Product picker */}
        <div className="flex gap-3 mb-4">
          <div className="grid grid-cols-2 gap-2 flex-1">
            {PROMO_PRODUCTS.map(p => (
              <button key={p.name} type="button"
                onClick={() => setPromoProduct(p.name)}
                className={`text-left px-3 py-2.5 rounded-xl border transition-colors
                  ${promoProduct === p.name
                    ? 'bg-navy text-white border-navy'
                    : 'bg-white text-navy border-slate-200 hover:border-slate-300'}`}>
                <span className="block text-xs font-semibold">{p.name}</span>
                <span className={`block text-xs mt-0.5 ${promoProduct === p.name ? 'text-white/70' : 'text-slate-400'}`}>
                  {p.detail}
                </span>
              </button>
            ))}
          </div>
          <button
            onClick={handleLaunchPromo}
            disabled={launching || !promoProduct}
            className="btn-primary gap-2 px-5 disabled:opacity-50 whitespace-nowrap self-start">
            {launching
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Finding…</>
              : <><Play size={14} />Find Lead</>
            }
          </button>
        </div>

        {/* Fixed ICP info */}
        <div className="border border-slate-100 rounded-xl overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Fixed target profile — same for every run, only the product changes
            </p>
          </div>
          <div className="divide-y divide-slate-50">
            <div className="flex items-center gap-4 px-4 py-2.5">
              <div className="w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0" />
              <span className="text-xs font-medium text-navy w-32 flex-shrink-0">Sectors</span>
              <span className="text-xs text-slate-400">Manufacturing, Automotive, Aerospace, Construction, Engineering</span>
            </div>
            <div className="flex items-center gap-4 px-4 py-2.5">
              <div className="w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0" />
              <span className="text-xs font-medium text-navy w-32 flex-shrink-0">Business size</span>
              <span className="text-xs text-slate-400">Medium to large enterprises</span>
            </div>
            <div className="flex items-center gap-4 px-4 py-2.5">
              <div className="w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0" />
              <span className="text-xs font-medium text-navy w-32 flex-shrink-0">Geography</span>
              <span className="text-xs text-slate-400">Maharashtra MIDC industrial hubs (rotates each run)</span>
            </div>
            <div className="flex items-center gap-4 px-4 py-2.5">
              <div className="w-1.5 h-1.5 rounded-full bg-amber flex-shrink-0" />
              <span className="text-xs font-medium text-navy w-32 flex-shrink-0">Intent</span>
              <span className="text-xs text-slate-400">Regular, recurring bulk orders — long-term supply partnership fit</span>
            </div>
          </div>
          <div className="bg-blue-50 px-4 py-2.5 border-t border-blue-100">
            <p className="text-xs text-blue-700">
              <strong>How it works:</strong> Just pick a product — the workflow rotates through Maharashtra's MIDC hubs
              and manufacturing sectors automatically, so running it multiple times finds diverse leads across the belt.
            </p>
          </div>
        </div>
      </div>
      )}

      {/* ── Live Progress ─────────────────────────────────────────────────── */}
      {activeRunId && (
        <div className="mb-5">
          <WorkflowProgress
            runId={activeRunId}
            stepLabels={mode === 'promo' ? LEAD_GEN_PROMO_STEPS : LEAD_GEN_STEPS}
            onComplete={handleComplete}
            onClose={() => setActiveRunId(null)}
          />
        </div>
      )}

      {/* ── Leads Table ──────────────────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
          <span className="text-sm font-semibold text-navy">
            Leads ({leads.length})
          </span>
          <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
            {FILTERS.map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors
                  ${statusFilter === f ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-navy'}`}>
                {f.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : leads.length === 0 ? (
          <EmptyState icon={Users}
            title={statusFilter === 'all' ? 'No leads yet' : `No ${statusFilter.replace(/_/g,' ')} leads`}
            sub="Enter a location above and click Find Lead to start generating prospects" />
        ) : (
          <div className="divide-y divide-slate-50">
            {leads.map(lead => {
              const cfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG.pending
              return (
                <div key={lead.id} className="px-5 py-4 hover:bg-slate-50/60 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${cfg.dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-semibold text-navy text-sm">{lead.company_name}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.bg} ${cfg.text}`}>
                          {cfg.label}
                        </span>
                        {lead.industry && (
                          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                            {lead.industry}
                          </span>
                        )}
                        {lead.needs_review && (
                          <span className="flex items-center gap-1 text-xs text-amber-600">
                            <AlertTriangle size={10} /> Needs review
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-4 flex-wrap text-xs text-slate-500">
                        {lead.contact_name && (
                          <span className="flex items-center gap-1">
                            <Users size={11} />{lead.contact_name}
                            {lead.contact_role ? ` · ${lead.contact_role}` : ''}
                          </span>
                        )}
                        {lead.email && (
                          <a href={`mailto:${lead.email}`}
                            className="flex items-center gap-1 hover:text-navy transition-colors">
                            <Mail size={11} />{lead.email}
                          </a>
                        )}
                        {lead.phone && (
                          <a href={`tel:${lead.phone}`}
                            className="flex items-center gap-1 hover:text-navy transition-colors">
                            <Phone size={11} />{lead.phone}
                          </a>
                        )}
                        {lead.website && (
                          <a href={lead.website} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 hover:text-navy transition-colors">
                            <Globe size={11} />{lead.website.replace(/^https?:\/\/(www\.)?/, '')}
                          </a>
                        )}
                        {lead.address && (
                          <span className="flex items-center gap-1">
                            <MapPin size={11} />{lead.address}
                          </span>
                        )}
                        <span className="text-slate-300">
                          {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                        </span>
                      </div>

                      {lead.description && (
                        <p className="mt-1.5 text-xs text-slate-400 italic line-clamp-2">
                          {lead.description}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}