import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getDashboard, listApprovals } from '../services/api'
import { StatCard, Skeleton, StatusBadge, PageHeader, EmptyState } from '../components/ui'
import {
  LayoutDashboard, Users, Share2, FileText, CheckSquare,
  ArrowRight, Zap, History, DollarSign, TrendingUp, Cpu
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const WORKFLOW_CARDS = [
  { to: '/leads',  icon: Users,    label: 'Lead Generation',  sub: 'Hunter.io + AI outreach',   color: 'bg-royal'       },
  { to: '/social', icon: Share2,   label: 'Product Posts',    sub: 'AI image + multi-platform', color: 'bg-navy'        },
  { to: '/tech',   icon: Zap,      label: 'Tech Showcase',    sub: 'S3 context → social post',  color: 'bg-amber'       },
  { to: '/blog',   icon: FileText, label: 'Blog Post → PR',   sub: 'AI blog + GitHub PR',       color: 'bg-emerald-600' },
]

const WF_LABELS = {
  lead_generation:   'Lead Generation',
  lead_email_existing: 'Lead Re-email',
  social_product:    'Product Post',
  social_tech:       'Tech Post',
  blog:              'Blog Post',
}

const WF_COLORS = {
  lead_generation:     'bg-royal',
  lead_email_existing: 'bg-indigo-500',
  social_product:      'bg-navy',
  social_tech:         'bg-amber',
  blog:                'bg-emerald-600',
}

function CostBar({ label, cost, totalCost, color }) {
  const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-xs text-slate-500 truncate">{label}</div>
      <div className="flex-1 bg-slate-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-14 text-right text-xs font-medium text-navy">${cost.toFixed(4)}</div>
    </div>
  )
}

export default function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: getDashboard,
    refetchInterval: 60_000,
  })
  const { data: approvalsData } = useQuery({
    queryKey: ['pending-approvals-count'],
    queryFn: () => listApprovals('pending'),
    refetchInterval: 30_000,
  })

  const stats = data || {}
  const pendingApprovals = approvalsData?.approvals || []
  const recentRuns = stats.workflow_runs || []
  const costData   = stats.cost || {}
  const totalCost  = costData.total_usd || 0
  const costByType = costData.by_type || {}

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={LayoutDashboard} title="Dashboard" sub="Overview of all workflows and activity" />

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {isLoading ? (
          Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <StatCard label="Total Leads"  value={stats.leads?.total ?? 0}        sub={`${stats.leads?.by_status?.emailed ?? 0} emailed`}     accent="text-royal" />
            <StatCard label="Social Posts" value={stats.social_posts?.total ?? 0} sub={`${stats.social_posts?.by_status?.posted ?? 0} posted`} accent="text-navy" />
            <StatCard label="Blog Posts"   value={stats.blogs?.total ?? 0}         sub={`${stats.blogs?.by_status?.pr_created ?? 0} PRs open`}  accent="text-amber-600" />
            <StatCard label="Awaiting You" value={stats.pending_approvals ?? 0}    sub="pending approvals"                                       accent="text-red-600" />
          </>
        )}
      </div>

      {/* Workflow launchers */}
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Start a Workflow</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {WORKFLOW_CARDS.map(({ to, icon: Icon, label, sub, color }) => (
          <Link key={to} to={to}
            className="card p-5 hover:shadow-panel transition-shadow group flex flex-col gap-3">
            <div className={`w-10 h-10 rounded-xl ${color} flex items-center justify-center`}>
              <Icon size={20} className="text-white" />
            </div>
            <div>
              <div className="font-semibold text-navy text-sm">{label}</div>
              <div className="text-xs text-slate-400 mt-0.5">{sub}</div>
            </div>
            <div className="flex items-center gap-1 text-xs text-slate-400 group-hover:text-royal transition-colors mt-auto">
              Launch <ArrowRight size={12} />
            </div>
          </Link>
        ))}
      </div>

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              Pending Approvals ({pendingApprovals.length})
            </h2>
            <Link to="/approvals" className="text-xs text-royal hover:underline flex items-center gap-1">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="card divide-y divide-slate-100">
            {pendingApprovals.slice(0, 5).map(item => (
              <div key={item.id} className="flex items-center gap-4 px-5 py-3.5">
                <CheckSquare size={16} className="text-amber flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-navy capitalize">
                    {item.workflow_type?.replace(/_/g, ' ')}
                  </div>
                  <div className="text-xs text-slate-400">
                    {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                  </div>
                </div>
                <StatusBadge status="pending" />
                <Link to="/approvals" className="btn-secondary text-xs py-1 px-3">Review</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom grid: pipeline + breakdown + cost */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Lead pipeline */}
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-navy mb-4">Lead Pipeline</h3>
          {isLoading ? (
            <div className="space-y-2">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-6" />)}</div>
          ) : Object.keys(stats.leads?.by_status || {}).length === 0 ? (
            <p className="text-xs text-slate-400">No leads yet</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(stats.leads?.by_status || {}).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <StatusBadge status={status} />
                  <span className="text-sm font-semibold text-navy">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Social posts breakdown */}
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-navy mb-4">Social Posts</h3>
          {isLoading ? (
            <div className="space-y-2">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-6" />)}</div>
          ) : Object.keys(stats.social_posts?.by_status || {}).length === 0 ? (
            <p className="text-xs text-slate-400">No posts yet</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(stats.social_posts?.by_status || {}).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <StatusBadge status={status} />
                  <span className="text-sm font-semibold text-navy">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI Cost tracking */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-navy flex items-center gap-1.5">
              <Cpu size={14} className="text-slate-400" />AI Costs
            </h3>
            <span className="text-xs text-slate-400">Nova Pro · all time</span>
          </div>
          {isLoading ? (
            <div className="space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-5" />)}</div>
          ) : totalCost === 0 ? (
            <div className="text-center py-4">
              <DollarSign size={22} className="text-slate-200 mx-auto mb-1" />
              <p className="text-xs text-slate-400">No cost data yet</p>
              <p className="text-xs text-slate-300 mt-0.5">Costs logged after next workflow run</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs text-slate-500">Total spent</span>
                <span className="text-xl font-bold text-navy">${totalCost.toFixed(4)}</span>
              </div>
              <div className="space-y-2.5">
                {Object.entries(costByType)
                  .sort(([,a],[,b]) => b - a)
                  .map(([type, cost]) => (
                    <CostBar
                      key={type}
                      label={WF_LABELS[type] || type}
                      cost={cost}
                      totalCost={totalCost}
                      color={WF_COLORS[type] || 'bg-slate-400'}
                    />
                  ))
                }
              </div>
              <p className="text-xs text-slate-300 mt-4 text-center">
                FLUX images via Gradio are free · cost = Nova Pro tokens only
              </p>
            </>
          )}
        </div>
      </div>

      {/* Recent workflow runs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Recent Workflow Runs</h2>
          <Link to="/history" className="text-xs text-royal hover:underline flex items-center gap-1">
            View history <ArrowRight size={12} />
          </Link>
        </div>
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : recentRuns.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={History} title="No workflow runs yet" sub="Launch a workflow to see execution details here." />
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentRuns.map(run => {
                const durationSec = run.completed_at
                  ? Math.round((new Date(run.completed_at) - new Date(run.started_at)) / 1000)
                  : null
                const cost = parseFloat(run.cost_usd || 0)
                return (
                  <div key={run.id} className="flex items-center gap-4 px-5 py-4">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      run.status === 'succeeded' ? 'bg-emerald-400'
                      : run.status === 'running'  ? 'bg-blue-400 animate-pulse'
                      : 'bg-red-400'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-navy capitalize">
                        {WF_LABELS[run.workflow_type] || run.workflow_type?.replace(/_/g, ' ')}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                        <span>{formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}</span>
                        {durationSec !== null && <span>· {durationSec}s</span>}
                        {cost > 0 && (
                          <span className="text-emerald-600 font-medium">· ${cost.toFixed(4)}</span>
                        )}
                      </div>
                    </div>
                    <StatusBadge status={run.status} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}