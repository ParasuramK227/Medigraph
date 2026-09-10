import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  fetchMe,
  login as apiLogin,
  register as apiRegister,
  onUnauthorized,
  type ApiError,
  type AuthUser,
} from '../lib/api'
import {
  clearAuth,
  getStoredToken,
  getStoredUser,
  setStoredToken,
  setStoredUser,
} from '../lib/auth-storage'

interface AuthContextValue {
  user: AuthUser | null
  ready: boolean
  login: (usernameOrEmail: string, password: string) => Promise<AuthUser>
  register: (username: string, email: string, password: string) => Promise<AuthUser>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const [ready, setReady] = useState(false)

  // Restore / validate a persisted session against the backend.
  useEffect(() => {
    let cancelled = false
    const token = getStoredToken()
    if (!token) {
      setReady(true)
      return
    }
    fetchMe()
      .then((u) => {
        if (!cancelled) {
          setUser(u)
          setStoredUser(u)
        }
      })
      .catch((e) => {
        // A real 401 (invalid/expired session) drops the session. A network or
        // backend failure (no `status`) means we may be offline — keep the
        // persisted user so on-device features still work.
        if (!cancelled && e instanceof Error && (e as ApiError).status === 401) {
          clearAuth()
          setUser(null)
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Centralized 401 handler: any API call that fails auth drops the session.
  useEffect(() => onUnauthorized(() => setUser(null)), [])

  const login = useCallback(async (usernameOrEmail: string, password: string) => {
    const res = await apiLogin(usernameOrEmail, password)
    setStoredToken(res.token)
    setStoredUser(res.user)
    setUser(res.user)
    return res.user
  }, [])

  const register = useCallback(async (username: string, email: string, password: string) => {
    const res = await apiRegister(username, email, password)
    setStoredToken(res.token)
    setStoredUser(res.user)
    setUser(res.user)
    return res.user
  }, [])

  const logout = useCallback(() => {
    clearAuth()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, ready, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}