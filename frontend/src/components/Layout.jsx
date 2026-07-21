import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useQuery } from '@tanstack/react-query'
import { listApprovals } from '../services/api'
import {
  LayoutDashboard, Users, Share2, Code2, FileText,
  CheckSquare, History, LogOut, Menu, X, Bell, Activity, CalendarClock, Layers, CreditCard
} from 'lucide-react'

const NAV = [
  { to: '/',          icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/leads',     icon: Users,           label: 'Lead Generation' },
  { to: '/social',    icon: Share2,          label: 'Product Posts' },
  { to: '/tech',      icon: Code2,           label: 'Tech Showcase' },
  { to: '/blog',      icon: FileText,        label: 'Blog Posts' },
  { to: '/content',   icon: Layers,          label: 'Content' },
  { to: '/approvals', icon: CheckSquare,     label: 'Approvals', badge: true },
  { to: '/workflow-runs', icon: Activity,    label: 'Workflow Runs' },
  { to: '/schedules',        icon: CalendarClock, label: 'Schedules' },
  { to: '/payment-followup', icon: CreditCard,    label: 'Payment Follow-up' },
  { to: '/history',   icon: History,         label: 'History' },
]

export default function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const { data: pending } = useQuery({
    queryKey: ['pending-approvals-count'],
    queryFn: () => listApprovals('pending'),
    refetchInterval: 30_000,
  })
  const pendingCount = pending?.count ?? 0

  const handleSignOut = async () => { await signOut(); navigate('/login') }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100">

      {/* Mobile overlay */}
      {open && <div className="fixed inset-0 bg-black/40 z-20 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 flex flex-col bg-navy transition-transform duration-200
        lg:static lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
          <div className="w-8 h-8 rounded-lg bg-amber flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-sm">S</span>
          </div>
          <div>
            <div className="text-white font-semibold text-sm leading-tight">Stellar Workflows</div>
            <div className="text-white/50 text-xs">Global Supplies</div>
          </div>
          <button onClick={() => setOpen(false)} className="ml-auto text-white/50 lg:hidden">
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, icon: Icon, label, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) => `
                flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                ${isActive
                  ? 'bg-white/15 text-white'
                  : 'text-white/65 hover:bg-white/8 hover:text-white'}
              `}
            >
              <Icon size={17} />
              <span className="flex-1">{label}</span>
              {badge && pendingCount > 0 && (
                <span className="bg-amber text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                  {pendingCount > 9 ? '9+' : pendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="px-4 py-4 border-t border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-royal flex items-center justify-center text-white text-xs font-bold">
              {user?.email?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-xs font-medium truncate">{user?.email}</div>
              <div className="text-white/40 text-xs">Admin</div>
            </div>
            <button onClick={handleSignOut} className="text-white/40 hover:text-white transition-colors" title="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-4 flex-shrink-0">
          <button onClick={() => setOpen(true)} className="lg:hidden text-slate-500 hover:text-slate-700">
            <Menu size={20} />
          </button>
          <div className="flex-1" />
          {pendingCount > 0 && (
            <NavLink to="/approvals" className="flex items-center gap-2 text-sm text-amber-600 font-medium hover:text-amber-700">
              <Bell size={16} className="animate-pulse" />
              {pendingCount} pending approval{pendingCount !== 1 ? 's' : ''}
            </NavLink>
          )}
          <div className="w-px h-5 bg-slate-200" />
          <a href="https://stellarglobalsupplies.com" target="_blank" rel="noopener noreferrer"
            className="text-xs text-slate-400 hover:text-navy transition-colors">
            stellarglobalsupplies.com ↗
          </a>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}