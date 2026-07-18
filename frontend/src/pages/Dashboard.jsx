import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getDashboard, listApprovals } from '../services/api'
import { StatCard, Skeleton, StatusBadge, PageHeader } from '../components/ui'
import { LayoutDashboard, Users, Share2, FileText, CheckSquare, ArrowRight, Zap } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const WORKFLOW_CARDS = [
  { to: '/leads',   icon: Users,      label: 'Lead Generation',     sub: 'Hunter.io + AI outreach',    color: 'bg-royal'   },
  { to: '/social',  icon: Share2,     label: 'Product Posts',       sub: 'AI image + multi-platform',  color: 'bg-navy'    },
  { to: '/tech',    icon: Zap,        label: 'Tech Showcase',       sub: 'S3 context → social post',   color: 'bg-amber'   },
  { to: '/blog',    icon: FileText,   label: 'Blog Post → PR',      sub: 'AI blog + GitHub PR',        color: 'bg-emerald-600' },
]

export default function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: getDashboard,
    refetchInterval: 60_000,
  })
  const { data: approvalsData } = useQuery({
    queryKey: ['approvals-pending'],
    queryFn: () => listApprovals('pending'),
    refetchInterval: 30_000,
  })

  const stats = data || {}
  const pendingApprovals = approvalsData?.approvals || []

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={LayoutDashboard} title="Dashboard" sub="Overview of all workflows and activity" />

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {isLoading ? (
          Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <StatCard label="Total Leads"    value={stats.leads?.total ?? 0}          sub={`${stats.leads?.by_status?.emailed ?? 0} emailed`}     accent="text-royal" />
            <StatCard label="Social Posts"   value={stats.social_posts?.total ?? 0}   sub={`${stats.social_posts?.by_status?.posted ?? 0} posted`} accent="text-navy" />
            <StatCard label="Blog Posts"     value={stats.blogs?.total ?? 0}           sub={`${stats.blogs?.by_status?.pr_created ?? 0} PRs open`}  accent="text-amber-600" />
            <StatCard label="Awaiting You"   value={stats.pending_approvals ?? 0}      sub="pending approvals"                                       accent="text-red-600" />
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
        <div>
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

      {/* Lead status breakdown */}
      {stats.leads?.by_status && (
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-navy mb-4">Lead Pipeline</h3>
            <div className="space-y-2">
              {Object.entries(stats.leads.by_status).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <StatusBadge status={status} />
                  <span className="text-sm font-semibold text-navy">{count}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-navy mb-4">Social Posts Breakdown</h3>
            <div className="space-y-2">
              {Object.entries(stats.social_posts?.by_status || {}).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <StatusBadge status={status} />
                  <span className="text-sm font-semibold text-navy">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
