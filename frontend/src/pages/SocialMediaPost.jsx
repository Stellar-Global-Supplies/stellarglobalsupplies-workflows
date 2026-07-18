import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getSocialPosts } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, FormField, Skeleton } from '../components/ui'
import { Share2, Play, Facebook, Instagram, Linkedin, Image as ImgIcon } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

export default function SocialMediaPost() {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    type: 'product',
    order_id: '',
    product_name: '',
    product_type: '',
    prompt: '',
  })
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState('launch')

  const { data, isLoading } = useQuery({
    queryKey: ['social-posts', 'product'],
    queryFn:  () => getSocialPosts('type=product&order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const posts = data?.posts || []

  async function launch() {
    setRunning(true)
    try {
      const payload = {
        type:         'product',
        order_id:     form.order_id,
        product_name: form.product_name,
        product_type: form.product_type,
        prompt:       form.prompt,
      }
      const res = await startWorkflow('social-product', payload)
      toast.success(`Product post workflow started — ${res.workflowRunId?.slice(0,8)}`)
      qc.invalidateQueries(['social-posts'])
      setTab('posts')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  const PlatformIcon = ({ platform, active }) => {
    const icons = { facebook: Facebook, instagram: Instagram, linkedin: Linkedin }
    const Ic = icons[platform] || Share2
    return <Ic size={14} className={active ? 'text-royal' : 'text-slate-300'} />
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Share2} title="Product Social Posts"
        sub="Pull from orders → AI generates image + caption → approval → post to Facebook, Instagram, LinkedIn" />

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['launch','posts'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === t ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'posts' ? `All Posts (${posts.length})` : 'Launch Workflow'}
          </button>
        ))}
      </div>

      {tab === 'launch' && (
        <div className="card p-6 max-w-lg">
          <h2 className="font-semibold text-navy mb-4">New Product Post</h2>
          <div className="space-y-4">
            <FormField label="Order Lookup" hint="Leave blank to use the latest order. Supports order ID, display ID, or UUID prefix.">
              <input value={form.order_id} onChange={e => setForm(f => ({...f, order_id: e.target.value}))}
                className="input" placeholder="e.g. ORD-1042 or 3f2a1c9b" />
            </FormField>
            <FormField label="Product Name" hint="Override order product name (optional)">
              <input value={form.product_name} onChange={e => setForm(f => ({...f, product_name: e.target.value}))}
                className="input" placeholder="e.g. Industrial Cleaning Bundle" />
            </FormField>
            <FormField label="Product Category" hint="Filters orders table if no order lookup is provided">
              <input value={form.product_type} onChange={e => setForm(f => ({...f, product_type: e.target.value}))}
                className="input" placeholder="e.g. Industrial, Office, Commercial" />
            </FormField>
            <FormField label="Custom Prompt (optional)" hint="Extra instructions for the AI">
              <textarea value={form.prompt} onChange={e => setForm(f => ({...f, prompt: e.target.value}))}
                className="input resize-none h-20" placeholder="Emphasise bulk discounts and fast delivery…" />
            </FormField>
          </div>

          <div className="mt-5 flex flex-col gap-3">
            <button onClick={launch} disabled={running} className="btn-primary justify-center py-2.5">
              {running ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
                : <><Play size={15} /> Generate Post</>}
            </button>
            <div className="flex items-center justify-center gap-4 text-xs text-slate-400">
              <span className="flex items-center gap-1"><PlatformIcon platform="facebook" active /> Facebook</span>
              <span className="flex items-center gap-1"><PlatformIcon platform="instagram" active /> Instagram</span>
              <span className="flex items-center gap-1"><PlatformIcon platform="linkedin" active /> LinkedIn (manual)</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'posts' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">
            Product Posts ({posts.length})
          </div>
          {isLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
          ) : posts.length === 0 ? (
            <EmptyState icon={Share2} title="No posts yet" sub="Launch a workflow to create your first product post" />
          ) : (
            <div className="divide-y divide-slate-100">
              {posts.map(post => (
                <div key={post.id} className="flex gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {post.image_url ? (
                    <img src={post.image_url} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-slate-100" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <ImgIcon size={20} className="text-slate-300" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-navy truncate">{post.title || 'Product Post'}</span>
                      <StatusBadge status={post.status} />
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2">{post.content}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-xs text-slate-400">
                        {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
                      </span>
                      {post.order_uuid && <span className="text-xs text-slate-400">Order UUID: {post.order_uuid}</span>}
                      {!post.order_uuid && post.order_id && <span className="text-xs text-slate-400">Order: {post.order_id}</span>}
                      <span className="flex gap-1 ml-auto">
                        {['facebook','instagram','linkedin'].map(p => (
                          <span key={p} title={p}>
                            <PlatformIcon platform={p} active={post.platforms?.[p]} />
                          </span>
                        ))}
                      </span>
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
