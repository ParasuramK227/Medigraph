import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderKanban, Loader2, Search, X } from 'lucide-react'
import { fetchSectors, type SectorRow } from '../lib/api'
import './SectorsPage.css'

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export function SectorsPage() {
  const [sectors, setSectors] = useState<SectorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchSectors()
      .then((rows) => {
        if (cancelled) return
        setSectors(rows)
      })
      .catch(() => {
        if (!cancelled) setSectors([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return sectors
    return sectors.filter((s) => s.name.toLowerCase().includes(q))
  }, [sectors, searchQuery])

  return (
    <div className="page sectors-page">
      <div className="sectors-page__header-wrap">
        <div>
          <h1 className="page__heading">Sectors</h1>
          <p className="sectors-page__sub">
            Disease-focused cohorts. Select a sector to explore the patient network,
            outcomes, and recommended treatments.
          </p>
        </div>

        {/* Search Bar */}
        <div className="sectors-page__search-bar">
          <Search size={16} className="sectors-page__search-icon" />
          <input
            type="text"
            className="sectors-page__search-input"
            placeholder="Search disease sectors (e.g. prediabetes, anemia)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="sectors-page__search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="sectors-page__meta-bar">
        {!loading && (
          <span className="sectors-page__count">
            {searchQuery
              ? `Showing ${filtered.length} of ${sectors.length} sectors matching "${searchQuery}"`
              : `All ${sectors.length} disease cohorts`}
          </span>
        )}
      </div>

      {loading && (
        <div className="sectors-page__loading">
          <Loader2 className="sectors-page__spin" size={20} />
          Loading sectors…
        </div>
      )}

      {!loading && sectors.length === 0 && (
        <div className="sectors-page__loading">No sectors found.</div>
      )}

      {!loading && sectors.length > 0 && filtered.length === 0 && (
        <div className="sectors-page__loading">
          No disease sectors found matching “{searchQuery}”.{' '}
          <button className="sectors-page__reset-btn" onClick={() => setSearchQuery('')}>
            Clear search
          </button>
        </div>
      )}

      <div className="sectors-page__grid">
        {filtered.map((s) => (
          <Link
            key={s.name}
            className="sectors-page__card"
            to={`/sectors/${slug(s.name)}`}
          >
            <div className="sectors-page__card-icon">
              <FolderKanban size={16} />
            </div>
            <div className="sectors-page__card-body">
              <div className="sectors-page__card-title">{s.name}</div>
              <div className="sectors-page__card-meta">
                {s.patients} patient{s.patients === 1 ? '' : 's'} • {s.medications} medication
                {s.medications === 1 ? '' : 's'}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}