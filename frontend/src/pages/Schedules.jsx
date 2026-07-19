import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { getSchedules, createSchedule, updateSchedule, deleteSchedule, toggleSchedule } from '../services/api'
import { PageHeader, EmptyState, FormField, Modal, Skeleton } from '../components/ui'
import {
  CalendarClock, Plus, Pencil, Trash2, Power, PowerOff,
  Users, Share2, Code2, FileText, ChevronDown, ChevronUp,
  Clock, Calendar, Facebook, Instagram, Linkedin
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKFLOW_TYPES = [
  {
    key: 'lead-generation',
    label: 'Lead Generation',
    icon: Users,
    color: 'bg-blue-50 text-blue-700 border-blue-200',
    iconBg: 'bg-blue-600',
    description: 'AI discovers companies · Hunter.io finds emails · Gmail sends outreach',
  },
  {
    key: 'social-product',
    label: 'Product Social Post',
    icon: Share2,
    color: 'bg-pink-50 text-pink-700 border-pink-200',
    iconBg: 'bg-pink-600',
    description: 'Pull from orders → AI image + caption → approval → post to platforms',
  },
  {
    key: 'social-tech',
    label: 'Tech Showcase Post',
    icon: Code2,
    color: 'bg-purple-50 text-purple-700 border-purple-200',
    iconBg: 'bg-purple-600',
    description: 'Reads ai_context.md from S3 → AI post + image → approval → platforms',
  },
  {
    key: 'blog',
    label: 'Blog Post',
    icon: FileText,
    color: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    iconBg: 'bg-emerald-600',
    description: 'AI writes blog + featured image → approval → GitHub PR created',
  },
]

const INDUSTRIES = ['Manufacturing','Retail','Healthcare','Logistics','Construction','Education','Hospitality','Technology','Agriculture','Finance']
const COUNTRIES  = ['India','United States','United Kingdom','Germany','UAE','Singapore','Australia','Canada','South Africa','Brazil']
const BLOG_TOPICS = [
  'B2B Procurement Best Practices',
  'Supply Chain Optimisation Tips',
  'How to Choose the Right Industrial Supplier',
  'Office Supplies Buying Guide for Businesses',
  'Sustainable Procurement for Modern Companies',
]
const DAYS_OF_WEEK = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const PLATFORMS_META = [
  { key: 'facebook',  label: 'Facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', label: 'Instagram', Icon: Instagram, color: 'text-[#E1306C]' },
  { key: 'linkedin',  label: 'LinkedIn',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
]

// ─── Default parameters per workflow ──────────────────────────────────────────

function defaultParams(workflowType) {
  switch (workflowType) {
    case 'lead-generation':
      return { target_industry: 'Manufacturing', target_country: 'India', additional_context: '' }
    case 'social-product':
      return { order_id: '', product_name: '', product_type: '', prompt: '', platforms: { facebook: true, instagram: true, linkedin: false } }
    case 'social-tech':
      return { repo_name: '', prompt: '', platforms: { linkedin: true, facebook: false, instagram: false } }
    case 'blog':
      return { topic: BLOG_TOPICS[0], custom_topic: '', keywords: '', word_count: 800, custom_prompt: '', use_custom_topic: false }
    default:
      return {}
  }
}

function defaultSchedule(workflowType) {
  return {
    workflow_type: workflowType,
    label: '',
    frequency: 'monthly',
    day_of_month: 1,
    days_of_week: [1], // Monday
    run_time: '09:00',
    enabled: true,
    parameters: defaultParams(workflowType),
  }
}

// ─── Platform picker ──────────────────────────────────────────────────────────

function PlatformPicker({ value, onChange }) {
  const toggle = key => onChange({ ...value, [key]: !value[key] })
  return (
    <div className="flex gap-2 flex-wrap">
      {PLATFORMS_META.map(({ key, label, Icon, color }) => {
        const active = value?.[key]
        return (
          <button key={key} type="button" onClick={() => toggle(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all
              ${active ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-500'}`}>
            <Icon size={13} className={active ? color : ''} />
            {label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Parameter form per workflow ──────────────────────────────────────────────

function WorkflowParamForm({ workflowType, params, onChange }) {
  const set = (key, val) => onChange({ ...params, [key]: val })

  if (workflowType === 'lead-generation') return (
    <div className="space-y-3">
      <FormField label="Target Industry">
        <select value={params.target_industry} onChange={e => set('target_industry', e.target.value)} className="input">
          {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
        </select>
      </FormField>
      <FormField label="Target Country / Region">
        <select value={params.target_country} onChange={e => set('target_country', e.target.value)} className="input">
          {COUNTRIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </FormField>
      <FormField label="Additional Context" hint="e.g. 'mid-size companies, procurement managers'">
        <textarea value={params.additional_context} onChange={e => set('additional_context', e.target.value)}
          className="input resize-none h-20" placeholder="Any specific targeting details…" />
      </FormField>
    </div>
  )

  if (workflowType === 'social-product') return (
    <div className="space-y-3">
      <FormField label="Order ID" hint="Leave blank to use latest order">
        <input value={params.order_id} onChange={e => set('order_id', e.target.value)}
          className="input" placeholder="Order UUID or tracking token" />
      </FormField>
      <FormField label="Product Name" hint="Overrides order product name (optional)">
        <input value={params.product_name} onChange={e => set('product_name', e.target.value)}
          className="input" placeholder="e.g. Industrial Cleaning Bundle" />
      </FormField>
      <FormField label="Product Category" hint="Filters orders table if no order ID provided">
        <input value={params.product_type} onChange={e => set('product_type', e.target.value)}
          className="input" placeholder="e.g. Industrial, Office, Commercial" />
      </FormField>
      <FormField label="Custom Prompt (optional)" hint="Extra instructions for the AI">
        <textarea value={params.prompt} onChange={e => set('prompt', e.target.value)}
          className="input resize-none h-20" placeholder="Emphasise bulk discounts and fast delivery…" />
      </FormField>
      <FormField label="Publish To">
        <PlatformPicker value={params.platforms} onChange={v => set('platforms', v)} />
      </FormField>
    </div>
  )

  if (workflowType === 'social-tech') return (
    <div className="space-y-3">
      <FormField label="Repository Name" hint="Workflow reads {repo_name}/ai_context.md from S3">
        <input value={params.repo_name} onChange={e => set('repo_name', e.target.value)}
          className="input font-mono" placeholder="e.g. workflows-platform" />
      </FormField>
      <FormField label="Custom Prompt (optional)" hint="Extra direction beyond ai_context.md">
        <textarea value={params.prompt} onChange={e => set('prompt', e.target.value)}
          className="input resize-none h-24" placeholder="Focus on the approval workflow feature…" />
      </FormField>
      <FormField label="Publish To">
        <PlatformPicker value={params.platforms} onChange={v => set('platforms', v)} />
      </FormField>
    </div>
  )

  if (workflowType === 'blog') return (
    <div className="space-y-3">
      <FormField label="Topic">
        <select
          value={params.use_custom_topic ? 'custom' : params.topic}
          onChange={e => {
            if (e.target.value === 'custom') onChange({ ...params, use_custom_topic: true, topic: '' })
            else onChange({ ...params, use_custom_topic: false, topic: e.target.value })
          }}
          className="input">
          {BLOG_TOPICS.map(t => <option key={t} value={t}>{t}</option>)}
          <option value="custom">Custom topic…</option>
        </select>
      </FormField>
      {params.use_custom_topic && (
        <FormField label="Custom Topic">
          <input value={params.custom_topic} onChange={e => set('custom_topic', e.target.value)}
            className="input" placeholder="Your custom blog topic…" />
        </FormField>
      )}
      <FormField label="SEO Keywords" hint="Comma-separated">
        <input value={params.keywords} onChange={e => set('keywords', e.target.value)}
          className="input" placeholder="supply chain, B2B procurement, bulk supplies" />
      </FormField>
      <FormField label="Target Word Count">
        <select value={params.word_count} onChange={e => set('word_count', Number(e.target.value))} className="input">
          {[500, 700, 800, 1000, 1200, 1500].map(n => <option key={n} value={n}>{n} words</option>)}
        </select>
      </FormField>
      <FormField label="Additional Instructions (optional)">
        <textarea value={params.custom_prompt} onChange={e => set('custom_prompt', e.target.value)}
          className="input resize-none h-20" placeholder="Include a section on cost-saving strategies…" />
      </FormField>
    </div>
  )

  return null
}

// ─── Schedule form (timing section) ──────────────────────────────────────────

function ScheduleTimingForm({ form, setForm }) {
  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const toggleDow = (day) => {
    const curr = form.days_of_week || []
    const next = curr.includes(day) ? curr.filter(d => d !== day) : [...curr, day]
    set('days_of_week', next)
  }

  return (
    <div className="space-y-3">
      <FormField label="Frequency">
        <div className="flex gap-2">
          {['daily', 'weekly', 'monthly'].map(f => (
            <button key={f} type="button" onClick={() => set('frequency', f)}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium capitalize transition-all
                ${form.frequency === f ? 'bg-navy text-white border-navy' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
              {f}
            </button>
          ))}
        </div>
      </FormField>

      {form.frequency === 'monthly' && (
        <FormField label="Day of Month" hint="Schedules for the 29th–31st will only fire on months that have those days">
          <select value={form.day_of_month} onChange={e => set('day_of_month', Number(e.target.value))} className="input">
            {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
              <option key={d} value={d}>
                {d}{['st','nd','rd'][((d%100)-11)%10<3?(d%100)-11:d%10-1]||'th'} of each month
              </option>
            ))}
          </select>
        </FormField>
      )}

      {form.frequency === 'weekly' && (
        <FormField label="Days of Week">
          <div className="flex gap-1.5 flex-wrap">
            {DAYS_OF_WEEK.map((day, i) => {
              const active = (form.days_of_week || []).includes(i)
              return (
                <button key={day} type="button" onClick={() => toggleDow(i)}
                  className={`w-10 h-9 rounded-lg border text-xs font-medium transition-all
                    ${active ? 'bg-navy text-white border-navy' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                  {day}
                </button>
              )
            })}
          </div>
        </FormField>
      )}

      <FormField label="Run Time (IST)" hint="All schedules fire in Indian Standard Time (UTC+5:30)">
        <input type="time" value={form.run_time} onChange={e => set('run_time', e.target.value)}
          className="input w-36" />
      </FormField>
    </div>
  )
}

// ─── Schedule modal ───────────────────────────────────────────────────────────

function ScheduleModal({ open, onClose, editing, workflowType }) {
  const qc = useQueryClient()
  const isEdit = Boolean(editing)

  const [form, setForm] = useState(() =>
    editing ? { ...editing, parameters: { ...editing.parameters } } : defaultSchedule(workflowType)
  )
  const [section, setSection] = useState('timing') // 'timing' | 'params'

  const wf = WORKFLOW_TYPES.find(w => w.key === form.workflow_type)

  const saveMut = useMutation({
    mutationFn: () => isEdit
      ? updateSchedule(editing.id, form)
      : createSchedule(form),
    onSuccess: () => {
      toast.success(isEdit ? 'Schedule updated' : 'Schedule created')
      qc.invalidateQueries({ queryKey: ['schedules'] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  function handleSave() {
    if (!form.label.trim()) { toast.error('Please enter a label'); return }
    if (form.frequency === 'weekly' && (!form.days_of_week || form.days_of_week.length === 0)) {
      toast.error('Select at least one day of week'); return
    }
    saveMut.mutate()
  }

  return (
    <Modal open={open} onClose={onClose}
      title={isEdit ? `Edit Schedule — ${editing.label}` : `New Schedule`}
      width="max-w-xl">

      {/* Workflow type selector (only when creating) */}
      {!isEdit && (
        <div className="mb-5">
          <label className="label mb-2 block">Workflow</label>
          <div className="grid grid-cols-2 gap-2">
            {WORKFLOW_TYPES.map(w => {
              const Icon = w.icon
              const active = form.workflow_type === w.key
              return (
                <button key={w.key} type="button"
                  onClick={() => setForm(f => ({ ...defaultSchedule(w.key), label: f.label, frequency: f.frequency, day_of_month: f.day_of_month, days_of_week: f.days_of_week, run_time: f.run_time }))}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left text-sm transition-all
                    ${active ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                  <div className={`w-7 h-7 rounded-lg ${w.iconBg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={14} className="text-white" />
                  </div>
                  <span className="font-medium leading-tight">{w.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Label */}
      <div className="mb-5">
        <FormField label="Schedule Label" hint="A short name to identify this schedule">
          <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            className="input" placeholder={`e.g. "Monthly Manufacturing India" or "Weekly LinkedIn Tech"`} />
        </FormField>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 mb-5">
        {[
          { key: 'timing', label: 'Schedule Timing', icon: Clock },
          { key: 'params', label: 'Workflow Parameters', icon: wf?.icon || Calendar },
        ].map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" onClick={() => setSection(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${section === key ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {section === 'timing' && (
        <ScheduleTimingForm form={form} setForm={setForm} />
      )}

      {section === 'params' && (
        <WorkflowParamForm
          workflowType={form.workflow_type}
          params={form.parameters}
          onChange={parameters => setForm(f => ({ ...f, parameters }))}
        />
      )}

      <div className="flex gap-3 mt-6 pt-4 border-t border-slate-100">
        <button onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
        <button onClick={handleSave} disabled={saveMut.isPending} className="btn-primary flex-1 justify-center">
          {saveMut.isPending
            ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving…</>
            : isEdit ? 'Save Changes' : 'Create Schedule'}
        </button>
      </div>
    </Modal>
  )
}

// ─── Schedule card ─────────────────────────────────────────────────────────────

function ScheduleCard({ schedule, onEdit, onDelete, onToggle }) {
  const [expanded, setExpanded] = useState(false)
  const wf = WORKFLOW_TYPES.find(w => w.key === schedule.workflow_type)
  const Icon = wf?.icon || CalendarClock

  function describeSchedule(s) {
    const time = s.run_time ? `at ${s.run_time} IST` : ''
    if (s.frequency === 'daily') return `Every day ${time}`
    if (s.frequency === 'weekly') {
      const names = (s.days_of_week || []).sort().map(d => DAYS_OF_WEEK[d]).join(', ')
      return `Every ${names || '—'} ${time}`
    }
    if (s.frequency === 'monthly') {
      const d = s.day_of_month
      const suf = ['st','nd','rd'][((d%100)-11)%10<3?(d%100)-11:d%10-1]||'th'
      return `Monthly on the ${d}${suf} ${time}`
    }
    return '—'
  }

  function renderParamSummary(schedule) {
    const p = schedule.parameters || {}
    switch (schedule.workflow_type) {
      case 'lead-generation':
        return [p.target_industry, p.target_country].filter(Boolean).join(' · ')
      case 'social-product':
        return [p.product_name || p.product_type, Object.entries(p.platforms || {}).filter(([,v])=>v).map(([k])=>k).join('/')].filter(Boolean).join(' · ')
      case 'social-tech':
        return [p.repo_name && `repo: ${p.repo_name}`, Object.entries(p.platforms || {}).filter(([,v])=>v).map(([k])=>k).join('/')].filter(Boolean).join(' · ')
      case 'blog':
        return p.use_custom_topic ? p.custom_topic : p.topic
      default: return '—'
    }
  }

  return (
    <div className={`card transition-all ${!schedule.enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-4 p-4">
        {/* Icon */}
        <div className={`w-10 h-10 rounded-xl ${wf?.iconBg || 'bg-slate-500'} flex items-center justify-center flex-shrink-0`}>
          <Icon size={18} className="text-white" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-navy text-sm">{schedule.label}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${wf?.color || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
              {wf?.label}
            </span>
            {!schedule.enabled && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 border border-slate-200">disabled</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Clock size={11} />
            <span>{describeSchedule(schedule)}</span>
            {schedule.last_triggered_at && (
              <>
                <span className="text-slate-300">·</span>
                <span>Last ran {formatDistanceToNow(new Date(schedule.last_triggered_at), { addSuffix: true })}</span>
              </>
            )}
          </div>
          {renderParamSummary(schedule) && (
            <div className="text-xs text-slate-400 mt-0.5 truncate">{renderParamSummary(schedule)}</div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => onToggle(schedule)}
            title={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors
              ${schedule.enabled
                ? 'text-emerald-600 hover:bg-emerald-50'
                : 'text-slate-400 hover:bg-slate-100'}`}>
            {schedule.enabled ? <Power size={15} /> : <PowerOff size={15} />}
          </button>
          <button onClick={() => onEdit(schedule)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-navy hover:bg-slate-100 transition-colors">
            <Pencil size={15} />
          </button>
          <button onClick={() => onDelete(schedule)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors">
            <Trash2 size={15} />
          </button>
          <button onClick={() => setExpanded(v => !v)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-navy hover:bg-slate-100 transition-colors">
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </div>

      {/* Expanded params */}
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Workflow Parameters</p>
          <ExpandedParams schedule={schedule} />
        </div>
      )}
    </div>
  )
}

function ExpandedParams({ schedule }) {
  const p = schedule.parameters || {}

  if (schedule.workflow_type === 'lead-generation') return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      <div><dt className="text-slate-400 text-xs">Industry</dt><dd className="text-navy font-medium">{p.target_industry || '—'}</dd></div>
      <div><dt className="text-slate-400 text-xs">Country</dt><dd className="text-navy font-medium">{p.target_country || '—'}</dd></div>
      {p.additional_context && (
        <div className="col-span-2"><dt className="text-slate-400 text-xs">Context</dt><dd className="text-navy font-medium">{p.additional_context}</dd></div>
      )}
    </dl>
  )

  if (schedule.workflow_type === 'social-product') return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {p.product_name && <div><dt className="text-slate-400 text-xs">Product Name</dt><dd className="text-navy font-medium">{p.product_name}</dd></div>}
      {p.product_type && <div><dt className="text-slate-400 text-xs">Category</dt><dd className="text-navy font-medium">{p.product_type}</dd></div>}
      {p.order_id && <div><dt className="text-slate-400 text-xs">Order ID</dt><dd className="text-navy font-medium font-mono text-xs">{p.order_id}</dd></div>}
      <div className="col-span-2">
        <dt className="text-slate-400 text-xs mb-1">Platforms</dt>
        <dd className="flex gap-2">
          {PLATFORMS_META.map(({ key, Icon, color, label }) => (
            <span key={key} className={`flex items-center gap-1 text-xs ${p.platforms?.[key] ? color + ' font-medium' : 'text-slate-300'}`}>
              <Icon size={13} />{label}
            </span>
          ))}
        </dd>
      </div>
      {p.prompt && <div className="col-span-2"><dt className="text-slate-400 text-xs">Prompt</dt><dd className="text-navy text-xs">{p.prompt}</dd></div>}
    </dl>
  )

  if (schedule.workflow_type === 'social-tech') return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {p.repo_name && <div><dt className="text-slate-400 text-xs">Repository</dt><dd className="text-navy font-medium font-mono">{p.repo_name}</dd></div>}
      <div className="col-span-2">
        <dt className="text-slate-400 text-xs mb-1">Platforms</dt>
        <dd className="flex gap-2">
          {PLATFORMS_META.map(({ key, Icon, color, label }) => (
            <span key={key} className={`flex items-center gap-1 text-xs ${p.platforms?.[key] ? color + ' font-medium' : 'text-slate-300'}`}>
              <Icon size={13} />{label}
            </span>
          ))}
        </dd>
      </div>
      {p.prompt && <div className="col-span-2"><dt className="text-slate-400 text-xs">Prompt</dt><dd className="text-navy text-xs">{p.prompt}</dd></div>}
    </dl>
  )

  if (schedule.workflow_type === 'blog') return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      <div className="col-span-2"><dt className="text-slate-400 text-xs">Topic</dt><dd className="text-navy font-medium">{p.use_custom_topic ? p.custom_topic : p.topic}</dd></div>
      {p.keywords && <div className="col-span-2"><dt className="text-slate-400 text-xs">Keywords</dt><dd className="text-navy text-xs">{p.keywords}</dd></div>}
      <div><dt className="text-slate-400 text-xs">Word Count</dt><dd className="text-navy font-medium">{p.word_count} words</dd></div>
      {p.custom_prompt && <div className="col-span-2"><dt className="text-slate-400 text-xs">Instructions</dt><dd className="text-navy text-xs">{p.custom_prompt}</dd></div>}
    </dl>
  )

  return null
}

// ─── Workflow section (groups cards by workflow type) ─────────────────────────

function WorkflowSection({ wf, schedules, onAdd, onEdit, onDelete, onToggle }) {
  const Icon = wf.icon

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-lg ${wf.iconBg} flex items-center justify-center`}>
            <Icon size={16} className="text-white" />
          </div>
          <div>
            <h2 className="font-semibold text-navy text-sm">{wf.label}</h2>
            <p className="text-xs text-slate-400">{wf.description}</p>
          </div>
        </div>
        <button onClick={() => onAdd(wf.key)}
          className="btn-secondary text-xs py-1.5 gap-1.5">
          <Plus size={13} /> Add Schedule
        </button>
      </div>

      {schedules.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-xl py-8 text-center">
          <CalendarClock size={22} className="text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-400">No schedules yet</p>
          <button onClick={() => onAdd(wf.key)} className="text-xs text-navy hover:underline mt-1">
            Create the first one →
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map(s => (
            <ScheduleCard key={s.id} schedule={s} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Delete confirm modal ─────────────────────────────────────────────────────

function DeleteModal({ schedule, onClose }) {
  const qc = useQueryClient()
  const delMut = useMutation({
    mutationFn: () => deleteSchedule(schedule.id),
    onSuccess: () => {
      toast.success('Schedule deleted')
      qc.invalidateQueries({ queryKey: ['schedules'] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Modal open={Boolean(schedule)} onClose={onClose} title="Delete Schedule" width="max-w-sm">
      <p className="text-slate-600 text-sm mb-1">Are you sure you want to delete <strong>{schedule?.label}</strong>?</p>
      <p className="text-xs text-slate-400 mb-5">This will remove the schedule permanently. The associated EventBridge rule will need to be cleaned up separately.</p>
      <div className="flex gap-3">
        <button onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
        <button onClick={() => delMut.mutate()} disabled={delMut.isPending}
          className="flex-1 justify-center py-2 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors flex items-center gap-2">
          {delMut.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Trash2 size={14} />}
          Delete
        </button>
      </div>
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Schedules() {
  const qc = useQueryClient()
  const [modal, setModal]   = useState(null) // null | { mode: 'create'|'edit', data }
  const [delTarget, setDel] = useState(null)

  const { data, isLoading } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => getSchedules(),
    refetchInterval: 30_000,
  })
  const schedules = data?.schedules || []

  const toggleMut = useMutation({
    mutationFn: (s) => toggleSchedule(s.id, !s.enabled),
    onSuccess: (_, s) => {
      toast.success(s.enabled ? 'Schedule disabled' : 'Schedule enabled')
      qc.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const enabledCount = schedules.filter(s => s.enabled).length

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        icon={CalendarClock}
        title="Workflow Schedules"
        sub="Automate workflows on a recurring schedule — each with its own parameters and timing">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="font-medium text-navy">{enabledCount}</span> active
          <span className="text-slate-300">·</span>
          <span className="font-medium text-navy">{schedules.length - enabledCount}</span> disabled
        </div>
        <button onClick={() => setModal({ mode: 'create', workflowType: 'lead-generation' })}
          className="btn-primary gap-1.5">
          <Plus size={15} /> New Schedule
        </button>
      </PageHeader>

      {/* IST notice */}
      <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5 mb-6 text-xs text-blue-700">
        <Clock size={13} className="flex-shrink-0" />
        All schedules run in <strong className="mx-1">Indian Standard Time (IST · UTC+5:30)</strong>.
        EventBridge rules are created with the equivalent UTC cron expression automatically.
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : (
        WORKFLOW_TYPES.map(wf => (
          <WorkflowSection
            key={wf.key}
            wf={wf}
            schedules={schedules.filter(s => s.workflow_type === wf.key)}
            onAdd={(type) => setModal({ mode: 'create', workflowType: type })}
            onEdit={(s)   => setModal({ mode: 'edit', data: s })}
            onDelete={setDel}
            onToggle={(s) => toggleMut.mutate(s)}
          />
        ))
      )}

      {modal && (
        <ScheduleModal
          open={Boolean(modal)}
          onClose={() => setModal(null)}
          editing={modal.mode === 'edit' ? modal.data : null}
          workflowType={modal.workflowType || modal.data?.workflow_type}
        />
      )}

      {delTarget && (
        <DeleteModal schedule={delTarget} onClose={() => setDel(null)} />
      )}
    </div>
  )
}