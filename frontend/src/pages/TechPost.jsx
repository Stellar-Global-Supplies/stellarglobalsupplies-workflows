import { useState }                  from 'react'
import { useQuery, useQueryClient }  from '@tanstack/react-query'
import { startWorkflow, getSocialPosts, repostSocialPost } from '../services/api'
import { PageHeader, EmptyState, Skeleton, StatusBadge } from '../components/ui'
import WorkflowProgress, { TECH_STEPS } from '../components/WorkflowProgress'
import {
  Code2, Play, Repeat2,
  Linkedin, Facebook, Instagram,
  Github, CheckCircle, Clock, Image as ImgIcon,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const PLATFORMS = [
  { key: 'linkedin',  label: 'LinkedIn',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
  { key: 'facebook',  label: 'Facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', label: 'Instagram', Icon: Instagram, color: 'text-[#E1306C]' },
]

function PlatformPicker({ value, onChange }) {
  return (
    <div className="flex gap-2">
      {PLATFORMS.map(({ key, label, Icon, color }) => {
        const active = value[key]
        return (
          <button key={key} type="button" onClick={() => onChange({ ...value, [key]: !active })}
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

export default function TechPost() {
  const qc = useQueryClient()
  const [platforms,   setPlatforms]   = useState({ linkedin: true, facebook: true, instagram: true })
  const [running,     setRunning]     = useState(false)
  const [tab,         setTab]         = useState('launch')
  const [activeRunId, setActiveRunId] = useState(null)

  const { data, isLoading } = useQuery({
    queryKey:        ['social-posts', 'tech'],
    queryFn:         () => getSocialPosts('type=tech&order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const posts = data?.posts || []

  const anyPlatform = Object.values(platforms).some(Boolean)

  async function launch() {
    if (!anyPlatform) { toast.error('Select at least one platform'); return }
    setRunning(true)
    setActiveRunId(null)
    try {
      // Zero inputs — workflow reads from GitHub context repo automatically
      const res = await startWorkflow('social-tech', { type: 'tech', platforms })
      setActiveRunId(res.workflowRunId)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  function handleComplete(status) {
    if (status === 'awaiting_approval') {
      toast.success('Tech post drafted — check Approval Queue to review and publish')
      qc.invalidateQueries({ queryKey: ['pending-approvals-count'] })
    } else if (status === 'succeeded') {
      toast.success('Tech post published successfully')
      qc.invalidateQueries(['social-posts'])
      setTab('posts')
    } else if (status === 'stopped') {
      toast('All tech topics already posted — rotation will restart next time', { icon: '⚠️' })
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

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Code2} title="Tech Post"
        sub="Reads your tech context repo → AI writes a B2B post showing how your tech makes steel supply better" />

      {/* Live progress */}
      {activeRunId && (
        <div className="mb-5">
          <WorkflowProgress
            runId={activeRunId}
            stepLabels={TECH_STEPS}
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
        <div className="grid md:grid-cols-2 gap-5">

          {/* Left: generate card */}
          <div className="card p-6">
            <h2 className="font-semibold text-navy mb-1">Generate Tech Post</h2>
            <p className="text-xs text-slate-400 mb-5">
              No inputs needed — the workflow reads your tech context repo and picks the next
              unposted topic automatically.
            </p>

            {/* Context repo reference */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200
                            rounded-xl px-4 py-3 mb-5 text-xs text-slate-600">
              <Github size={14} className="text-slate-500 flex-shrink-0" />
              <div>
                <span className="font-semibold text-navy">Context source: </span>
                <a href="https://github.com/Stellar-Global-Supplies/workflows-socialposts-context"
                  target="_blank" rel="noopener noreferrer"
                  className="text-blue-600 hover:underline font-mono">
                  Stellar-Global-Supplies/workflows-socialposts-context
                </a>
                <p className="text-slate-400 mt-0.5">
                  Add a <code className="bg-slate-200 px-1 rounded">.md</code> file per tech topic.
                  The workflow reads each file in rotation — no duplicates.
                </p>
              </div>
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
                : <><Play size={14}/>Generate Tech Post</>
              }
            </button>
          </div>

          {/* Right: how it works + context file format */}
          <div className="space-y-4">

            {/* How it works */}
            <div className="card p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                How It Works
              </p>
              <div className="space-y-3">
                {[
                  ['🔀', 'Auto-picks next unposted .md file from the context repo'],
                  ['🤖', 'AI reads the file and understands your tech feature'],
                  ['✍️', 'Writes post showing how the tech helps steel buyers'],
                  ['🖼️', 'Generates image — dashboard + tech stack + industrial context'],
                  ['👁️', 'You review and approve in Approval Queue'],
                  ['📢', 'Posts to LinkedIn, Facebook, Instagram'],
                ].map(([icon, text]) => (
                  <div key={text} className="flex items-start gap-2.5 text-xs text-slate-700">
                    <span className="flex-shrink-0">{icon}</span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Context file format */}
            <div className="card p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                Context File Format
              </p>
              <p className="text-xs text-slate-500 mb-3">
                Create one <code className="bg-slate-100 px-1 rounded">.md</code> file per tech topic in the repo.
                Each file = one social post.
              </p>
              <pre className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3
                              overflow-auto text-slate-600 leading-relaxed">{`# Lead Generation Workflow

## What It Does
Auto-finds B2B buyers for our steel products using
Tavily search + Groq AI + Bedrock email drafting.

## Tech Stack
- Cloudflare Workers (serverless)
- Tavily Search API
- Groq Llama 70B
- AWS Bedrock Nova Pro
- Supabase

## How It Helps Our Steel Business
- Finds real procurement managers in target cities
- Drafts personalised emails about our products
- We approve before sending — quality controlled
- Result: qualified leads without cold calling

## Key Benefit for Buyers
Procurement teams get personalised outreach about
the exact steel products their industry needs.`}</pre>
              <p className="text-xs text-slate-400 mt-2">
                The AI uses this to write a post that connects the tech back to steel supply benefits.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Posts tab ─────────────────────────────────────────── */}
      {tab === 'posts' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">
            Tech Posts ({posts.length})
          </div>
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          ) : posts.length === 0 ? (
            <EmptyState icon={Code2} title="No tech posts yet"
              sub="Add .md files to the context repo then click Generate Tech Post" />
          ) : (
            <div className="divide-y divide-slate-100">
              {posts.map(post => (
                <div key={post.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {post.image_url
                    ? <img src={post.image_url} alt=""
                        className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100"/>
                    : <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center
                                      justify-center flex-shrink-0">
                        <ImgIcon size={18} className="text-slate-300"/>
                      </div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-semibold text-navy truncate">
                        {post.title || 'Tech Post'}
                      </span>
                      <StatusBadge status={post.status} />
                    </div>
                    {post.repo_name && (
                      <p className="text-xs text-blue-600 font-mono mb-1">{post.repo_name}</p>
                    )}
                    <p className="text-xs text-slate-500 line-clamp-1 mb-1.5">
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
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    {post.status === 'pending_approval' && (
                      <span className="flex items-center gap-1 text-xs text-amber-600 font-medium px-2 py-1.5">
                        <Clock size={12}/> In review
                      </span>
                    )}
                    {['published','partial'].includes(post.status) && (
                      <button onClick={() => postAgain(post.id)}
                        className="btn-secondary text-xs py-1.5 gap-1">
                        <Repeat2 size={12}/> Repost
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