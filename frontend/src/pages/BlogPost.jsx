import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getBlogPosts } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, FormField, Skeleton } from '../components/ui'
import { FileText, Play, ExternalLink, GitPullRequest } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const TOPICS = [
  'B2B Procurement Best Practices',
  'Supply Chain Optimisation Tips',
  'How to Choose the Right Industrial Supplier',
  'Office Supplies Buying Guide for Businesses',
  'Sustainable Procurement for Modern Companies',
  'Custom topic…',
]

export default function BlogPost() {
  const qc = useQueryClient()
  const [customTopic, setCustomTopic] = useState(false)
  const [form, setForm] = useState({
    topic: TOPICS[0],
    custom_topic: '',
    keywords: '',
    word_count: 800,
    custom_prompt: '',
  })
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState('launch')

  const { data, isLoading } = useQuery({
    queryKey: ['blog-posts'],
    queryFn:  () => getBlogPosts('order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const blogs = data?.blogs || []

  function handleTopicChange(e) {
    const val = e.target.value
    if (val === 'Custom topic…') { setCustomTopic(true); setForm(f => ({...f, topic: ''})) }
    else { setCustomTopic(false); setForm(f => ({...f, topic: val})) }
  }

  async function launch() {
    setRunning(true)
    try {
      const payload = {
        topic:         customTopic ? form.custom_topic : form.topic,
        keywords:      form.keywords.split(',').map(k => k.trim()).filter(Boolean),
        word_count:    Number(form.word_count),
        custom_prompt: form.custom_prompt,
      }
      const res = await startWorkflow('blog', payload)
      toast.success(`Blog workflow started — ${res.workflowRunId?.slice(0,8)}`)
      qc.invalidateQueries(['blog-posts'])
      setTab('blogs')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={FileText} title="Blog Posts"
        sub="AI writes blog + generates featured image → approval → GitHub PR created automatically" />

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['launch','blogs'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'blogs' ? `All Blogs (${blogs.length})` : 'Launch Workflow'}
          </button>
        ))}
      </div>

      {tab === 'launch' && (
        <div className="card p-6 max-w-lg">
          <h2 className="font-semibold text-navy mb-4">Generate Blog Post</h2>
          <div className="space-y-4">
            <FormField label="Topic">
              <select onChange={handleTopicChange} className="input">
                {TOPICS.map(t => <option key={t}>{t}</option>)}
              </select>
            </FormField>
            {customTopic && (
              <FormField label="Custom Topic">
                <input value={form.custom_topic} onChange={e => setForm(f => ({...f, custom_topic: e.target.value}))}
                  className="input" placeholder="Your custom blog topic…" />
              </FormField>
            )}
            <FormField label="SEO Keywords" hint="Comma-separated">
              <input value={form.keywords} onChange={e => setForm(f => ({...f, keywords: e.target.value}))}
                className="input" placeholder="supply chain, B2B procurement, bulk supplies" />
            </FormField>
            <FormField label="Target Word Count">
              <select value={form.word_count} onChange={e => setForm(f => ({...f, word_count: e.target.value}))} className="input">
                {[500, 700, 800, 1000, 1200, 1500].map(n => <option key={n} value={n}>{n} words</option>)}
              </select>
            </FormField>
            <FormField label="Additional Instructions (optional)">
              <textarea value={form.custom_prompt} onChange={e => setForm(f => ({...f, custom_prompt: e.target.value}))}
                className="input resize-none h-20"
                placeholder="Include a section on cost-saving strategies, reference our website…" />
            </FormField>
          </div>

          <div className="mt-4 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-600">
            <strong>On approval:</strong> A GitHub branch is created, the blog post is committed as
            <code className="mx-1 bg-slate-200 px-1 rounded">content/blog/{'{slug}'}.md</code>
            and a Pull Request is opened on your website repo.
          </div>

          <button onClick={launch} disabled={running} className="btn-primary w-full justify-center py-2.5 mt-5">
            {running ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
              : <><Play size={15} /> Generate Blog Post</>}
          </button>
        </div>
      )}

      {tab === 'blogs' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">All Blog Posts ({blogs.length})</div>
          {isLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
          ) : blogs.length === 0 ? (
            <EmptyState icon={FileText} title="No blog posts yet" sub="Launch a workflow to generate your first blog post" />
          ) : (
            <div className="divide-y divide-slate-100">
              {blogs.map(blog => (
                <div key={blog.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {blog.image_url
                    ? <img src={blog.image_url} alt="" className="w-20 h-14 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
                    : <div className="w-20 h-14 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0"><FileText size={18} className="text-slate-300"/></div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-medium text-navy">{blog.title}</span>
                      <StatusBadge status={blog.status} />
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
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
