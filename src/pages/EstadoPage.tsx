import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { apiFetch } from '../lib/apiClient'
import { ApiError } from '../lib/types'

// CP6 exige esta pagina: "muestra el build desplegado, si la API responde,
// el estado de las integraciones y de la clearance, y el boton que corre
// la revision automatica".
//
// El boton tiene que correrse desde la app DESPLEGADA, no desde Swagger ni
// localhost: en esos casos el backend responde 403 CHECK_FROM_APP_REQUIRED.

interface IntegrationsStatus {
  deploy?: { verified: boolean; origin?: string }
  storage?: { verified: boolean; provider?: string }
}

export function EstadoPage() {
  const { user, team, clearance, refreshMe } = useAuth()

  const [apiAlive, setApiAlive] = useState<boolean | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null)
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checkResult, setCheckResult] = useState<unknown>(null)

  const loadAll = useCallback(async () => {
    try {
      await apiFetch('/meta/health', { auth: false })
      setApiAlive(true)
    } catch {
      setApiAlive(false)
    }
    if (user) {
      try {
        const integ = await apiFetch<IntegrationsStatus>('/integrations/status')
        setIntegrations(integ)
      } catch {
        setIntegrations(null)
      }
    }
  }, [user])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  async function runClearanceCheck() {
    setCheckRunning(true)
    setCheckError(null)
    setCheckResult(null)
    try {
      const result = await apiFetch<unknown>('/clearance/check', { method: 'POST' })
      setCheckResult(result)
      await refreshMe()
    } catch (err) {
      if (err instanceof ApiError) {
        setCheckError(err.body.error + ': ' + err.body.message)
      } else {
        setCheckError('No se pudo correr la revision automatica.')
      }
    } finally {
      setCheckRunning(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Estado</h1>
          <p className="text-sm text-slate-400">
            Build desplegado: <code className="rounded bg-slate-800 px-1">{(import.meta.env.VITE_LUMON_BUILD_SHA as string | undefined) ?? 'dev'}</code>
          </p>
          {team && (
            <p className="text-sm text-slate-400">
              Equipo: {team.name} ({team.code})
            </p>
          )}
        </header>

        <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4">
          <h2 className="font-medium">Infraestructura</h2>
          <ul className="space-y-1 text-sm">
            <li>
              API /meta/health:{' '}
              {apiAlive === null ? '…' : apiAlive ? '✓ OK' : '✗ sin respuesta'}
            </li>
            <li>
              Dominio verificado:{' '}
              {integrations?.deploy?.verified ? '✓' : '✗'}{' '}
              {integrations?.deploy?.origin && (
                <code className="rounded bg-slate-800 px-1">{integrations.deploy.origin}</code>
              )}
            </li>
            <li>
              Storage verificado:{' '}
              {integrations?.storage?.verified ? '✓' : '✗'}{' '}
              {integrations?.storage?.provider && (
                <span className="text-slate-400">({integrations.storage.provider})</span>
              )}
            </li>
            <li>
              Piso de Pruebas:{' '}
              {clearance.granted ? (
                <span>✓ abierto (desde {clearance.grantedAt})</span>
              ) : (
                <span>✗ cerrado</span>
              )}
            </li>
          </ul>
        </section>

        {user && !clearance.granted && (
          <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4">
            <h2 className="font-medium">Abrir el Piso de Pruebas</h2>
            <p className="text-sm text-slate-400">
              La revision automatica comprueba el uso real de la app DESPLEGADA. Correr este
              boton desde localhost o Swagger responde <code>403 CHECK_FROM_APP_REQUIRED</code>.
            </p>
            <button
              type="button"
              onClick={runClearanceCheck}
              disabled={checkRunning}
              className="rounded bg-slate-200 px-4 py-2 font-medium text-slate-900 disabled:opacity-50"
            >
              {checkRunning ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
            </button>
            {checkError && (
              <p role="alert" className="text-sm text-red-300">{checkError}</p>
            )}
            {checkResult !== null && (
              <pre className="overflow-auto rounded bg-slate-800 p-2 text-xs">
                {JSON.stringify(checkResult, null, 2)}
              </pre>
            )}
          </section>
        )}
      </div>
    </main>
  )
}
