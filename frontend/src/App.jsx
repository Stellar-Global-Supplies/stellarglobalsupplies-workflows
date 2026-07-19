import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Layout      from './components/Layout'
import Login       from './pages/Login'
import Dashboard   from './pages/Dashboard'
import LeadGen     from './pages/LeadGeneration'
import SocialPost  from './pages/SocialMediaPost'
import TechPost    from './pages/TechPost'
import BlogPost    from './pages/BlogPost'
import Approvals   from './pages/ApprovalQueue'
import Content     from './pages/Content'
import WorkflowRuns from './pages/WorkflowRuns'
import History     from './pages/History'
import Schedules   from './pages/Schedules'

function Guard({ children }) {
  const { user, loading } = useAuth()
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-navy/20 border-t-navy rounded-full animate-spin" />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    </div>
  )
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Guard><Layout /></Guard>}>
            <Route index           element={<Dashboard />} />
            <Route path="leads"    element={<LeadGen />} />
            <Route path="social"   element={<SocialPost />} />
            <Route path="tech"     element={<TechPost />} />
            <Route path="blog"     element={<BlogPost />} />
            <Route path="approvals"     element={<Approvals />} />
            <Route path="content"       element={<Content />} />
            <Route path="workflow-runs" element={<WorkflowRuns />} />
            <Route path="history"   element={<History />} />
            <Route path="schedules" element={<Schedules />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}