import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listApprovals, approveItem, rejectItem, regenerateItem, getGeneratedContent } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Modal, Spinner } from '../components/ui'
import {
  CheckSquare, Check, X, Eye, Mail, Share2, FileText, Code2,
  RefreshCw, Users, Pencil, Send, Linkedin, Facebook, Instagram,
  RotateCcw, MessageSquare, Sparkles, ChevronRight, Monitor
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const WF_META = {
  lead_approval:  { label: 'Lead Approval',   icon: Users,    color: 'text-emerald-600', bg: 'bg-emerald-50' },
  lead_email:     { label: 'Email Outreach',  icon: Mail,     color: 'text-blue-600',    bg: 'bg-blue-50' },
  lead_followup:  { label: 'Follow-up Email', icon: Mail,     color: 'text-indigo-600',  bg: 'bg-indigo-50' },
  social_product: { label: 'Product Post',    icon: Share2,   color: 'text-navy',        bg: 'bg-navy/5' },
  social_tech:    { label: 'Tech Post',       icon: Code2,    color: 'text-amber-600',   bg: 'bg-amber-50' },
  blog:           { label: 'Blog Post',       icon: FileText, color: 'text-purple-600',  bg: 'bg-purple-50' },
}

// ─── Platform previews ────────────────────────────────────────────────────────

function LinkedInPreview({ content, image_url }) {
  const [expanded, setExpanded] = useState(false)
  const text = content || ''
  const preview = expanded ? text : text.slice(0, 280)
  const needsExpand = text.length > 280

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      {/* LI Header */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3 border-b border-slate-100">
        <div className="w-10 h-10 rounded-full bg-[#0A66C2] flex items-center justify-center text-white font-bold text-sm flex-shrink-0">S</div>
        <div>
          <p className="text-sm font-semibold text-slate-800 leading-tight">Stellar Global Supplies</p>
          <p className="text-xs text-slate-400 leading-tight">B2B Industrial Supplier · Just now</p>
        </div>
        <Linkedin size={16} className="text-[#0A66C2] ml-auto flex-shrink-0" />
      </div>
      {/* Content */}
      <div className="px-4 py-3">
        <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">
          {preview}{!expanded && needsExpand ? '…' : ''}
        </p>
        {needsExpand && (
          <button onClick={() => setExpanded(v => !v)}
            className="text-xs text-[#0A66C2] font-medium mt-1 hover:underline">
            {expanded ? 'Show less' : 'See more'}
          </button>
        )}
      </div>
      {image_url && (
        <img src={image_url} alt="" className="w-full max-h-72 object-cover border-t border-slate-100" />
      )}
      {/* LI reactions bar */}
      <div className="flex items-center gap-4 px-4 py-2.5 border-t border-slate-100 text-xs text-slate-400">
        <span>👍 Like</span><span>💬 Comment</span><span>🔁 Repost</span><span>📤 Send</span>
      </div>
    </div>
  )
}

function FacebookPreview({ content, image_url }) {
  const [expanded, setExpanded] = useState(false)
  const text = content || ''
  const preview = expanded ? text : text.slice(0, 200)
  const needsExpand = text.length > 200

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="w-9 h-9 rounded-full bg-[#1877F2] flex items-center justify-center text-white font-bold text-xs flex-shrink-0">S</div>
        <div>
          <p className="text-sm font-semibold text-slate-800 leading-tight">Stellar Global Supplies</p>
          <p className="text-xs text-slate-400">Just now · 🌐</p>
        </div>
        <Facebook size={16} className="text-[#1877F2] ml-auto flex-shrink-0" />
      </div>
      <div className="px-4 pb-3">
        <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">
          {preview}{!expanded && needsExpand ? '…' : ''}
        </p>
        {needsExpand && (
          <button onClick={() => setExpanded(v => !v)}
            className="text-xs text-[#1877F2] font-medium mt-1 hover:underline">
            {expanded ? 'See less' : 'See more'}
          </button>
        )}
      </div>
      {image_url && (
        <img src={image_url} alt="" className="w-full max-h-64 object-cover" />
      )}
      <div className="flex items-center gap-4 px-4 py-2.5 border-t border-slate-100 text-xs text-slate-400">
        <span>👍 Like</span><span>💬 Comment</span><span>↗ Share</span>
      </div>
    </div>
  )
}

function InstagramPreview({ content, image_url }) {
  const text = content || ''
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-slate-100">
        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-[#E1306C] to-[#833AB4] flex items-center justify-center text-white font-bold text-xs flex-shrink-0">S</div>
        <p className="text-sm font-semibold text-slate-800">stellarglobalsupplies</p>
        <Instagram size={15} className="text-[#E1306C] ml-auto flex-shrink-0" />
      </div>
      {image_url ? (
        <img src={image_url} alt="" className="w-full aspect-square object-cover" />
      ) : (
        <div className="w-full aspect-square bg-slate-100 flex items-center justify-center">
          <Instagram size={40} className="text-slate-300" />
        </div>
      )}
      <div className="px-3 pt-2.5 pb-3">
        <div className="flex gap-3 mb-2 text-slate-600">
          <span className="text-lg">🤍</span><span className="text-lg">💬</span><span className="text-lg">📤</span>
        </div>
        <p className="text-xs text-slate-700 whitespace-pre-line line-clamp-3 leading-relaxed">{text}</p>
      </div>
    </div>
  )
}

const PLATFORM_PREVIEWS = [
  { key: 'linkedin',  label: 'LinkedIn',  Icon: Linkedin,  color: 'text-[#0A66C2]',  Component: LinkedInPreview },
  { key: 'facebook',  label: 'Facebook',  Icon: Facebook,  color: 'text-[#1877F2]',  Component: FacebookPreview },
  { key: 'instagram', label: 'Instagram', Icon: Instagram, color: 'text-[#E1306C]',  Component: InstagramPreview },
]

function SocialPreviewTabs({ post, fullContent }) {
  const merged = fullContent ? { ...post, ...fullContent } : post
  const enabledPlatforms = PLATFORM_PREVIEWS.filter(p =>
    merged[p.key] || merged.platforms?.[p.key]
  )
  const [activeTab, setActiveTab] = useState(enabledPlatforms[0]?.key || 'linkedin')

  if (!enabledPlatforms.length) return null
  const active = PLATFORM_PREVIEWS.find(p => p.key === activeTab)
  const Preview = active?.Component

  return (
    <div>
      {/* Platform tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 mb-3">
        {enabledPlatforms.map(({ key, label, Icon, color }) => (
          <button key={key} onClick={() => setActiveTab(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors
              ${activeTab === key ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
            <Icon size={13} className={activeTab === key ? color : ''} />
            {label}
          </button>
        ))}
      </div>
      {Preview && (
        <Preview
          content={merged[activeTab] || merged.caption || merged.content || ''}
          image_url={merged.image_url}
        />
      )}
    </div>
  )
}

// ─── Blog preview ─────────────────────────────────────────────────────────────

function BlogPreview({ blog, fullContent }) {
  const merged = fullContent ? { ...blog, ...fullContent } : blog
  const content = merged.content || ''

  // Convert markdown to basic HTML for preview
  const html = content
    .replace(/^## (.+)/gm, '<h2 class="text-base font-semibold text-navy mt-4 mb-2">$1</h2>')
    .replace(/^### (.+)/gm, '<h3 class="text-sm font-semibold text-slate-700 mt-3 mb-1">$1</h3>')
    .replace(/^\*\*(.+)\*\*/gm, '<strong>$1</strong>')
    .replace(/^- (.+)/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n\n/g, '</p><p class="mb-2">')

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      {/* Blog meta header */}
      <div className="bg-slate-50 border-b border-slate-100 px-5 py-3 flex items-center gap-2">
        <Monitor size={13} className="text-slate-400" />
        <span className="text-xs text-slate-500 font-medium">Blog post preview · stellarglobalsupplies.com</span>
      </div>
      {merged.image_url && (
        <img src={merged.image_url} alt="" className="w-full max-h-52 object-cover" />
      )}
      <div className="px-5 py-4">
        <h1 className="text-lg font-bold text-navy mb-1">{merged.title}</h1>
        {merged.excerpt && <p className="text-sm text-slate-500 italic mb-3">{merged.excerpt}</p>}
        <div
          className="text-sm text-slate-700 leading-relaxed max-h-72 overflow-y-auto prose-sm"
          dangerouslySetInnerHTML={{ __html: `<p class="mb-2">${html}</p>` }}
        />
      </div>
    </div>
  )
}

// ─── Editable fields ──────────────────────────────────────────────────────────

function EditableField({ label, value, onChange, multiline = false, rows = 3, mono = false }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows}
          className={`w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy resize-y ${mono ? 'font-mono' : ''}`} />
      ) : (
        <input value={value} onChange={e => onChange(e.target.value)}
          className={`w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy ${mono ? 'font-mono' : ''}`} />
      )}
    </div>
  )
}

function SocialEditor({ post, edits, setEdits, fullContent }) {
  const merged = fullContent ? { ...post, ...fullContent } : post
  const platforms = PLATFORM_PREVIEWS.filter(p => merged[p.key] || merged.platforms?.[p.key])
  const setField = (field, val) => setEdits(e => ({ ...e, post: { ...(e.post || {}), [field]: val } }))

  return (
    <div className="space-y-4">
      {platforms.map(({ key, label }) => (
        <EditableField key={key} label={label}
          value={edits.post?.[key] ?? (merged[key] || '')}
          onChange={val => setField(key, val)} multiline rows={key === 'linkedin' ? 10 : 4} />
      ))}
      {!platforms.length && merged.caption && (
        <EditableField label="Caption"
          value={edits.post?.caption ?? merged.caption}
          onChange={val => setField('caption', val)} multiline rows={4} />
      )}
    </div>
  )
}

function BlogEditor({ blog, edits, setEdits, fullContent }) {
  const merged = fullContent ? { ...blog, ...fullContent } : blog
  const setField = (field, val) => setEdits(e => ({ ...e, blog: { ...(e.blog || {}), [field]: val } }))
  return (
    <div className="space-y-4">
      <EditableField label="Title" value={edits.blog?.title ?? (merged.title || '')} onChange={val => setField('title', val)} />
      {merged.excerpt !== undefined && (
        <EditableField label="Excerpt" value={edits.blog?.excerpt ?? (merged.excerpt || '')} onChange={val => setField('excerpt', val)} multiline rows={2} />
      )}
      <EditableField label="Content" value={edits.blog?.content ?? (merged.content || '')} onChange={val => setField('content', val)} multiline rows={20} mono />
    </div>
  )
}

function EmailEditor({ email, edits, setEdits }) {
  const setField = (field, val) => setEdits(e => ({ ...e, email: { ...(e.email || {}), [field]: val } }))
  return (
    <div className="space-y-4">
      {email.subject !== undefined && (
        <EditableField label="Subject" value={edits.email?.subject ?? (email.subject || '')} onChange={val => setField('subject', val)} />
      )}
      <EditableField label="Body" value={edits.email?.body ?? (email.body || email.content || '')} onChange={val => setField('body', val)} multiline rows={14} />
    </div>
  )
}

// ─── Regenerate panel ─────────────────────────────────────────────────────────

function RegeneratePanel({ approvalId, onRegenerated }) {
  const [open, setOpen]         = useState(false)
  const [feedback, setFeedback] = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleRegenerate() {
    if (!feedback.trim()) { toast.error('Enter feedback first'); return }
    setLoading(true)
    try {
      await regenerateItem(approvalId, feedback.trim())
      toast.success('Content regenerated — refreshing…')
      setOpen(false)
      setFeedback('')
      onRegenerated()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="btn-secondary text-xs py-1.5 gap-1.5 text-purple-600 border-purple-200 hover:bg-purple-50">
        <Sparkles size={13} />Regenerate with Feedback
      </button>
    )
  }

  return (
    <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-purple-700">
        <Sparkles size={14} />
        Tell AI what to change
      </div>
      <textarea
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none h-20 bg-white"
        placeholder='e.g. "Too salesy, make it more factual" or "Focus on stainless steel grade specifications" or "Add a section on bulk pricing benefits"'
        autoFocus
      />
      <div className="flex gap-2">
        <button onClick={() => { setOpen(false); setFeedback('') }}
          className="btn-secondary text-xs py-1.5 flex-1 justify-center">
          Cancel
        </button>
        <button onClick={handleRegenerate} disabled={loading || !feedback.trim()}
          className="text-xs py-1.5 px-4 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-medium flex items-center gap-1.5 flex-1 justify-center disabled:opacity-50 transition-colors">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Regenerating…</>
            : <><Sparkles size={13} />Regenerate</>}
        </button>
      </div>
    </div>
  )
}

// ─── Main preview modal ───────────────────────────────────────────────────────

function PreviewModal({ item, onClose, onApprove, onReject, loading }) {
  const [note, setNote]         = useState('')
  const [edits, setEdits]       = useState({})
  const [fullContent, setFullContent] = useState(null)
  const [viewMode, setViewMode] = useState('preview') // 'preview' | 'edit'

  const meta    = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare }
  const Icon    = meta.icon
  const payload = item.payload || {}
  const gate    = payload.approvalGate || 'save'
  const isPublishGate = gate === 'publish'
  const isSocialPost  = ['social_product','social_tech'].includes(item.workflow_type)
  const isBlog        = item.workflow_type === 'blog'

  const post  = payload.post
  const blog  = payload.blog
  const email = payload.email || (payload.subject ? payload : null)
  const contentKey = payload.post?.content_s3_key || payload.blog?.content_s3_key

  useEffect(() => {
    let cancelled = false
    setFullContent(null); setEdits({})
    if (!contentKey) return
    getGeneratedContent(contentKey)
      .then(res => { if (!cancelled) setFullContent(res.content) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [contentKey, item.id])

  function handleRegenerated() {
    // Refetch the approval content by re-fetching contentKey
    setFullContent(null)
    if (!contentKey) return
    getGeneratedContent(contentKey)
      .then(res => setFullContent(res.content))
      .catch(() => {})
  }

  const hasEdits = Object.keys(edits).some(k => Object.keys(edits[k] || {}).length > 0)
  const canRegenerate = isSocialPost || isBlog

  return (
    <Modal open title={`${isPublishGate ? '📤 Publish' : '💾 Save'}: ${meta.label}`} onClose={onClose} width="max-w-5xl">
      <div className="space-y-4">

        {/* Gate info bar */}
        <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 flex-wrap">
          <Pencil size={12} className="text-slate-400 flex-shrink-0" />
          {isPublishGate
            ? 'Approve to publish this post to the selected platforms.'
            : 'Review the preview, then switch to Edit mode to make changes before approving.'}
          {hasEdits && <span className="ml-auto text-amber-600 font-medium">Unsaved edits</span>}
        </div>

        {/* Preview / Edit toggle — only for social + blog */}
        {(isSocialPost || isBlog) && (
          <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
            <button onClick={() => setViewMode('preview')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                ${viewMode === 'preview' ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              <Eye size={12} />Preview
            </button>
            <button onClick={() => setViewMode('edit')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                ${viewMode === 'edit' ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              <Pencil size={12} />Edit
            </button>
          </div>
        )}

        {/* SOCIAL CONTENT */}
        {isSocialPost && post && (
          viewMode === 'preview'
            ? <SocialPreviewTabs post={post} fullContent={fullContent} />
            : <SocialEditor post={post} edits={edits} setEdits={setEdits} fullContent={fullContent} />
        )}

        {/* BLOG CONTENT */}
        {isBlog && blog && (
          viewMode === 'preview'
            ? <BlogPreview blog={blog} fullContent={fullContent} />
            : <BlogEditor blog={blog} edits={edits} setEdits={setEdits} fullContent={fullContent} />
        )}

        {/* EMAIL CONTENT (no preview mode — just editor) */}
        {email && !post && !blog && (
          <EmailEditor email={email} edits={edits} setEdits={setEdits} />
        )}

        {/* Fallback */}
        {!post && !blog && !email && (
          item.preview_html
            ? <div className="p-4 text-sm border border-slate-200 rounded-xl" dangerouslySetInnerHTML={{ __html: item.preview_html }} />
            : <pre className="p-4 text-xs text-slate-600 overflow-auto max-h-64 whitespace-pre-wrap border border-slate-200 rounded-xl">{JSON.stringify(payload, null, 2)}</pre>
        )}

        {/* Regenerate panel */}
        {canRegenerate && (
          <RegeneratePanel approvalId={item.id} onRegenerated={handleRegenerated} />
        )}

        {/* Review note */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Review Note (optional)</label>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            className="w-full mt-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 resize-none h-16"
            placeholder="Add a note for the record…" />
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 pt-1">
          <button onClick={() => onApprove(item.id, note, edits)} disabled={loading}
            className="btn-primary flex-1 justify-center py-2.5 bg-emerald-600 hover:bg-emerald-700">
            {loading ? <Spinner size={16}/> : isPublishGate
              ? <><Send size={15}/>Approve & Publish</>
              : <><Check size={15}/>{hasEdits ? 'Save Edits & Approve' : 'Approve'}</>}
          </button>
          <button onClick={() => onReject(item.id, note)} disabled={loading}
            className="btn-danger flex-1 justify-center py-2.5">
            {loading ? <Spinner size={16}/> : <><X size={15}/>Reject</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ApprovalQueue() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('pending')
  const [preview, setPreview]           = useState(null)
  const [actionLoading, setActionLoading] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['approvals', statusFilter],
    queryFn:  () => listApprovals(statusFilter),
    refetchInterval: statusFilter === 'pending' ? 15_000 : false,
  })
  const items = data?.approvals || []

  async function handleApprove(id, note, edits = {}) {
    setActionLoading(true)
    try {
      await approveItem(id, note, edits)
      toast.success('Approved!')
      setPreview(null)
      qc.invalidateQueries(['approvals'])
      qc.invalidateQueries(['dashboard'])
      qc.invalidateQueries(['pending-approvals-count'])
      qc.invalidateQueries(['content-posts'])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReject(id, note) {
    setActionLoading(true)
    try {
      await rejectItem(id, note)
      toast.success('Rejected.')
      setPreview(null)
      qc.invalidateQueries(['approvals'])
      qc.invalidateQueries(['pending-approvals-count'])
      qc.invalidateQueries(['content-posts'])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={CheckSquare} title="Approval Queue"
        sub="Gate 1: approve to save generated content. Gate 2: approve to publish to platforms.">
        <button onClick={() => refetch()} className="btn-secondary"><RefreshCw size={14}/>Refresh</button>
      </PageHeader>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['pending','approved','rejected'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
              ${statusFilter === s ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {s}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner size={24}/></div>
        ) : items.length === 0 ? (
          <EmptyState icon={CheckSquare}
            title={statusFilter === 'pending' ? 'No pending approvals' : `No ${statusFilter} items`}
            sub={statusFilter === 'pending' ? 'All clear!' : ''} />
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map(item => {
              const meta  = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare, color: 'text-slate-600', bg: 'bg-slate-50' }
              const Icon  = meta.icon
              const gate  = (item.payload || {}).approvalGate || 'save'
              const gateLabel = gate === 'publish' ? '📤 Publish' : '💾 Save'
              return (
                <div key={item.id} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  <div className={`w-9 h-9 rounded-xl ${meta.bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={17} className={meta.color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-navy">{meta.label}</span>
                      <span className="text-xs text-slate-400">{gateLabel}</span>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                      <span>{formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}</span>
                      {item.review_note && <span className="italic truncate max-w-xs">· "{item.review_note}"</span>}
                    </div>
                  </div>
                  {item.status === 'pending' ? (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPreview(item)} className="btn-secondary text-xs py-1.5">
                        <Eye size={13}/>Review & Edit
                      </button>
                      <button onClick={() => handleApprove(item.id, '', {})}
                        className="btn-primary text-xs py-1.5 bg-emerald-600 hover:bg-emerald-700">
                        <Check size={13}/>Quick Approve
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setPreview(item)} className="btn-secondary text-xs py-1.5">
                      <Eye size={13}/>View
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {preview && (
        <PreviewModal item={preview} onClose={() => setPreview(null)}
          onApprove={handleApprove} onReject={handleReject} loading={actionLoading} />
      )}
    </div>
  )
}