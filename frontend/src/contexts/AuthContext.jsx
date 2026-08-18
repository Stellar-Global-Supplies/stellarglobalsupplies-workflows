import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const LANDING_URL = import.meta.env.VITE_LANDING_URL || 'https://apps.stellarglobalsupplies.com'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // ✅ Sign out of Supabase then return to portal
  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.replace(LANDING_URL)
  }

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
