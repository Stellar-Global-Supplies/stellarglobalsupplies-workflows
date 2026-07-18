import { Loader2 } from 'lucide-react'

// ── StatusBadge ────────────────────────────────────────────
export function StatusBadge({ status }) {
  const map = {
    pending:    'badge-pending',
    draft:      'badge-draft',
    approved:   'badge-approved',
    sent:       'badge-sent',
    posted:     'badge-posted',
    rejected:   'badge-rejected',
    running:    'badge-running',
    succeeded:  'badge-approved',
    failed:     'badge-rejected',
    pr_created: 'badge-pr_created',
    emailed:    'badge-sent',
    followed_up:'badge-sent',
    converted:  'badge-approved',
    partial:    'badge-pending',
  }
  return (
    <span className={map[status] ?? 'badge bg-slate-100 text-slate-500 border border-slate-200'}>
      {status?.replace(/_/g, ' ')}
    </span>
  )
}

// ── Spinner ────────────────────────────────────────────────
export function Spinner({ size = 16 }) {
  return <Loader2 size={size} className="animate-spin text-navy" />
}

// ── EmptyState ────────────────────────────────────────────
export function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center mb-4"><Icon size={24} className="text-slate-400" /></div>}
      <p className="font-medium text-slate-700">{title}</p>
      {sub && <p className="text-sm text-slate-400 mt-1">{sub}</p>}
    </div>
  )
}

// ── PageHeader ─────────────────────────────────────────────
export function PageHeader({ icon: Icon, title, sub, children }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="w-10 h-10 rounded-xl bg-navy flex items-center justify-center flex-shrink-0">
            <Icon size={20} className="text-white" />
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold text-navy">{title}</h1>
          {sub && <p className="text-sm text-slate-500 mt-0.5">{sub}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

// ── StatCard ───────────────────────────────────────────────
export function StatCard({ label, value, sub, accent }) {
  return (
    <div className="card p-5">
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-3xl font-bold ${accent || 'text-navy'}`}>{value ?? '—'}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  )
}

// ── Skeleton ───────────────────────────────────────────────
export function Skeleton({ className = '' }) {
  return <div className={`shimmer rounded-lg ${className}`} />
}

// ── Modal ──────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, width = 'max-w-lg' }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative z-10 bg-white rounded-2xl shadow-panel w-full ${width} max-h-[90vh] overflow-y-auto`}>
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-navy">{title}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors text-xl leading-none">×</button>
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

// ── FormField ─────────────────────────────────────────────
export function FormField({ label, children, hint }) {
  return (
    <div>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}

// ── WorkflowPipeline ───────────────────────────────────────
export function WorkflowPipeline({ steps, currentStep }) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, i) => {
        const done    = i < currentStep
        const active  = i === currentStep
        const pending = i > currentStep
        return (
          <div key={i} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2
                ${done    ? 'bg-emerald-500 border-emerald-500 text-white'
                  : active  ? 'bg-royal border-royal text-white'
                  : 'bg-white border-slate-300 text-slate-400'}`}>
                {done ? '✓' : i + 1}
              </div>
              <span className={`text-xs whitespace-nowrap ${active ? 'text-navy font-medium' : 'text-slate-400'}`}>{step}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`h-0.5 w-8 mx-1 mb-4 ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}
