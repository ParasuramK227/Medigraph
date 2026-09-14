import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loader2, LogIn, Stethoscope, UserPlus } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import './LoginPage.css'

export function LoginPage() {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await (mode === 'login'
        ? login(username, password)
        : register(username, email, password))
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <span className="login-card__logo">
            <Stethoscope size={22} />
          </span>
          <h1 className="login-card__title">MediGraph</h1>
          <p className="login-card__sub">
            Clinical knowledge graph · Role-based access control
          </p>
        </div>

        <div className="login-card__tabs">
          <button
            type="button"
            className={`login-card__tab ${mode === 'login' ? 'is-active' : ''}`}
            onClick={() => { setMode('login'); setError(null) }}
          >
            <LogIn size={14} /> Sign in
          </button>
          <button
            type="button"
            className={`login-card__tab ${mode === 'register' ? 'is-active' : ''}`}
            onClick={() => { setMode('register'); setError(null) }}
          >
            <UserPlus size={14} /> Create account
          </button>
        </div>

        <form className="login-card__form" onSubmit={submit}>
          <label className="login-card__field">
            <span>Username or email</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={mode === 'login' ? 'admin or admin@medigraph.demo' : 'username'}
              autoComplete="username"
              required
            />
          </label>

          {mode === 'register' && (
            <label className="login-card__field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
          )}

          <label className="login-card__field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'min. 8 characters' : '••••••••'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </label>

          {mode === 'register' && (
            <p className="login-card__hint">
              New accounts are created with the Researcher role. Role changes are
              managed by an administrator.
            </p>
          )}

          {error && <div className="login-card__error">{error}</div>}

          <button type="submit" className="login-card__submit" disabled={busy}>
            {busy ? <Loader2 className="login-card__spin" size={16} /> : null}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  )
}