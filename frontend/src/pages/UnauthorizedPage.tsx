import { Link } from 'react-router-dom'
import { ShieldAlert, LayoutDashboard } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import './UnauthorizedPage.css'

export function UnauthorizedPage() {
  const { user, logout } = useAuth()

  return (
    <div className="unauthorized-page">
      <div className="unauthorized-card">
        <span className="unauthorized-card__icon">
          <ShieldAlert size={28} />
        </span>
        <h1 className="unauthorized-card__title">403 · Access denied</h1>
        <p className="unauthorized-card__body">
          Your current role (<strong>{user?.role ?? 'unknown'}</strong>) is not
          permitted to view this page.
        </p>
        <div className="unauthorized-card__actions">
          <Link to="/" className="unauthorized-card__btn">
            <LayoutDashboard size={15} /> Go to dashboard
          </Link>
          <button type="button" className="unauthorized-card__btn unauthorized-card__btn--ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}