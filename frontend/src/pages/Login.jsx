import { useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'

const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'https://apps.stellarglobalsupplies.com'

// No login form — SSO handles everything from the portal
export default function Login() {
  const { user } = useAuth()

  useEffect(() => {
    if (!user) {
      const callback = encodeURIComponent(window.location.origin + '/')
      window.location.replace(`${LANDING_URL}/login?callback=${callback}`)
    }
  }, [user])

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="w-10 h-10 border-4 border-navy/20 border-t-navy rounded-full animate-spin" />
    </div>
  )
}
