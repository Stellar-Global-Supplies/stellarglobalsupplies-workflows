import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Loader2, Globe } from 'lucide-react'
import toast from 'react-hot-toast'

export default function Login() {
  const { signIn } = useAuth()
  const navigate   = useNavigate()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      const { error } = await signIn(email, password)
      if (error) throw error
      navigate('/')
    } catch (err) {
      toast.error(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-slate-100">
      {/* Left panel */}
      <div className="hidden lg:flex w-1/2 bg-navy flex-col justify-between p-12 relative overflow-hidden">
        {/* Decorative rings */}
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full border border-white/5" />
        <div className="absolute -top-16 -left-16 w-64 h-64 rounded-full border border-white/8" />
        <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full bg-royal/20 blur-3xl" />

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-14">
            <div className="w-10 h-10 rounded-xl bg-amber flex items-center justify-center">
              <Globe size={20} className="text-white" />
            </div>
            <div>
              <div className="text-white font-bold text-lg leading-tight">Stellar Global Supplies</div>
              <div className="text-white/50 text-xs">Workflows Platform</div>
            </div>
          </div>

          <h2 className="text-4xl font-bold text-white leading-snug mb-4">
            Intelligent<br />automation for<br />
            <span className="text-amber">every workflow.</span>
          </h2>
          <p className="text-white/60 text-sm leading-relaxed max-w-xs">
            Generate leads, create social content, publish blogs — all with AI assistance and human approval at every step.
          </p>
        </div>

        <div className="relative z-10 grid grid-cols-2 gap-4">
          {[
            { n: '4',  l: 'Automated Workflows' },
            { n: '∞',  l: 'AI-Generated Content' },
            { n: '50', l: 'Hunter.io Credits/mo' },
            { n: '✓',  l: 'Human-in-the-Loop' },
          ].map(({ n, l }) => (
            <div key={l} className="bg-white/6 rounded-xl p-4 border border-white/8">
              <div className="text-2xl font-bold text-amber mb-1">{n}</div>
              <div className="text-white/60 text-xs">{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-lg bg-navy flex items-center justify-center">
              <Globe size={16} className="text-white" />
            </div>
            <span className="font-semibold text-navy">Stellar Workflows</span>
          </div>

          <h1 className="text-2xl font-bold text-navy mb-1">Welcome back</h1>
          <p className="text-sm text-slate-500 mb-8">Sign in to your workspace</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email address</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="input" placeholder="you@stellarglobalsupplies.com"
                required autoFocus autoComplete="email"
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="input" placeholder="••••••••"
                required autoComplete="current-password"
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5">
              {loading ? <><Loader2 size={16} className="animate-spin" /> Signing in…</> : 'Sign in'}
            </button>
          </form>

          <p className="text-center text-xs text-slate-400 mt-8">
            Powered by AWS Step Functions · Bedrock Nova · Supabase
          </p>
        </div>
      </div>
    </div>
  )
}
