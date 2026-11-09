import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function HomePage() {
  const { team, user, logout, hasPermission } = useAuth()

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Lumon MDR Console</h1>
            {team && user && (
              <p className="text-sm text-slate-400">
                {user.displayName} · {team.name} ({team.code})
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded border border-slate-700 px-3 py-1 text-sm"
          >
            Cerrar sesion
          </button>
        </header>

        <nav className="space-y-2">
          <Link to="/estado" className="block rounded border border-slate-800 bg-slate-900 p-3">
            Estado del piso
          </Link>
          {hasPermission('files:read') && (
            <Link to="/files" className="block rounded border border-slate-800 bg-slate-900 p-3">
              Archivos de datos (CP2)
            </Link>
          )}
          {hasPermission('refiners:read') && (
            <Link to="/refiners" className="block rounded border border-slate-800 bg-slate-900 p-3">
              Expedientes del personal (CP4)
            </Link>
          )}
        </nav>
      </div>
    </main>
  )
}
