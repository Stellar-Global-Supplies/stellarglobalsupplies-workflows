import { useState }                  from 'react'
import { useQuery, useQueryClient }  from '@tanstack/react-query'
import { startWorkflow, getBlogPosts, republishBlogPost } from '../services/api'
import { PageHeader, EmptyState, Skeleton } from '../components/ui'
import WorkflowProgress, { BLOG_STEPS }  from '../components/WorkflowProgress'
import { FileText, Play, GitPullRequest, Repeat2, Sparkles, Search } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

// All Stellar products shown as quick suggestions
const PRODUCT_SUGGESTIONS = [
  'MS Angles', 'MS Flats', 'MS Round Pipes', 'MS Sheet',
  'MS Square Tubes', 'MS Channels', 'MS Chequered Plate', 'MS Galvanised Sheets',
  'SS Sheets', 'SS Plates', 'SS Round Bars', 'SS Round Pipes', 'SS Channels',
  'MS NYLOCK Nuts', 'Internal Circlips DIN 472', 'External Circlips DIN 471',
  'Nordlock Washers', 'Hex Bolts', 'Allen Bolts', 'Dowel Pins',
]

const WORD_COUNTS = [700, 800, 900, 1000, 1200, 1500]

export default function BlogPost() {
  const qc = useQueryClient()
  const [productName,  setProductName]  = useState('')
  const [wordCount,    setWordCount]    = useState(900)
  const [running,      setRunning]      = useState(false)
  const [tab,          setTab]          = useState('launch')
  const [activeRunId,  setActiveRunId]  = useState(null)

  const { data, isLoading } = useQuery({
    queryKey:       ['blog-posts'],
    queryFn:        () => getBlogPosts('order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const blogs = data?.blogs || []

  async function launch() {
    setRunning(true)
    setActiveRunId(null)
    try {
      const payload = {
        product_name: productName.trim() || '',  // empty = auto-pick next product
        word_count:   wordCount,
      }
      const res = await startWorkflow('blog', payload)
      setActiveRunId(res.workflowRunId)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  function handleComplete(status) {
    if (status === 'awaiting_approval') {
      toast.success('Blog post drafted — check Approval Queue to review and approve')
      qc.invalidateQueries({ queryKey: ['pending-approvals-count'] })
    } else if (status === 'succeeded') {
      toast.success('Blog PR created successfully')
      qc.invalidateQueries(['blog-posts'])
      setTab('blogs')
    } else if (status === 'failed') {
      toast.error('Workflow failed — check progress panel for details')
    }
  }

  async function publishAgain(id) {
    try {
      await republishBlogPost(id)
      toast.success('GitHub PR queued')
      qc.invalidateQueries(['blog-posts'])
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={FileText} title="Blog Posts"
        sub="Product-focused SEO blogs — intro, why, use cases, Stellar promotion, CTA — then a GitHub PR" />

      {/* Live progress */}
      {activeRunId && (
        <div className="mb-5">
          <WorkflowProgress
            runId={activeRunId}
            stepLabels={BLOG_STEPS}
            onComplete={handleComplete}
            onClose={() => setActiveRunId(null)}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['launch', 'blogs'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'blogs' ? `All Blogs (${blogs.length})` : 'Generate Blog'}
          </button>
        ))}
      </div>

      {/* ── Launch tab ────────────────────────────────────────── */}
      {tab === 'launch' && (
        <div className="grid md:grid-cols-2 gap-5">

          {/* Left: form */}
          <div className="card p-6">
            <h2 className="font-semibold text-navy mb-1">Generate Blog Post</h2>
            <p className="text-xs text-slate-400 mb-5">
              Leave the product name blank to auto-pick the next unwritten product from our catalogue.
            </p>

            {/* Product name */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Product Name <span className="text-slate-300 font-normal">(optional — leave blank to auto-pick)</span>
              </label>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={productName}
                  onChange={e => setProductName(e.target.value)}
                  placeholder="e.g. MS Angles, SS Round Pipes, NYLOCK Nuts…"
                  className="input pl-8 w-full"
                />
              </div>
            </div>

            {/* Word count */}
            <div className="mb-5">
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Target Word Count</label>
              <div className="flex gap-1.5 flex-wrap">
                {WORD_COUNTS.map(n => (
                  <button key={n} onClick={() => setWordCount(n)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors
                      ${wordCount === n
                        ? 'bg-navy text-white border-navy'
                        : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                    {n}w
                  </button>
                ))}
              </div>
            </div>

            <button onClick={launch} disabled={running}
              className="btn-primary w-full justify-center py-2.5 disabled:opacity-50">
              {running
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
                : <><Play size={14} />{productName.trim() ? `Write Blog: ${productName.trim()}` : 'Auto-pick & Write Blog'}</>
              }
            </button>
          </div>

          {/* Right: product suggestions + blog structure */}
          <div className="space-y-4">

            {/* Blog structure */}
            <div className="card p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Fixed Blog Structure</p>
              <div className="space-y-2">
                {[
                  ['1', 'Introduction', 'What the product is and why it matters in Indian industry'],
                  ['2', 'Why This Product', 'Problems it solves, buying criteria, quality importance'],
                  ['3', 'Use Cases',       'Real applications across 4+ specific industries'],
                  ['4', 'Why Stellar',     'Specs, certifications, pricing, delivery, CTA details'],
                  ['5', 'Get a Quote',     'Call +91 9637655556 · stellarglobalsupplies.com'],
                ].map(([n, heading, sub]) => (
                  <div key={n} className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-navy/10 text-navy text-xs font-bold
                                     flex items-center justify-center flex-shrink-0 mt-0.5">{n}</span>
                    <div>
                      <p className="text-xs font-semibold text-navy">{heading}</p>
                      <p className="text-xs text-slate-400">{sub}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100">
                <p className="text-xs text-blue-700">
                  <strong>SEO:</strong> Product name in title, meta description, all H2s,
                  and internal link to product page on stellarglobalsupplies.com
                </p>
              </div>
            </div>

            {/* Quick product picks */}
            <div className="card p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                Quick Pick — Click to Set Product
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PRODUCT_SUGGESTIONS.map(p => (
                  <button key={p} onClick={() => setProductName(p)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition-colors
                      ${productName === p
                        ? 'bg-navy text-white border-navy'
                        : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300 hover:text-navy'}`}>
                    {p}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
                <Sparkles size={11} />
                <span>Auto-rotation cycles through all 20 products — no duplicates</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Blogs tab ─────────────────────────────────────────── */}
      {tab === 'blogs' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">
            Blog Posts ({blogs.length})
          </div>
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          ) : blogs.length === 0 ? (
            <EmptyState icon={FileText} title="No blog posts yet"
              sub="Click Generate Blog to write your first product blog post" />
          ) : (
            <div className="divide-y divide-slate-100">
              {blogs.map(blog => (
                <div key={blog.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {blog.image_url
                    ? <img src={blog.image_url} alt=""
                        className="w-20 h-14 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
                    : <div className="w-20 h-14 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                        <FileText size={18} className="text-slate-300" />
                      </div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-semibold text-navy">{blog.title}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                        ${blog.status === 'pr_created'  ? 'bg-emerald-100 text-emerald-700'
                        : blog.status === 'draft'        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600'}`}>
                        {blog.status?.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-1 mb-1.5">{blog.excerpt}</p>
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      <span>{formatDistanceToNow(new Date(blog.created_at), { addSuffix: true })}</span>
                      {blog.pr_url && (
                        <a href={blog.pr_url} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 text-purple-600 hover:underline">
                          <GitPullRequest size={12} /> PR #{blog.pr_number}
                        </a>
                      )}
                    </div>
                  </div>
                  <button onClick={() => publishAgain(blog.id)}
                    className="btn-secondary text-xs py-1.5 h-fit gap-1">
                    <Repeat2 size={12} /> Re-PR
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}