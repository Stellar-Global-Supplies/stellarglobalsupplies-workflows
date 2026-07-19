import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSocialPosts, getBlogPosts, getLeads, publishSocialPost } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import {
  Layers, Share2, FileText, Users, Linkedin, Facebook, Instagram,
  Send, ExternalLink, Clock, CheckCircle, XCircle, RefreshCw
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const TABS = [
  { key: 'posts', label: 'Social Posts', icon: Share2 },
  { key: 'blogs', label: 'Blog Posts',   icon: FileText },
  { key: 'leads', label: 'Leads',        icon: Users },
]

const STATUS_META = {
  pending_approval: { label: 'Pending Save',       color: 'text-amber-600',   bg: 'bg-amber-50',   icon: Clock },
  approved_manual:  { label: 'Saved — Ready',      color: 'text-emerald-600', bg: 'bg-emerald-50', icon: CheckCircle },
  publishing:       { label: 'Awaiting Publish',   color: 'text-blue-600',    bg: 'bg-blue-50',    icon: Clock },
  published:        { label: 'Published',          color: 'text-navy',        bg: 'bg-navy/5',     icon: CheckCircle },
  rejected:         { label: 'Rejected',           color: 'text-red-600',     bg: 'bg-red-50',     icon: XCircle },
  publish_failed:   { label: 'Publish Failed',     color: 'text-red-600',     bg: 'bg-red-50',     icon: XCircle },
}

const PLATFORMS = [
  { key: 'linkedin',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
  { key: 'facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', Icon: Instagram, color: 'text-[#E1306C]' },
]

const POST_STATUS_FILTERS = [
  { key: 'all',              label: 'All' },
  { key: 'pending_approval', label: 'Pending Save' },
  { key: 'approved_manual',  label: 'Ready to Publish' },
  { key: 'publishing',       label: 'Awaiting Publish Approval' },
  { key: 'published',        label: 'Published' },
  { key: 'rejected',         label: 'Rejected' },
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

function PostCard({ post, onPublish, publishing }) {
  const meta     = STATUS_META[post.status] || { label: post.status, color: 'text-slate-500', bg: 'bg-slate-50', icon: Clock }
  const MetaIcon = meta.icon
  const canPublish = post.status === 'approved_manual'

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
        <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
          <span>{formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}</span>
          {post.type     && <span className="bg-slate-100 px-1.5 py-0.5 rounded capitalize">{post.type}</span>}
          {post.repo_name && <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{post.repo_name}</span>}
          {post.order_id  && <span className="bg-slate-100 px-1.5 py-0.5 rounded">Order: {post.order_id}</span>}
          <PlatformIcons platforms={post.platforms} />
        </div>
      </div>
      {canPublish && (
        <button onClick={() => onPublish(post.id)} disabled={publishing === post.id}
          className="btn-primary text-xs py-1.5 h-fit flex-shrink-0 bg-emerald-600 hover:bg-emerald-700">
          {publishing === post.id
            ? <><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Queuing…</>
            : <><Send size={13} />Publish</>}
        </button>
      )}
      {post.status === 'publishing' && (
        <div className="flex items-center gap-1 text-xs text-blue-600 flex-shrink-0 px-2">
          <Clock size={13} />In queue
        </div>
      )}
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
  const [tab, setTab]             = useState('posts')
  const [statusFilter, setStatusFilter] = useState('all')
  const [publishing, setPublishing]     = useState(null)

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ['content-posts', statusFilter],
    queryFn:  () => getSocialPosts(
      statusFilter === 'all'
        ? 'order=created_at.desc&limit=100'
        : `status=eq.${statusFilter}&order=created_at.desc&limit=100`
    ),
    enabled: tab === 'posts',
    refetchInterval: 20_000,
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

  async function handlePublish(postId) {
    setPublishing(postId)
    try {
      await publishSocialPost(postId)
      toast.success('Publish approval queued — check the Approval Queue')
      qc.invalidateQueries(['content-posts'])
      qc.invalidateQueries(['pending-approvals-count'])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setPublishing(null)
    }
  }

  const readyCount = posts.filter(p => p.status === 'approved_manual').length

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Layers} title="Content"
        sub="All generated posts, blogs and leads — approve to save, then publish when ready">
        <button onClick={() => qc.invalidateQueries(['content-posts','content-blogs','content-leads'])}
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
          <div className="flex flex-wrap gap-1.5 mb-4">
            {POST_STATUS_FILTERS.map(({ key, label }) => (
              <button key={key} onClick={() => setStatusFilter(key)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
                  ${statusFilter === key ? 'bg-navy text-white' : 'bg-white border border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy flex items-center justify-between">
              <span>Social Posts ({posts.length})</span>
              {readyCount > 0 && (
                <span className="text-xs text-emerald-600 font-normal">{readyCount} ready to publish</span>
              )}
            </div>
            {postsLoading ? (
              <div className="p-4 space-y-3">{Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
            ) : posts.length === 0 ? (
              <EmptyState icon={Share2} title="No posts"
                sub={statusFilter === 'all' ? 'Generate posts from Product Posts or Tech Showcase' : `No posts with status "${statusFilter}"`} />
            ) : (
              <div className="divide-y divide-slate-100">
                {posts.map(post => <PostCard key={post.id} post={post} onPublish={handlePublish} publishing={publishing} />)}
              </div>
            )}
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