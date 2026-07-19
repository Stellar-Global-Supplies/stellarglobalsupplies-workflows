import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSocialPosts, getBlogPosts, getLeads, publishSocialPost, repostSocialPost } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import {
  Layers, Share2, FileText, Users, Linkedin, Facebook, Instagram,
  Send, ExternalLink, Clock, CheckCircle, XCircle, RefreshCw,
  AlertTriangle, RotateCcw, Eye
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const TABS = [
  { key: 'posts', label: 'Social Posts', icon: Share2 },
  { key: 'blogs', label: 'Blog Posts',   icon: FileText },
  { key: 'leads', label: 'Leads',        icon: Users },
]

// All statuses the backend can write — covers DB constraint + display
const STATUS_META = {
  draft:            { label: 'Draft',                   color: 'text-slate-500',   bg: 'bg-slate-50',    icon: Clock },
  approved:         { label: 'Approved',                color: 'text-emerald-600', bg: 'bg-emerald-50',  icon: CheckCircle },
  approved_manual:  { label: 'Saved — Ready to Post',  color: 'text-emerald-600', bg: 'bg-emerald-50',  icon: CheckCircle },
  publishing:       { label: 'Awaiting Publish',        color: 'text-blue-600',    bg: 'bg-blue-50',     icon: Clock },
  posting:          { label: 'Posting…',                color: 'text-blue-600',    bg: 'bg-blue-50',     icon: Clock },
  posted:           { label: 'Posted',                  color: 'text-navy',        bg: 'bg-navy/5',      icon: CheckCircle },
  partial:          { label: 'Partial — Some Failed',   color: 'text-amber-600',   bg: 'bg-amber-50',    icon: AlertTriangle },
  failed:           { label: 'Failed',                  color: 'text-red-600',     bg: 'bg-red-50',      icon: XCircle },
  publish_failed:   { label: 'Publish Failed',          color: 'text-red-600',     bg: 'bg-red-50',      icon: XCircle },
  rejected:         { label: 'Rejected',                color: 'text-red-600',     bg: 'bg-red-50',      icon: XCircle },
}

const PLATFORMS = [
  { key: 'linkedin',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
  { key: 'facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', Icon: Instagram, color: 'text-[#E1306C]' },
]

const POST_STATUS_FILTERS = [
  { key: 'all',             label: 'All' },
  { key: 'approved_manual', label: 'Ready to Publish' },
  { key: 'publishing',      label: 'Awaiting Approval' },
  { key: 'posted',          label: 'Posted' },
  { key: 'partial',         label: 'Partial' },
  { key: 'failed',          label: 'Failed' },
  { key: 'rejected',        label: 'Rejected' },
]

function PlatformIcons({ platforms }) {
  return (
    <span className="flex items-center gap-1">
      {PLATFORMS.map(({ key, Icon, color }) => (
        <Icon key={key} size={13} className={platforms?.[key] ? color : 'text-slate-200'} />
      ))}
    </span>
  )
}

// Show per-platform results when a post has post_results
function PostResultsDetail({ post_results }) {
  if (!post_results || Object.keys(post_results).length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {Object.entries(post_results).map(([platform, result]) => {
        const success = result?.success
        const manual  = result?.manual
        return (
          <span key={platform}
            className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize flex items-center gap-1
              ${manual  ? 'bg-blue-50 text-blue-600 border-blue-200'
              : success ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-red-50 text-red-600 border-red-200'}`}>
            {manual ? <Clock size={10} /> : success ? <CheckCircle size={10} /> : <XCircle size={10} />}
            {platform}
            {!success && !manual && result?.error && (
              <span className="text-red-400 font-normal">
                {' '}— {typeof result.error === 'string'
                  ? result.error.replace(/\{"error":\{"message":"([^"]+)".*/, '$1').slice(0, 60)
                  : 'error'}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

function PostCard({ post, onPublish, onRepost, publishing, reposting }) {
  const meta     = STATUS_META[post.status] || { label: post.status, color: 'text-slate-500', bg: 'bg-slate-50', icon: Clock }
  const MetaIcon = meta.icon

  // "Publish" → goes through Gate 2 approval flow (approved_manual only)
  const canPublish = post.status === 'approved_manual'

  // "Repost" → directly re-runs post_to_platforms (partial / failed / posted)
  const canRepost = ['partial', 'failed', 'publish_failed', 'posted'].includes(post.status)

  const isActing = publishing === post.id || reposting === post.id

  return (
    <div className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
      {post.image_url ? (
        <img src={post.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
      ) : (
        <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
          <Share2 size={20} className="text-slate-300" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-navy truncate block">{post.title || 'Social Post'}</span>
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${meta.bg} ${meta.color}`}>
            <MetaIcon size={11} />{meta.label}
          </div>
        </div>

        <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">{post.caption || post.content}</p>

        <div className="flex items-center gap-3 mt-2 text-xs text-slate-400 flex-wrap">
          <span>{formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}</span>
          {post.type      && <span className="bg-slate-100 px-1.5 py-0.5 rounded capitalize">{post.type}</span>}
          {post.repo_name && <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{post.repo_name}</span>}
          {post.order_id  && <span className="bg-slate-100 px-1.5 py-0.5 rounded">Order: {post.order_id}</span>}
          <PlatformIcons platforms={post.platforms} />
          {post.posted_at && (
            <span className="text-slate-300">
              posted {formatDistanceToNow(new Date(post.posted_at), { addSuffix: true })}
            </span>
          )}
        </div>

        {/* Per-platform result pills — shown on partial / failed / posted */}
        {canRepost && <PostResultsDetail post_results={post.post_results} />}
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-1.5 flex-shrink-0 items-end justify-center">
        {/* Publish — goes through approval gate */}
        {canPublish && (
          <button onClick={() => onPublish(post.id)} disabled={isActing}
            className="btn-primary text-xs py-1.5 gap-1.5 bg-emerald-600 hover:bg-emerald-700 whitespace-nowrap">
            {publishing === post.id
              ? <><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Queuing…</>
              : <><Send size={13} />Publish</>}
          </button>
        )}

        {/* Repost — re-runs post_to_platforms directly, skips approval */}
        {canRepost && (
          <button onClick={() => onRepost(post.id)} disabled={isActing}
            className="btn-secondary text-xs py-1.5 gap-1.5 whitespace-nowrap">
            {reposting === post.id
              ? <><span className="w-3 h-3 border-2 border-navy/30 border-t-navy rounded-full animate-spin" />Reposting…</>
              : <><RotateCcw size={13} />Repost</>}
          </button>
        )}

        {/* Awaiting approval — just an indicator */}
        {post.status === 'publishing' && (
          <div className="flex items-center gap-1 text-xs text-blue-600 px-2">
            <Clock size={13} />In queue
          </div>
        )}
      </div>
    </div>
  )
}

function BlogCard({ blog }) {
  return (
    <div className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
      {blog.image_url ? (
        <img src={blog.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
      ) : (
        <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
          <FileText size={20} className="text-slate-300" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-navy truncate block">{blog.title || 'Blog Post'}</span>
          <StatusBadge status={blog.status} />
        </div>
        <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">{blog.excerpt}</p>
        <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
          <span>{formatDistanceToNow(new Date(blog.created_at), { addSuffix: true })}</span>
          {blog.github_pr_url && (
            <a href={blog.github_pr_url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-royal hover:underline">
              <ExternalLink size={11} />PR
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function LeadCard({ lead }) {
  return (
    <div className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
      <div className="w-16 h-16 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
        <Users size={20} className="text-emerald-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="text-sm font-medium text-navy truncate block">{lead.company_name || 'Lead'}</span>
            <span className="text-xs text-slate-500">{lead.contact_name} · {lead.email}</span>
          </div>
          <StatusBadge status={lead.status || lead.email_status || 'new'} />
        </div>
        <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
          <span>{formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}</span>
          {lead.industry && <span className="bg-slate-100 px-1.5 py-0.5 rounded">{lead.industry}</span>}
          {lead.source   && <span className="bg-slate-100 px-1.5 py-0.5 rounded">{lead.source}</span>}
        </div>
      </div>
    </div>
  )
}

export default function Content() {
  const qc = useQueryClient()
  const [tab, setTab]                 = useState('posts')
  const [statusFilter, setStatusFilter] = useState('all')
  const [publishing, setPublishing]   = useState(null) // postId being queued for publish
  const [reposting,  setReposting]    = useState(null) // postId being reposted directly

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ['content-posts', statusFilter],
    queryFn:  () => getSocialPosts(
      statusFilter === 'all'
        ? 'order=created_at.desc&limit=100'
        : `status=eq.${statusFilter}&order=created_at.desc&limit=100`
    ),
    enabled: tab === 'posts',
    refetchInterval: 15_000,
  })

  const { data: blogsData, isLoading: blogsLoading } = useQuery({
    queryKey: ['content-blogs'],
    queryFn:  () => getBlogPosts('order=created_at.desc&limit=100'),
    enabled:  tab === 'blogs',
  })

  const { data: leadsData, isLoading: leadsLoading } = useQuery({
    queryKey: ['content-leads'],
    queryFn:  () => getLeads('order=created_at.desc&limit=100'),
    enabled:  tab === 'leads',
  })

  const posts = postsData?.posts || []
  const blogs = blogsData?.blogs || blogsData?.posts || []
  const leads = leadsData?.leads || []

  // Queues a Gate 2 publish approval — only for approved_manual posts
  async function handlePublish(postId) {
    setPublishing(postId)
    try {
      await publishSocialPost(postId)
      toast.success('Publish approval queued — check the Approval Queue')
      qc.invalidateQueries({ queryKey: ['content-posts'] })
      qc.invalidateQueries({ queryKey: ['pending-approvals-count'] })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setPublishing(null)
    }
  }

  // Directly re-runs post_to_platforms — for partial / failed / posted posts
  async function handleRepost(postId) {
    setReposting(postId)
    try {
      const result = await repostSocialPost(postId)
      const status = result?.result?.overallStatus
      if (status === 'posted') {
        toast.success('All platforms posted successfully!')
      } else if (status === 'partial') {
        toast('Posted to some platforms — check results below', { icon: '⚠️' })
      } else {
        toast.error('Repost failed on all platforms — check results below')
      }
      qc.invalidateQueries({ queryKey: ['content-posts'] })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setReposting(null)
    }
  }

  const readyCount   = posts.filter(p => p.status === 'approved_manual').length
  const failedCount  = posts.filter(p => ['partial','failed','publish_failed'].includes(p.status)).length

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Layers} title="Content"
        sub="All generated posts, blogs and leads — approve to save, then publish when ready">
        <button onClick={() => qc.invalidateQueries({ queryKey: ['content-posts','content-blogs','content-leads'] })}
          className="btn-secondary"><RefreshCw size={14} />Refresh</button>
      </PageHeader>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-5">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === key ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {tab === 'posts' && (
        <>
          {/* Summary alerts */}
          {(readyCount > 0 || failedCount > 0) && (
            <div className="flex flex-wrap gap-2 mb-4">
              {readyCount > 0 && (
                <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2 text-xs text-emerald-700">
                  <CheckCircle size={13} />
                  <strong>{readyCount}</strong> post{readyCount > 1 ? 's' : ''} ready to publish
                </div>
              )}
              {failedCount > 0 && (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
                  <AlertTriangle size={13} />
                  <strong>{failedCount}</strong> post{failedCount > 1 ? 's' : ''} failed — use Repost to retry
                </div>
              )}
            </div>
          )}

          {/* Status filters */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {POST_STATUS_FILTERS.map(({ key, label }) => {
              const count = key === 'all'
                ? posts.length
                : posts.filter(p => p.status === key).length
              return (
                <button key={key} onClick={() => setStatusFilter(key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
                    ${statusFilter === key ? 'bg-navy text-white' : 'bg-white border border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                  {label}{count > 0 && ` (${count})`}
                </button>
              )
            })}
          </div>

          <div className="card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy flex items-center justify-between">
              <span>Social Posts ({posts.length})</span>
              <div className="flex items-center gap-3 text-xs font-normal">
                {readyCount > 0 && <span className="text-emerald-600">{readyCount} ready</span>}
                {failedCount > 0 && <span className="text-amber-600">{failedCount} need retry</span>}
              </div>
            </div>
            {postsLoading ? (
              <div className="p-4 space-y-3">{Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
            ) : posts.length === 0 ? (
              <EmptyState icon={Share2} title="No posts"
                sub={statusFilter === 'all'
                  ? 'Generate posts from Product Posts or Tech Showcase'
                  : `No posts with status "${statusFilter}"`} />
            ) : (
              <div className="divide-y divide-slate-100">
                {posts.map(post => (
                  <PostCard
                    key={post.id}
                    post={post}
                    onPublish={handlePublish}
                    onRepost={handleRepost}
                    publishing={publishing}
                    reposting={reposting}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
            <span><strong className="text-slate-500">Publish</strong> → queues a publish approval (gate 2)</span>
            <span><strong className="text-slate-500">Repost</strong> → directly retries posting to platforms (no approval needed)</span>
          </div>
        </>
      )}

      {tab === 'blogs' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">Blog Posts ({blogs.length})</div>
          {blogsLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
          ) : blogs.length === 0 ? (
            <EmptyState icon={FileText} title="No blog posts yet" sub="Generate blog posts from the Blog Posts page" />
          ) : (
            <div className="divide-y divide-slate-100">{blogs.map(b => <BlogCard key={b.id} blog={b} />)}</div>
          )}
        </div>
      )}

      {tab === 'leads' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">Leads ({leads.length})</div>
          {leadsLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
          ) : leads.length === 0 ? (
            <EmptyState icon={Users} title="No leads yet" sub="Generate leads from the Lead Generation page" />
          ) : (
            <div className="divide-y divide-slate-100">{leads.map(l => <LeadCard key={l.id} lead={l} />)}</div>
          )}
        </div>
      )}
    </div>
  )
}