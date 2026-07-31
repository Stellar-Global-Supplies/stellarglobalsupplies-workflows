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
import WorkflowRuns   from './pages/WorkflowRuns'
import History        from './pages/History'
import Schedules      from './pages/Schedules'
import PaymentFollowup from './pages/PaymentFollowup'

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

// Error Boundary Component
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('App error boundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
          <div className="max-w-md p-8 bg-white rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-lg font-semibold text-navy mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-600 mb-4">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button 
              onClick={() => this.setState({ hasError: false, error: null })}
              className="btn-primary w-full justify-center">
              Try again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ErrorBoundary>
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
              <Route path="schedules"        element={<Schedules />} />
              <Route path="payment-followup" element={<PaymentFollowup />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </AuthProvider>
  )
}
