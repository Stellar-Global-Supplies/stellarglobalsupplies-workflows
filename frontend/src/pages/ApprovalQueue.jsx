import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listApprovals, approveItem, rejectItem, getGeneratedContent } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Modal, Spinner } from '../components/ui'
import { CheckSquare, Check, X, Eye, Mail, Share2, FileText, Code2, RefreshCw, Users, Pencil } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const WF_META = {
  lead_approval: { label: 'Lead Approval',   icon: Users,    color: 'text-emerald-600', bg: 'bg-emerald-50' },
  lead_email:    { label: 'Email Outreach',  icon: Mail,     color: 'text-blue-600',    bg: 'bg-blue-50' },
  lead_followup: { label: 'Follow-up Email', icon: Mail,     color: 'text-indigo-600',  bg: 'bg-indigo-50' },
  social_product:{ label: 'Product Post',    icon: Share2,   color: 'text-navy',        bg: 'bg-navy/5' },
  social_tech:   { label: 'Tech Post',       icon: Code2,    color: 'text-amber-600',   bg: 'bg-amber-50' },
  blog:          { label: 'Blog Post',       icon: FileText, color: 'text-purple-600',  bg: 'bg-purple-50' },
}

// ── Editable field ────────────────────────────────────────────────────────────
function EditableField({ label, value, onChange, multiline = false, rows = 3, mono = false }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={rows}
          className={`w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy resize-y ${mono ? 'font-mono' : ''}`}
        />
      ) : (
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          className={`w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy ${mono ? 'font-mono' : ''}`}
        />
      )}
    </div>
  )
}

// ── Social post editor ────────────────────────────────────────────────────────
function SocialEditor({ post, edits, setEdits }) {
  const platforms = [
    { key: 'linkedin',  label: 'LinkedIn' },
    { key: 'facebook',  label: 'Facebook' },
    { key: 'instagram', label: 'Instagram' },
  ].filter(p => post[p.key] || post.platforms?.[p.key])

  const setField = (field, val) =>
    setEdits(e => ({ ...e, post: { ...(e.post || {}), [field]: val } }))

  return (
    <div className="space-y-4">
      {post.image_url ? (
        <img src={post.image_url} alt="" className="w-full max-h-72 object-contain rounded-xl border border-slate-100 bg-slate-50" />
      ) : (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-400 text-center">
          No image was generated for this post.
        </div>
      )}
      {platforms.map(({ key, label }) => (
        <EditableField
          key={key}
          label={label}
          value={edits.post?.[key] ?? (post[key] || '')}
          onChange={val => setField(key, val)}
          multiline
          rows={4}
        />
      ))}
      {!platforms.length && post.caption && (
        <EditableField
          label="Caption"
          value={edits.post?.caption ?? post.caption}
          onChange={val => setField('caption', val)}
          multiline
          rows={4}
        />
      )}
    </div>
  )
}

// ── Blog editor ───────────────────────────────────────────────────────────────
function BlogEditor({ blog, edits, setEdits }) {
  const setField = (field, val) =>
    setEdits(e => ({ ...e, blog: { ...(e.blog || {}), [field]: val } }))

  return (
    <div className="space-y-4">
      {blog.image_url && (
        <img src={blog.image_url} alt="" className="w-full max-h-64 object-contain rounded-xl border border-slate-100 bg-slate-50" />
      )}
      <EditableField
        label="Title"
        value={edits.blog?.title ?? (blog.title || '')}
        onChange={val => setField('title', val)}
      />
      {blog.excerpt !== undefined && (
        <EditableField
          label="Excerpt"
          value={edits.blog?.excerpt ?? (blog.excerpt || '')}
          onChange={val => setField('excerpt', val)}
          multiline
          rows={2}
        />
      )}
      <EditableField
        label="Content"
        value={edits.blog?.content ?? (blog.content || '')}
        onChange={val => setField('content', val)}
        multiline
        rows={20}
        mono
      />
    </div>
  )
}

// ── Email editor ──────────────────────────────────────────────────────────────
function EmailEditor({ email, edits, setEdits }) {
  const setField = (field, val) =>
    setEdits(e => ({ ...e, email: { ...(e.email || {}), [field]: val } }))

  return (
    <div className="space-y-4">
      {email.subject !== undefined && (
        <EditableField
          label="Subject"
          value={edits.email?.subject ?? (email.subject || '')}
          onChange={val => setField('subject', val)}
        />
      )}
      <EditableField
        label="Body"
        value={edits.email?.body ?? (email.body || email.content || '')}
        onChange={val => setField('body', val)}
        multiline
        rows={14}
      />
    </div>
  )
}

// ── Preview modal ─────────────────────────────────────────────────────────────
function PreviewModal({ item, onClose, onApprove, onReject, loading }) {
  const [note, setNote]   = useState('')
  const [edits, setEdits] = useState({})
  const [fullContent, setFullContent] = useState(null)

  const meta = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare }
  const Icon = meta.icon

  const post  = fullContent && item.payload?.post  ? { ...item.payload.post,  ...fullContent } : item.payload?.post
  const blog  = fullContent && item.payload?.blog  ? { ...item.payload.blog,  ...fullContent } : item.payload?.blog
  const email = item.payload?.email || (item.payload?.subject ? item.payload : null)

  const contentKey = item.payload?.post?.content_s3_key || item.payload?.blog?.content_s3_key

  useEffect(() => {
    let cancelled = false
    setFullContent(null)
    setEdits({})
    if (!contentKey) return
    getGeneratedContent(contentKey)
      .then(res => { if (!cancelled) setFullContent(res.content) })
      .catch(() => { if (!cancelled) setFullContent(null) })
    return () => { cancelled = true }
  }, [contentKey])

  const hasEdits = Object.keys(edits).some(k => Object.keys(edits[k] || {}).length > 0)

  return (
    <Modal open title={`Review: ${meta.label}`} onClose={onClose} width="max-w-4xl">
      <div className="space-y-5">

        {/* Edit hint */}
        <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
          <Pencil size={12} className="text-slate-400 flex-shrink-0" />
          All fields are editable — make any changes before approving and they will be saved and sent.
          {hasEdits && <span className="ml-auto text-amber-600 font-medium">Unsaved edits</span>}
        </div>

        {/* Social post */}
        {post && (
          <SocialEditor post={post} edits={edits} setEdits={setEdits} />
        )}

        {/* Blog post */}
        {blog && (
          <BlogEditor blog={blog} edits={edits} setEdits={setEdits} />
        )}

        {/* Email */}
        {email && !post && !blog && (
          <EmailEditor email={email} edits={edits} setEdits={setEdits} />
        )}

        {/* Generic fallback */}
        {!post && !blog && !email && (
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className={`flex items-center gap-2 px-4 py-2.5 ${meta.bg} border-b border-slate-200`}>
              <Icon size={15} className={meta.color} />
              <span className="text-sm font-medium text-slate-700">{meta.label} Preview</span>
            </div>
            {item.preview_html ? (
              <div className="p-4 text-sm" dangerouslySetInnerHTML={{ __html: item.preview_html }} />
            ) : (
              <pre className="p-4 text-xs text-slate-600 overflow-auto max-h-64 whitespace-pre-wrap">
                {JSON.stringify(item.payload, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Review note */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Review Note (optional)
          </label>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            className="w-full mt-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 resize-none h-16"
            placeholder="Add a note for the record…" />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button
            onClick={() => onApprove(item.id, note, edits)}
            disabled={loading}
            className="btn-primary flex-1 justify-center py-2.5 bg-emerald-600 hover:bg-emerald-700"
          >
            {loading ? <Spinner size={16}/> : <><Check size={15}/> {hasEdits ? 'Save Edits & Approve' : 'Approve'}</>}
          </button>
          <button
            onClick={() => onReject(item.id, note)}
            disabled={loading}
            className="btn-danger flex-1 justify-center py-2.5"
          >
            {loading ? <Spinner size={16}/> : <><X size={15}/> Reject</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
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
      toast.success('Approved! Workflow is continuing…')
      setPreview(null)
      await qc.refetchQueries({ queryKey: ['approvals'] })
      await qc.refetchQueries({ queryKey: ['dashboard'] })
      await qc.refetchQueries({ queryKey: ['pending-approvals-count'] })
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
      await qc.refetchQueries({ queryKey: ['approvals'] })
      await qc.refetchQueries({ queryKey: ['dashboard'] })
      await qc.refetchQueries({ queryKey: ['pending-approvals-count'] })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={CheckSquare} title="Approval Queue"
        sub="Review, edit, and approve email drafts, social posts, and blog posts before they go live">
        <button onClick={() => refetch()} className="btn-secondary">
          <RefreshCw size={14} /> Refresh
        </button>
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
            sub={statusFilter === 'pending' ? 'All clear — no workflows waiting for review' : ''} />
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map(item => {
              const meta = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare, color: 'text-slate-600', bg: 'bg-slate-50' }
              const Icon = meta.icon
              return (
                <div key={item.id} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  <div className={`w-9 h-9 rounded-xl ${meta.bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={17} className={meta.color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-navy">{meta.label}</span>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                      <span>{formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}</span>
                      {item.reviewed_at && (
                        <span>· Reviewed {formatDistanceToNow(new Date(item.reviewed_at), { addSuffix: true })}</span>
                      )}
                      {item.review_note && <span className="italic truncate max-w-xs">· "{item.review_note}"</span>}
                    </div>
                  </div>

                  {item.status === 'pending' ? (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPreview(item)} className="btn-secondary text-xs py-1.5">
                        <Eye size={13}/> Review & Edit
                      </button>
                      <button onClick={() => handleApprove(item.id, '', {})}
                        className="btn-primary text-xs py-1.5 bg-emerald-600 hover:bg-emerald-700">
                        <Check size={13}/> Quick Approve
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setPreview(item)} className="btn-secondary text-xs py-1.5">
                      <Eye size={13}/> View
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {preview && (
        <PreviewModal
          item={preview}
          onClose={() => setPreview(null)}
          onApprove={handleApprove}
          onReject={handleReject}
          loading={actionLoading}
        />
      )}
    </div>
  )
}