import { useState, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { SideNav } from './SideNav'
import { ThemeToggle } from './ThemeToggle'
import { BackendStatus } from './BackendStatus'
import { ChatFloatingButton } from '../chat/ChatFloatingButton'
import './AppLayout.css'

const COLLAPSE_KEY = 'medigraph.navCollapsed'

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  const location = useLocation()

  const toggleNav = () => {
    if (window.matchMedia('(min-width: 769px)').matches) {
      setCollapsed((c) => {
        const next = !c
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
        return next
      })
    } else {
      setNavOpen(true)
    }
  }

  // Close navigation drawer when route changes
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // Prevent background scrolling when mobile drawer is open
  useEffect(() => {
    if (navOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [navOpen])

  return (
    <div className="app-layout">
      {navOpen && (
        <button
          type="button"
          className="app-layout__drawer-backdrop app-layout__drawer-backdrop--open"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <aside className={`app-layout__nav ${navOpen ? 'app-layout__nav--open' : ''} ${collapsed ? 'app-layout__nav--collapsed' : ''}`}>
        <SideNav onClose={() => setNavOpen(false)} />
      </aside>

      <div className="app-layout__main">
        <header className="app-layout__topbar">
          <button
            type="button"
            className="app-layout__menu"
            onClick={toggleNav}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <Menu size={22} aria-hidden />
          </button>
          <div className="app-layout__topbar-spacer" />
          <BackendStatus />
          <ThemeToggle />
        </header>

        <main className="app-layout__content">
          <Outlet />
        </main>
      </div>

      <ChatFloatingButton />
    </div>
  )
}
