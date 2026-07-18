import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { listApprovals, approveItem, rejectItem } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Modal, Spinner } from '../components/ui'
import { CheckSquare, Check, X, Eye, Mail, Share2, FileText, Code2, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const WF_META = {
  lead_email:    { label: 'Email Outreach',    icon: Mail,      color: 'text-blue-600',   bg: 'bg-blue-50' },
  lead_followup: { label: 'Follow-up Email',   icon: Mail,      color: 'text-indigo-600', bg: 'bg-indigo-50' },
  social_product:{ label: 'Product Post',      icon: Share2,    color: 'text-navy',       bg: 'bg-navy/5' },
  social_tech:   { label: 'Tech Post',         icon: Code2,     color: 'text-amber-600',  bg: 'bg-amber-50' },
  blog:          { label: 'Blog Post',         icon: FileText,  color: 'text-purple-600', bg: 'bg-purple-50' },
}

function PreviewModal({ item, onClose, onApprove, onReject, loading }) {
  const [note, setNote] = useState('')
  const meta = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare }
  const Icon = meta.icon
  const hasStructuredPreview = item.payload?.post || item.payload?.blog

  return (
    <Modal open title={`Review: ${meta.label}`} onClose={onClose} width="max-w-5xl">
      <div className="space-y-4">
        {/* Preview */}
        {!hasStructuredPreview && (
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

        {/* Post content for social/blog */}
        {item.payload?.post && (
          <div className="space-y-3">
            {item.payload.post.image_url ? (
              <img src={item.payload.post.image_url} alt="" className="w-full max-h-80 object-contain rounded-xl border border-slate-100 bg-slate-50" />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500 text-center">
                No image was generated for this post.
              </div>
            )}
            {['facebook','instagram','linkedin'].map(p => item.payload.post[p] && (
              <div key={p} className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                <div className="text-xs font-semibold text-slate-500 uppercase mb-1 capitalize">{p}</div>
                <p className="text-sm text-slate-700">{item.payload.post[p]}</p>
              </div>
            ))}
          </div>
        )}

        {/* Blog preview */}
        {item.payload?.blog && (
          <div className="space-y-3">
            {item.payload.blog.image_url ? (
              <img src={item.payload.blog.image_url} alt="" className="w-full max-h-96 object-contain rounded-xl border border-slate-100 bg-slate-50" />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500 text-center">
                No featured image was generated for this blog post.
              </div>
            )}
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-100">
              <div className="text-base font-semibold text-navy mb-2">{item.payload.blog.title}</div>
              {item.payload.blog.excerpt && (
                <p className="text-sm text-slate-500 mb-3">{item.payload.blog.excerpt}</p>
              )}
              <pre className="text-sm text-slate-700 whitespace-pre-wrap overflow-y-auto max-h-[52vh] leading-6 font-sans">
                {item.payload.blog.content || 'No blog content was generated.'}
              </pre>
            </div>
          </div>
        )}

        {/* Review note */}
        <div>
          <label className="label">Review Note (optional)</label>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            className="input resize-none h-16" placeholder="Add a note for the record…" />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button onClick={() => onApprove(item.id, note)} disabled={loading}
            className="btn-primary flex-1 justify-center py-2.5 bg-emerald-600 hover:bg-emerald-700">
            {loading ? <Spinner size={16}/> : <><Check size={15}/> Approve</>}
          </button>
          <button onClick={() => onReject(item.id, note)} disabled={loading}
            className="btn-danger flex-1 justify-center py-2.5">
            {loading ? <Spinner size={16}/> : <><X size={15}/> Reject</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function ApprovalQueue() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('pending')
  const [preview, setPreview]   = useState(null)
  const [actionLoading, setActionLoading] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['approvals', statusFilter],
    queryFn:  () => listApprovals(statusFilter),
    refetchInterval: statusFilter === 'pending' ? 15_000 : false,
  })
  const items = data?.approvals || []

  async function handleApprove(id, note) {
    setActionLoading(true)
    try {
      await approveItem(id, note)
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
        sub="All human-in-the-loop approvals — email drafts, social posts, blog posts">
        <button onClick={() => refetch()} className="btn-secondary">
          <RefreshCw size={14} /> Refresh
        </button>
      </PageHeader>

      {/* Filter tabs */}
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
            sub={statusFilter === 'pending' ? 'All workflows are waiting for you to launch one' : ''} />
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
                        <Eye size={13}/> Review
                      </button>
                      <button onClick={() => handleApprove(item.id, '')}
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
