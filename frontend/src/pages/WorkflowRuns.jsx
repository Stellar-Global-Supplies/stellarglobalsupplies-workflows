import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getWorkflowRuns } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import { Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'

const STATUSES = ['all', 'running', 'succeeded', 'failed', 'stopped', 'timed_out']

function durationSeconds(run) {
  const end = run.completed_at ? new Date(run.completed_at) : new Date()
  const start = new Date(run.started_at)
  return Math.max(0, Math.round((end - start) / 1000))
}

function JsonBlock({ title, value }) {
  return (
    <div>
      <div className="font-semibold text-slate-600 mb-1">{title}</div>
      <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">
        {typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2)}
      </pre>
    </div>
  )
}

export default function WorkflowRuns() {
  const [status, setStatus] = useState('all')
  const [openRunId, setOpenRunId] = useState(null)

  const qs = status === 'all' ? 'limit=100' : `status=${status}&limit=100`
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['workflow-runs-page', status],
    queryFn: () => getWorkflowRuns(qs),
    refetchInterval: status === 'running' || status === 'all' ? 15_000 : false,
  })
  const runs = data?.runs || []

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={Activity} title="Workflow Runs" sub="Track executions, errors, inputs, and outputs">
        <button onClick={() => refetch()} className="btn-secondary" disabled={isFetching}>
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh
        </button>
      </PageHeader>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6 flex-wrap">
        {STATUSES.map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
              ${status === s ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 text-sm font-medium text-navy">
          Runs ({runs.length})
        </div>
        {isLoading ? (
          <div className="p-4 space-y-2">{Array(7).fill(0).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : runs.length === 0 ? (
          <EmptyState icon={Activity} title="No workflow runs found" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  {['Workflow', 'Status', 'Started', 'Duration', 'Execution'].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {runs.map(run => (
                  <Fragment key={run.id}>
                    <tr className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-navy capitalize">{run.workflow_type?.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3"><StatusBadge status={run.status} /></td>
                      <td className="px-4 py-3 text-slate-500 text-xs">
                        <div>{format(new Date(run.started_at), 'dd MMM yy HH:mm')}</div>
                        <div className="text-slate-400">{formatDistanceToNowStrict(new Date(run.started_at), { addSuffix: true })}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{durationSeconds(run)}s</td>
                      <td className="px-4 py-3 text-slate-400 text-xs font-mono max-w-xs">
                        <button onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)} className="flex items-center gap-1 hover:text-navy">
                          {openRunId === run.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className="truncate">{run.execution_arn?.split(':').pop() || run.id.slice(0, 8)}</span>
                        </button>
                      </td>
                    </tr>
                    {openRunId === run.id && (
                      <tr key={`${run.id}-details`} className="bg-slate-50/60">
                        <td colSpan={5} className="px-4 py-4">
                          <div className="grid gap-4 md:grid-cols-3 text-xs">
                            <JsonBlock title="Input" value={run.input} />
                            <JsonBlock title="Output" value={run.output} />
                            <JsonBlock title="Error" value={run.error_msg || 'No error recorded'} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
