import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getSocialPosts, repostSocialPost } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, FormField, Skeleton } from '../components/ui'
import { Code2, Play, Image as ImgIcon, Repeat2, Linkedin, Facebook, Instagram } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const PLATFORMS = [
  { key: 'linkedin',  label: 'LinkedIn',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
  { key: 'facebook',  label: 'Facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', label: 'Instagram', Icon: Instagram, color: 'text-[#E1306C]' },
]

function PlatformPicker({ value, onChange }) {
  const toggle = key => onChange({ ...value, [key]: !value[key] })
  const anySelected = Object.values(value).some(Boolean)

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        {PLATFORMS.map(({ key, label, Icon, color }) => {
          const active = value[key]
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all
                ${active
                  ? 'border-navy bg-navy/5 text-navy'
                  : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-500'
                }`}
            >
              <Icon size={13} className={active ? color : ''} />
              {label}
            </button>
          )
        })}
      </div>
      {!anySelected && (
        <p className="text-xs text-amber-600">Select at least one platform</p>
      )}
    </div>
  )
}

export default function TechPost() {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    repo_name: '',
    prompt: '',
    platforms: { linkedin: true, facebook: false, instagram: false }, // LinkedIn default for tech
  })
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState('launch')

  const { data, isLoading } = useQuery({
    queryKey: ['social-posts', 'tech'],
    queryFn:  () => getSocialPosts('type=tech&order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const posts = data?.posts || []

  const anyPlatform = Object.values(form.platforms).some(Boolean)

  async function launch() {
    if (!anyPlatform) { toast.error('Select at least one platform'); return }
    setRunning(true)
    try {
      const res = await startWorkflow('social-tech', { type: 'tech', ...form })
      toast.success(`Tech post workflow started — ${res.workflowRunId?.slice(0,8)}`)
      qc.invalidateQueries(['social-posts'])
      setTab('posts')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  async function postAgain(id) {
    try {
      await repostSocialPost(id)
      toast.success('Tech post sent again.')
      qc.invalidateQueries(['social-posts'])
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Code2} title="Tech Showcase Posts"
        sub="Reads {repo_name}/ai_context.md from S3 → AI generates post + image → approval → posts to selected platforms" />

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['launch','posts'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'posts' ? `Tech Posts (${posts.length})` : 'Launch Workflow'}
          </button>
        ))}
      </div>

      {tab === 'launch' && (
        <div className="card p-6 max-w-lg">
          <h2 className="font-semibold text-navy mb-4">New Tech Showcase Post</h2>
          <div className="space-y-4">
            <FormField label="Repository Name"
              hint="The workflow reads {repo_name}/ai_context.md from the private context bucket">
              <input value={form.repo_name} onChange={e => setForm(f => ({...f, repo_name: e.target.value}))}
                className="input font-mono" placeholder="e.g. workflows-platform" />
            </FormField>
            <FormField label="Custom Prompt (optional)"
              hint="Extra direction for the AI beyond what's in ai_context.md">
              <textarea value={form.prompt} onChange={e => setForm(f => ({...f, prompt: e.target.value}))}
                className="input resize-none h-24"
                placeholder="Focus on the approval workflow feature, mention Step Functions…" />
            </FormField>
            <FormField label="Publish To" hint="Select which platforms to post to">
              <PlatformPicker
                value={form.platforms}
                onChange={platforms => setForm(f => ({...f, platforms}))}
              />
            </FormField>
          </div>

          <div className="mt-2 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-600">
            <strong>Context file format:</strong> Place a markdown file at
            <code className="bg-slate-200 px-1 rounded mx-1">{'{repo_name}/ai_context.md'}</code>
            in the private context bucket. The AI will use it to write an accurate tech showcase post and generate the featured image.
          </div>

          <button onClick={launch} disabled={running || !anyPlatform} className="btn-primary w-full justify-center py-2.5 mt-5">
            {running
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
              : <><Play size={15} /> Generate Tech Post</>}
          </button>
        </div>
      )}

      {tab === 'posts' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">Tech Posts ({posts.length})</div>
          {isLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
          ) : posts.length === 0 ? (
            <EmptyState icon={Code2} title="No tech posts yet" sub="Launch a workflow to create your first tech showcase" />
          ) : (
            <div className="divide-y divide-slate-100">
              {posts.map(post => (
                <div key={post.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {post.image_url
                    ? <img src={post.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
                    : <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0"><ImgIcon size={20} className="text-slate-300" /></div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-navy truncate">{post.title || 'Tech Post'}</span>
                      <StatusBadge status={post.status} />
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2">{post.content}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                      <span>{formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}</span>
                      {post.repo_name && <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{post.repo_name}</span>}
                      <span className="flex gap-1 ml-auto">
                        {PLATFORMS.map(({ key, Icon, color }) => (
                          <span key={key} title={key}>
                            <Icon size={13} className={post.platforms?.[key] ? color : 'text-slate-200'} />
                          </span>
                        ))}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => postAgain(post.id)} className="btn-secondary text-xs py-1.5 h-fit">
                    <Repeat2 size={13} /> Post Again
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