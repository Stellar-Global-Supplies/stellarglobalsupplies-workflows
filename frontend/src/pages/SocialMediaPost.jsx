import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getSocialPosts, repostSocialPost, lookupOrder } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, FormField, Skeleton } from '../components/ui'
import { Share2, Play, Facebook, Instagram, Linkedin, Image as ImgIcon, Repeat2, Search } from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const PLATFORMS = [
  { key: 'facebook',  label: 'Facebook',  Icon: Facebook,  color: 'text-[#1877F2]' },
  { key: 'instagram', label: 'Instagram', Icon: Instagram, color: 'text-[#E1306C]' },
  { key: 'linkedin',  label: 'LinkedIn',  Icon: Linkedin,  color: 'text-[#0A66C2]' },
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

export default function SocialMediaPost() {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    type: 'product',
    order_id: '',
    product_name: '',
    product_type: '',
    prompt: '',
    platforms: { facebook: true, instagram: true, linkedin: false }, // FB+IG default for product
  })
  const [running, setRunning] = useState(false)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [orderPreview, setOrderPreview] = useState(null)
  const [tab, setTab] = useState('launch')

  const { data, isLoading } = useQuery({
    queryKey: ['social-posts', 'product'],
    queryFn:  () => getSocialPosts('type=product&order=created_at.desc&limit=50'),
    refetchInterval: 15_000,
  })
  const posts = data?.posts || []

  const anyPlatform = Object.values(form.platforms).some(Boolean)

  async function launch() {
    if (!anyPlatform) { toast.error('Select at least one platform'); return }
    setRunning(true)
    try {
      const payload = {
        type:         'product',
        order_id:     form.order_id,
        product_name: form.product_name,
        product_type: form.product_type,
        prompt:       form.prompt,
        platforms:    form.platforms,
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

  async function postAgain(id) {
    try {
      await repostSocialPost(id)
      toast.success('Product post sent again.')
      qc.invalidateQueries(['social-posts'])
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function previewOrder() {
    setLookupLoading(true)
    try {
      const res = await lookupOrder(form.order_id, form.product_type)
      setOrderPreview(res)
      toast.success(`Order matched — ${res.orderDisplayId || res.orderId}`)
    } catch (e) {
      setOrderPreview(null)
      toast.error(e.message)
    } finally {
      setLookupLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader icon={Share2} title="Product Social Posts"
        sub="Pull from orders → AI generates image + caption → approval → post to selected platforms" />

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
            <FormField label="Order Lookup" hint="Leave blank to use the latest order. Supports order UUID or tracking token prefix.">
              <div className="flex gap-2">
                <input value={form.order_id} onChange={e => setForm(f => ({...f, order_id: e.target.value}))}
                  className="input" placeholder="e.g. order UUID or tracking token" />
                <button onClick={previewOrder} disabled={lookupLoading} className="btn-secondary flex-shrink-0">
                  <Search size={14} /> Lookup
                </button>
              </div>
            </FormField>
            {orderPreview?.order && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-semibold text-navy mb-1">{orderPreview.order.product_name || 'Matched order'}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span>Order: {orderPreview.orderDisplayId || orderPreview.orderId}</span>
                  {orderPreview.order.product_category && <span>Type: {orderPreview.order.product_category}</span>}
                  {orderPreview.order.customer_segment && <span>Customer: {orderPreview.order.customer_segment}</span>}
                </div>
              </div>
            )}
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
            <FormField label="Publish To" hint="Select which platforms to post to">
              <PlatformPicker
                value={form.platforms}
                onChange={platforms => setForm(f => ({...f, platforms}))}
              />
            </FormField>
          </div>

          <button onClick={launch} disabled={running || !anyPlatform} className="btn-primary w-full justify-center py-2.5 mt-5">
            {running
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Starting…</>
              : <><Play size={15} /> Generate Post</>}
          </button>
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
                      {post.order_id && <span className="text-xs text-slate-400">Order: {post.order_id}</span>}
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