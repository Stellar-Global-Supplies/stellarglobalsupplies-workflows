import { useState }                  from 'react'
import { useQuery, useQueryClient }  from '@tanstack/react-query'
import {
  startWorkflow, getSocialPosts, repostSocialPost, publishSocialPost,
} from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import WorkflowProgress, { SOCIAL_STEPS } from '../components/WorkflowProgress'
import {
  Share2, Play, Facebook, Instagram, Linkedin,
  Image as ImgIcon, Repeat2, CheckCircle, Clock,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const PLATFORMS = [
  { key: 'facebook',  label: 'Facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', label: 'Instagram', Icon: Instagram, color: 'text-[#E1306C]' },
  { key: 'linkedin',  label: 'LinkedIn',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
]

function PlatformPicker({ value, onChange }) {
  const toggle = key => onChange({ ...value, [key]: !value[key] })
  return (
    <div className="flex gap-2">
      {PLATFORMS.map(({ key, label, Icon, color }) => {
        const active = value[key]
        return (
          <button key={key} type="button" onClick={() => toggle(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all
              ${active
                ? 'border-navy bg-navy/5 text-navy'
                : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300'}`}>
            <Icon size={13} className={active ? color : ''} />
            {label}
          </button>
        )
      })}
    </div>
  )
}

export default function SocialMediaPost() {
  const qc = useQueryClient()

  const [platforms,   setPlatforms]   = useState({ facebook: true, instagram: true, linkedin: true })
  const [running,     setRunning]     = useState(false)
  const [activeRunId, setActiveRunId] = useState(null)
  const [tab,         setTab]         = useState('launch')

  const { data, isLoading, refetch } = useQuery({
    queryKey:       ['social-posts', 'product'],
    queryFn:        () => getSocialPosts('type=product&order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const posts = data?.posts || []

  const anyPlatform = Object.values(platforms).some(Boolean)

  async function launch() {
    if (!anyPlatform) { toast.error('Select at least one platform'); return }

    setRunning(true)
    setActiveRunId(null)
    try {
      // No manual inputs — workflow auto-picks the latest unposted delivered order
      const res = await startWorkflow('social-product', {
        type:      'product',
        platforms,
      })
      setActiveRunId(res.workflowRunId)
      qc.invalidateQueries(['social-posts'])
      // Stay on launch tab so progress panel is visible
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  function handleComplete(status) {
    if (status === 'awaiting_approval') {
      toast.success('Post drafted — check Approval Queue to review and approve')
      qc.invalidateQueries({ queryKey: ['pending-approvals-count'] })
    } else if (status === 'succeeded') {
      toast.success('Post published successfully')
      qc.invalidateQueries({ queryKey: ['social-posts'] })
      setTab('posts')
    } else if (status === 'stopped') {
      toast('All recent orders already have posts — nothing new to generate', { icon: '⚠️' })
    } else if (status === 'failed') {
      toast.error('Workflow failed — check progress panel for details')
    }
  }

  async function postAgain(id) {
    try {
      await repostSocialPost(id)
      toast.success('Re-queued for posting')
      qc.invalidateQueries(['social-posts'])
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function approveAndPublish(id) {
    try {
      await publishSocialPost(id)
      toast.success('Sent for publish approval')
      qc.invalidateQueries(['social-posts'])
      qc.invalidateQueries(['pending-approvals-count'])
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Share2} title="Product Social Posts"
        sub="Auto-picks latest delivered order → AI writes post + generates image → you approve → publishes" />

      {/* Live progress */}
      {activeRunId && (
        <div className="mb-5">
          <WorkflowProgress
            runId={activeRunId}
            stepLabels={SOCIAL_STEPS}
            onComplete={handleComplete}
            onClose={() => setActiveRunId(null)}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['launch', 'posts'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'posts' ? `All Posts (${posts.length})` : 'Generate Post'}
          </button>
        ))}
      </div>

      {/* ── Launch tab ────────────────────────────────────────── */}
      {tab === 'launch' && (
        <div className="card p-6 max-w-md">
          <h2 className="font-semibold text-navy mb-1">Generate Product Post</h2>
          <p className="text-xs text-slate-400 mb-5">
            The workflow automatically picks the most recent delivered order that doesn't
            have a post yet. The post will showcase the <strong>product</strong> only —
            no customer names, quantities, or prices are ever included.
          </p>

          {/* How it works */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-5 space-y-2">
            {[
              ['📦', 'Auto-picks latest delivered order without a post'],
              ['✍️', 'AI writes LinkedIn, Facebook & Instagram content'],
              ['🖼️', 'AI generates a product image (FLUX)'],
              ['👁️', 'You review and approve before it goes live'],
              ['📢', 'Posts to your selected platforms'],
            ].map(([icon, label]) => (
              <div key={label} className="flex items-center gap-2.5 text-xs text-blue-800">
                <span>{icon}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>

          {/* Platform picker */}
          <div className="mb-5">
            <p className="text-xs font-medium text-slate-600 mb-2">Publish to</p>
            <PlatformPicker value={platforms} onChange={setPlatforms} />
            {!anyPlatform && (
              <p className="text-xs text-amber-600 mt-1.5">Select at least one platform</p>
            )}
          </div>

          <button onClick={launch} disabled={running || !anyPlatform}
            className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
            {running
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
              : <><Play size={15} />Generate Post</>
            }
          </button>
        </div>
      )}

      {/* ── Posts tab ─────────────────────────────────────────── */}
      {tab === 'posts' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-medium text-navy">Product Posts ({posts.length})</span>
          </div>

          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          ) : posts.length === 0 ? (
            <EmptyState icon={Share2} title="No posts yet"
              sub="Click Generate Post to create your first product social post" />
          ) : (
            <div className="divide-y divide-slate-100">
              {posts.map(post => (
                <div key={post.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">

                  {/* Image */}
                  {post.image_url ? (
                    <img src={post.image_url} alt=""
                      className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <ImgIcon size={20} className="text-slate-300" />
                    </div>
                  )}

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-semibold text-navy truncate">
                        {post.title || 'Product Post'}
                      </span>
                      <StatusBadge status={post.status} />
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2 mb-2">
                      {post.content || post.caption}
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-400">
                        {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
                      </span>
                      <span className="flex gap-1">
                        {PLATFORMS.map(({ key, Icon, color }) => (
                          <Icon key={key} size={13}
                            className={post.platforms?.[key] ? color : 'text-slate-200'} />
                        ))}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    {post.status === 'approved_manual' && (
                      <button onClick={() => approveAndPublish(post.id)}
                        className="btn-primary text-xs py-1.5 gap-1">
                        <CheckCircle size={12} /> Publish
                      </button>
                    )}
                    {post.status === 'pending_approval' && (
                      <span className="flex items-center gap-1 text-xs text-amber-600 font-medium px-2 py-1.5">
                        <Clock size={12} /> In review
                      </span>
                    )}
                    {['published','partial'].includes(post.status) && (
                      <button onClick={() => postAgain(post.id)}
                        className="btn-secondary text-xs py-1.5 gap-1">
                        <Repeat2 size={12} /> Repost
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}