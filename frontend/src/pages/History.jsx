import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getLeads, getSocialPosts, getBlogPosts, getWorkflowRuns, repostSocialPost, republishBlogPost } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import { History, Users, Share2, FileText, Zap, GitPullRequest, CheckCircle, XCircle, ChevronDown, ChevronRight, Repeat2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow, format } from 'date-fns'

const TABS = [
  { key: 'leads',   label: 'Leads',        icon: Users },
  { key: 'product', label: 'Product Posts', icon: Share2 },
  { key: 'tech',    label: 'Tech Posts',    icon: Zap },
  { key: 'blogs',   label: 'Blog Posts',    icon: FileText },
  { key: 'runs',    label: 'Workflow Runs', icon: History },
]

export default function HistoryPage() {
  const [tab, setTab] = useState('leads')
  const [openRunId, setOpenRunId] = useState(null)

  const { data: leadsData,   isLoading: ll } = useQuery({ queryKey: ['history-leads'],   queryFn: () => getLeads(),                                   enabled: tab === 'leads' })
  const { data: productData, isLoading: lp } = useQuery({ queryKey: ['history-product'], queryFn: () => getSocialPosts('type=product&limit=100'),       enabled: tab === 'product' })
  const { data: techData,    isLoading: lt } = useQuery({ queryKey: ['history-tech'],    queryFn: () => getSocialPosts('type=tech&limit=100'),          enabled: tab === 'tech' })
  const { data: blogsData,   isLoading: lb } = useQuery({ queryKey: ['history-blogs'],   queryFn: () => getBlogPosts('limit=100'),                      enabled: tab === 'blogs' })
  const { data: runsData,    isLoading: lr } = useQuery({ queryKey: ['history-runs'],    queryFn: () => getWorkflowRuns('limit=100'),                   enabled: tab === 'runs' })

  const leads   = leadsData?.leads   || []
  const product = productData?.posts || []
  const tech    = techData?.posts    || []
  const blogs   = blogsData?.blogs   || []
  const runs    = runsData?.runs     || []

  const isLoading = { leads: ll, product: lp, tech: lt, blogs: lb, runs: lr }[tab]

  async function postAgain(id) {
    try {
      await repostSocialPost(id)
      toast.success('Post sent again.')
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function publishAgain(id) {
    try {
      await republishBlogPost(id)
      toast.success('Blog PR created again.')
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={History} title="History & Posted Data" sub="View everything that has been created, sent, posted, or published" />

      {/* Tab bar */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6 flex-wrap">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === key ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <Icon size={13}/> {label}
          </button>
        ))}
      </div>

      {/* Leads table */}
      {tab === 'leads' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-medium text-navy">All Leads ({leads.length})</span>
          </div>
          {isLoading ? <div className="p-4 space-y-2">{Array(6).fill(0).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div>
          : leads.length === 0 ? <EmptyState icon={Users} title="No leads yet"/>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>{['Company','Email','Industry','Status','Source','Created'].map(h=>(
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {leads.map(l=>(
                    <tr key={l.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-navy">{l.company_name}</td>
                      <td className="px-4 py-3 text-slate-600">{l.email}</td>
                      <td className="px-4 py-3 text-slate-500">{l.industry}</td>
                      <td className="px-4 py-3"><StatusBadge status={l.status}/></td>
                      <td className="px-4 py-3">
                        <span className={`badge text-xs ${l.source === 'hunter.io' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          {l.source}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {format(new Date(l.created_at), 'dd MMM yy')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Social posts (product + tech share same layout) */}
      {(tab === 'product' || tab === 'tech') && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100">
            <span className="text-sm font-medium text-navy">
              {tab === 'product' ? 'Product' : 'Tech'} Posts ({(tab === 'product' ? product : tech).length})
            </span>
          </div>
          {isLoading ? <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i)=><Skeleton key={i} className="h-20"/>)}</div>
          : (tab === 'product' ? product : tech).length === 0
            ? <EmptyState icon={Share2} title="No posts yet"/>
            : (
              <div className="divide-y divide-slate-100">
                {(tab === 'product' ? product : tech).map(post=>(
                  <div key={post.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                    {post.image_url
                      ? <img src={post.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100"/>
                      : <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0"><Share2 size={18} className="text-slate-300"/></div>
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-sm font-medium text-navy">{post.title || 'Post'}</span>
                        <StatusBadge status={post.status}/>
                      </div>
                      <p className="text-xs text-slate-500 line-clamp-2 mb-1.5">{post.content}</p>
                      {/* Platform results */}
                      {post.post_results && (
                        <div className="flex items-center gap-3">
                          {Object.entries(post.post_results).map(([p, r]) => (
                            <span key={p} className={`flex items-center gap-1 text-xs ${r.success ? 'text-emerald-600' : 'text-red-500'}`}>
                              {r.success ? <CheckCircle size={11}/> : <XCircle size={11}/>}
                              {p}{r.manual ? ' (manual)' : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 flex-shrink-0">
                      {format(new Date(post.created_at), 'dd MMM yy')}
                    </div>
                    <button onClick={() => postAgain(post.id)} className="btn-secondary text-xs py-1.5 h-fit">
                      <Repeat2 size={13} /> Post Again
                    </button>
                  </div>
                ))}
              </div>
            )
          }
        </div>
      )}

      {/* Blog posts */}
      {tab === 'blogs' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100">
            <span className="text-sm font-medium text-navy">Blog Posts ({blogs.length})</span>
          </div>
          {isLoading ? <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i)=><Skeleton key={i} className="h-20"/>)}</div>
          : blogs.length === 0 ? <EmptyState icon={FileText} title="No blog posts yet"/>
          : (
            <div className="divide-y divide-slate-100">
              {blogs.map(blog=>(
                <div key={blog.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {blog.image_url
                    ? <img src={blog.image_url} alt="" className="w-20 h-14 rounded-lg object-cover flex-shrink-0 border border-slate-100"/>
                    : <div className="w-20 h-14 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0"><FileText size={18} className="text-slate-300"/></div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-medium text-navy">{blog.title}</span>
                      <StatusBadge status={blog.status}/>
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-1 mb-1.5">{blog.excerpt}</p>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-slate-400">{format(new Date(blog.created_at), 'dd MMM yy')}</span>
                      {blog.pr_url && (
                        <a href={blog.pr_url} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 text-purple-600 hover:underline">
                          <GitPullRequest size={11}/> PR #{blog.pr_number}
                        </a>
                      )}
                    </div>
                  </div>
                  <button onClick={() => publishAgain(blog.id)} className="btn-secondary text-xs py-1.5 h-fit">
                    <Repeat2 size={13} /> Publish Again
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Workflow runs */}
      {tab === 'runs' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100">
            <span className="text-sm font-medium text-navy">Workflow Runs ({runs.length})</span>
          </div>
          {isLoading ? <div className="p-4 space-y-2">{Array(6).fill(0).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div>
          : runs.length === 0 ? <EmptyState icon={History} title="No workflow runs yet"/>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>{['Workflow','Status','Started','Duration','Execution ARN'].map(h=>(
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {runs.map(r=>(
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-navy capitalize">{r.workflow_type?.replace(/_/g,' ')}</td>
                      <td className="px-4 py-3"><StatusBadge status={r.status}/></td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{format(new Date(r.started_at),'dd MMM yy HH:mm')}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {r.completed_at ? `${Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000)}s` : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs font-mono truncate max-w-xs">
                        <button onClick={() => setOpenRunId(openRunId === r.id ? null : r.id)} className="flex items-center gap-1 hover:text-navy">
                          {openRunId === r.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          {r.execution_arn?.split(':').pop()}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {runs.map(r => openRunId === r.id && (
                    <tr key={`${r.id}-details`} className="bg-slate-50/60">
                      <td colSpan={5} className="px-4 py-4">
                        <div className="grid gap-4 md:grid-cols-3 text-xs">
                          <div>
                            <div className="font-semibold text-slate-600 mb-1">Input</div>
                            <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">{JSON.stringify(r.input || {}, null, 2)}</pre>
                          </div>
                          <div>
                            <div className="font-semibold text-slate-600 mb-1">Output</div>
                            <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">{JSON.stringify(r.output || {}, null, 2)}</pre>
                          </div>
                          <div>
                            <div className="font-semibold text-slate-600 mb-1">Error</div>
                            <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">{r.error_msg || 'No error recorded'}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}