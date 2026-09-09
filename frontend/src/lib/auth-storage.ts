export interface AuthUser {
  id: string
  username: string
  email?: string
  role: 'admin' | 'doctor' | 'researcher' | string
  active?: boolean
}

const TOKEN_KEY = 'medigraph_auth_token'
const USER_KEY = 'medigraph_auth_user'

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

export function setStoredUser(user: AuthUser | null): void {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
    else localStorage.removeItem(USER_KEY)
  } catch {}
}

export function clearAuth(): void {
  setStoredToken(null)
  setStoredUser(null)
}