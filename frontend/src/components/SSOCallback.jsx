import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const EXCHANGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sso-exchange`
const LANDING_URL =
  import.meta.env.VITE_LANDING_URL || 'https://apps.stellarglobalsupplies.com'

const MAX_AGE_MS = 5 * 60 * 1000

/**
 * Validates and normalizes the post-login redirect.
 *
 * Only same-origin HTTP/HTTPS URLs are allowed.
 * Anything external, malformed, or using another protocol
 * falls back to the application root.
 */
function getSafeRedirect(value: string | null): string {
  const fallback = '/'

  if (!value) {
    return fallback
  }

  try {
    const target = new URL(value, window.location.origin)

    // Only allow redirects to this application's exact origin.
    if (target.origin !== window.location.origin) {
      return fallback
    }

    // Only allow normal HTTP/HTTPS navigation.
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return fallback
    }

    return target.href
  } catch {
    // Invalid/malformed URL.
    return fallback
  }
}

export default function SSOCallback() {
  const [status, setStatus] = useState('Verifying your session…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    const token = params.get('token')

    // SECURITY:
    // Never use the user-controlled redirect parameter directly.
    const redirectParam = params.get('redirect')
    const redirect = getSafeRedirect(redirectParam)

    const ts = Number(params.get('ts') || 0)

    if (ts && Date.now() - ts > MAX_AGE_MS) {
      setError(
        'This sign-in link has expired. Please return to the portal.'
      )
      return
    }

    if (!token) {
      // redirect has already been validated as same-origin.
      const callback = encodeURIComponent(redirect)

      window.location.replace(
        `${LANDING_URL}/login?callback=${callback}`
      )

      return
    }

    setStatus('Exchanging credentials…')

    fetch(EXCHANGE_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    })
      .then(async res => {
        const data = await res.json()

        if (!res.ok) {
          throw new Error(
            data.error || `Exchange failed (${res.status})`
          )
        }

        return data
      })
      .then(
        async ({
          access_token,
          refresh_token,
        }: {
          access_token: string
          refresh_token: string
        }) => {
          setStatus('Setting up your workspace…')

          const { error: authErr } =
            await supabase.auth.setSession({
              access_token,
              refresh_token,
            })

          if (authErr) {
            throw new Error(authErr.message)
          }

          // SECURITY:
          // redirect has already been validated and normalized
          // to the current application's origin.
          window.location.replace(redirect)
        }
      )
      .catch(err => {
        setError(
          err instanceof Error
            ? err.message
            : 'Sign-in failed. Please return to the portal.'
        )
      })
  }, [])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-sm w-full text-center">
          <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#DC2626"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>

          <p className="font-semibold text-navy mb-2">
            Sign-in error
          </p>

          <p className="text-sm text-slate-500 mb-6">
            {error}
          </p>

          <a
            href={LANDING_URL}
            className="inline-block px-6 py-2.5 bg-navy text-white font-semibold rounded-lg text-sm hover:bg-navy/90 transition"
          >
            Return to Portal
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="text-center space-y-4">
        <div className="w-10 h-10 border-4 border-navy/20 border-t-navy rounded-full animate-spin mx-auto" />

        <div>
          <p className="font-semibold text-navy">
            Stellar Workflows
          </p>

          <p className="text-sm text-slate-500 mt-1">
            {status}
          </p>
        </div>
      </div>
    </div>
  )
}
