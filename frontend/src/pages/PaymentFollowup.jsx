import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { startWorkflow, getOrders } from '../services/api'
import { PageHeader, EmptyState, Skeleton } from '../components/ui'
import {
  CreditCard, AlertTriangle, CheckCircle, Clock, Send,
  User, Package, Calendar, DollarSign, RefreshCw, ChevronDown, ChevronUp
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow, format } from 'date-fns'

const STATUS_COLORS = {
  'After 30 days': { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-200',    dot: 'bg-red-500' },
  'Pending':        { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-200',  dot: 'bg-amber-400' },
  'Partial':        { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-400' },
  'Paid':           { bg: 'bg-emerald-50',text: 'text-emerald-700',border: 'border-emerald-200',dot: 'bg-emerald-500' },
}

const ORDER_STATUS_COLORS = {
  'Order Received':    'text-slate-500',
  'Processing':        'text-blue-600',
  'Ready to Dispatch': 'text-amber-600',
  'Delivered':         'text-emerald-600',
}

function fmt(n) {
  try { return `₹${parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` }
  catch { return `₹${n}` }
}

function OrderCard({ order, onTrigger, triggering }) {
  const [expanded, setExpanded] = useState(false)
  const payStyle = STATUS_COLORS[order.payment_status] || STATUS_COLORS['Pending']
  const isOverdue = order.payment_status === 'After 30 days'
  const total = parseFloat(order.sale_cost || 0) + parseFloat(order.cgst_total || 0) + parseFloat(order.sgst_total || 0)
  const orderDate = order.created_at ? format(new Date(order.created_at), 'dd MMM yyyy') : '—'
  const delivery  = order.delivery_timeline ? format(new Date(order.delivery_timeline), 'dd MMM yyyy') : '—'

  return (
    <div className={`card transition-all ${isOverdue ? 'border-red-200' : ''}`}>
      <div className="flex items-center gap-4 p-5">
        {/* Status dot */}
        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${payStyle.dot}`} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold text-navy text-sm">{order.customer_name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${payStyle.bg} ${payStyle.text} ${payStyle.border}`}>
              {order.payment_status}
            </span>
            <span className={`text-xs font-medium ${ORDER_STATUS_COLORS[order.status] || 'text-slate-500'}`}>
              {order.status}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
            <span className="flex items-center gap-1">
              <Package size={11}/>{order.material} ({order.product_type})
            </span>
            <span>{order.quantity} {order.unit}</span>
            <span className="font-medium text-navy">{fmt(total)}</span>
            <span className="flex items-center gap-1">
              <Calendar size={11}/>{orderDate}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {isOverdue && (
            <button
              onClick={() => onTrigger(order)}
              disabled={triggering === order.id}
              className="btn-primary text-xs py-1.5 gap-1.5 bg-red-600 hover:bg-red-700 whitespace-nowrap">
              {triggering === order.id
                ? <><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Drafting…</>
                : <><Send size={13}/>Send Follow-up</>}
            </button>
          )}
          <button onClick={() => setExpanded(v => !v)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 transition-colors">
            {expanded ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm mb-4">
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Customer Email</p>
              <p className="text-navy font-medium text-xs">{order.email}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Phone</p>
              <p className="text-navy font-medium text-xs">{order.phone}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Delivery Date</p>
              <p className="text-navy font-medium text-xs">{delivery}</p>
            </div>
          </div>

          {/* Financial breakdown */}
          <div className="bg-slate-50 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Description</th>
                  <th className="text-right px-4 py-2.5 text-slate-500 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-2.5 text-slate-700">{order.material} ({order.product_type}) × {order.quantity} {order.unit}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{fmt(order.sale_cost)}</td>
                </tr>
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-2.5 text-slate-500">CGST</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">{fmt(order.cgst_total)}</td>
                </tr>
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-2.5 text-slate-500">SGST</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">{fmt(order.sgst_total)}</td>
                </tr>
                <tr className="bg-navy/5">
                  <td className="px-4 py-2.5 font-semibold text-navy">Total Payable</td>
                  <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {isOverdue && (
            <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
              <AlertTriangle size={13} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-700">
                Payment is overdue. Click <strong>Send Follow-up</strong> to have AI draft a professional
                payment reminder email to <strong>{order.email}</strong>. You'll review and approve
                the draft before it's sent.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function PaymentFollowup() {
  const qc = useQueryClient()
  const [triggering, setTriggering] = useState(null)
  const [filter, setFilter]         = useState('After 30 days')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['orders', filter],
    queryFn: () => getOrders(
      filter === 'all'
        ? 'order=created_at.desc&limit=100'
        : `payment_status=eq.${encodeURIComponent(filter)}&order=created_at.desc&limit=100`
    ),
    refetchInterval: 30_000,
  })

  const orders  = data?.orders || []
  const overdue = orders.filter(o => o.payment_status === 'After 30 days')

  async function handleTrigger(order) {
    setTriggering(order.id)
    try {
      await startWorkflow('payment-followup', { orderId: order.id })
      toast.success(`Follow-up email drafted for ${order.customer_name} — check Approval Queue`)
      qc.invalidateQueries({ queryKey: ['pending-approvals-count'] })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setTriggering(null)
    }
  }

  const FILTERS = [
    { key: 'After 30 days', label: 'Overdue (30 days)' },
    { key: 'Pending',       label: 'Pending' },
    { key: 'Partial',       label: 'Partial' },
    { key: 'Paid',          label: 'Paid' },
    { key: 'all',           label: 'All Orders' },
  ]

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader icon={CreditCard} title="Payment Follow-up"
        sub="AI drafts a payment reminder email for overdue orders — you approve before it sends">
        <button onClick={() => refetch()} className="btn-secondary"><RefreshCw size={14}/>Refresh</button>
      </PageHeader>

      {/* Alert banner */}
      {overdue.length > 0 && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-5 py-3.5 mb-5">
          <AlertTriangle size={16} className="text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">
              {overdue.length} order{overdue.length > 1 ? 's' : ''} with overdue payment
            </p>
            <p className="text-xs text-red-500">
              Payment terms were "After 30 days" — click Send Follow-up to draft a reminder email
            </p>
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { icon: AlertTriangle, label: '1. Detect',  sub: 'Orders with "After 30 days" payment status', color: 'text-red-500' },
          { icon: CreditCard,    label: '2. AI Draft', sub: 'Nova drafts a professional payment reminder', color: 'text-blue-500' },
          { icon: CheckCircle,   label: '3. Approve & Send', sub: 'You review in Approval Queue, then it sends', color: 'text-emerald-500' },
        ].map(({ icon: Icon, label, sub, color }) => (
          <div key={label} className="card p-4 text-center">
            <Icon size={20} className={`${color} mx-auto mb-2`} />
            <p className="text-xs font-semibold text-navy">{label}</p>
            <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {FILTERS.map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border
              ${filter === key
                ? key === 'After 30 days' ? 'bg-red-600 text-white border-red-600' : 'bg-navy text-white border-navy'
                : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Orders list */}
      {isLoading ? (
        <div className="space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-20"/>)}</div>
      ) : orders.length === 0 ? (
        <EmptyState icon={CreditCard}
          title={filter === 'After 30 days' ? 'No overdue payments' : 'No orders found'}
          sub={filter === 'After 30 days' ? 'All payments are up to date' : `No orders with payment status "${filter}"`} />
      ) : (
        <div className="space-y-2">
          {orders.map(order => (
            <OrderCard
              key={order.id}
              order={order}
              onTrigger={handleTrigger}
              triggering={triggering}
            />
          ))}
        </div>
      )}
    </div>
  )
}