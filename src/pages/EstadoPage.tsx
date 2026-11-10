import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { apiFetch } from '../lib/apiClient'
import { errorMessage, withRetry } from '../lib/retry'

// CP6 exige esta pagina: "muestra el build desplegado, si la API responde,
// el estado de las integraciones y de la clearance, y el boton que corre
// la revision automatica".
//
// El boton tiene que correrse desde la app DESPLEGADA, no desde Swagger ni
// localhost: en esos casos el backend responde 403 CHECK_FROM_APP_REQUIRED.

/** GET /integrations/status (Swagger: IntegrationStatus). */
interface IntegrationStatus {
  deploy: {
    origin: string | null
    verifiedAt: string | null
    lastBuildSeen: string | null
    lastBuildSeenAt: string | null
  }
  storage: {
    provider: 'SUPABASE' | 'CLOUDINARY' | null
    verifiedAt: string | null
    checks: { name: string; passed: boolean; detail: string }[]
  }
  clearance: { granted: boolean; grantedAt: string | null }
}

interface ClearanceCheck {
  name: 'DEPLOY' | 'SESSION' | 'GRID' | 'REFINE'
  passed: boolean
  detail: string
}

/** POST /clearance/check y parte de GET /clearance. */
interface ClearanceResult {
  granted: boolean
  grantedAt: string | null
  checks: ClearanceCheck[]
  workspace?: { kind: 'DEV' | 'EVAL'; chaosLevel: 0 | 1 | 2 }
}

const CHAOS_HELP: Record<number, string> = {
  0: 'Sin caos',
  1: 'Nivel 1 (mínimo de la evaluación; lo exige la revisión)',
  2: 'Nivel 2 (más agresivo)',
}

const BUILD = (import.meta.env.VITE_LUMON_BUILD_SHA as string | undefined) ?? 'dev'

function fmt(date: string | null | undefined): string {
  return date ? new Date(date).toLocaleString() : ''
}

export function EstadoPage() {
  const { user, team, refreshMe } = useAuth()

  const [apiAlive, setApiAlive] = useState<boolean | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null)
  const [integrationsError, setIntegrationsError] = useState<string | null>(null)
  const [clearance, setClearance] = useState<ClearanceResult | null>(null)

  const [checkRunning, setCheckRunning] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const [chaosSaving, setChaosSaving] = useState(false)
  const [chaosError, setChaosError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      await apiFetch('/meta/health', { auth: false })
      setApiAlive(true)
    } catch {
      setApiAlive(false)
    }
    if (!user) return
    try {
      setIntegrations(await withRetry(() => apiFetch<IntegrationStatus>('/integrations/status')))
      setIntegrationsError(null)
    } catch (err) {
      setIntegrationsError(errorMessage(err))
    }
    try {
      setClearance(await withRetry(() => apiFetch<ClearanceResult>('/clearance')))
    } catch {
      // /clearance es informativo: si falla, la pagina sigue funcionando.
    }
  }, [user])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  async function runClearanceCheck() {
    setCheckRunning(true)
    setCheckError(null)
    try {
      const result = await apiFetch<ClearanceResult>('/clearance/check', { method: 'POST' })
      setClearance((prev) => ({ ...result, workspace: prev?.workspace }))
      if (result.granted) await refreshMe()
    } catch (err) {
      setCheckError(errorMessage(err))
    } finally {
      setCheckRunning(false)
    }
  }

  async function setChaos(level: 0 | 1 | 2) {
    setChaosSaving(true)
    setChaosError(null)
    try {
      const res = await apiFetch<{ level: 0 | 1 | 2 }>('/workspace/chaos', { method: 'PUT', body: { level } })
      setClearance((prev) =>
        prev ? { ...prev, workspace: { kind: prev.workspace?.kind ?? 'DEV', chaosLevel: res.level } } : prev,
      )
    } catch (err) {
      setChaosError(errorMessage(err))
    } finally {
      setChaosSaving(false)
    }
  }

  const granted = clearance?.granted ?? integrations?.clearance.granted ?? false
  const chaosLevel = clearance?.workspace?.chaosLevel
  const isEval = clearance?.workspace?.kind === 'EVAL'

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <Link to="/" className="text-sm text-slate-400 underline">← Inicio</Link>
          <h1 className="text-2xl font-semibold">Estado</h1>
          <p className="text-sm text-slate-400">
            Build desplegado: <code className="rounded bg-slate-800 px-1">{BUILD}</code>
          </p>
          {team && (
            <p className="text-sm text-slate-400">
              Equipo: {team.name} ({team.code})
            </p>
          )}
        </header>

        <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4" aria-live="polite">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Infraestructura</h2>
            <button type="button" onClick={() => void loadAll()} className="text-sm underline">
              Actualizar
            </button>
          </div>
          {integrationsError && <p role="alert" className="text-sm text-red-300">{integrationsError}</p>}
          <ul className="space-y-1 text-sm">
            <li>
              API /meta/health: {apiAlive === null ? '…' : apiAlive ? '✓ responde' : '✗ sin respuesta'}
            </li>
            <li>
              Dominio verificado: {integrations?.deploy.verifiedAt ? '✓' : '✗'}{' '}
              {integrations?.deploy.origin && (
                <code className="rounded bg-slate-800 px-1">{integrations.deploy.origin}</code>
              )}
              {integrations?.deploy.lastBuildSeen && (
                <span className="text-slate-400">
                  {' '}· último build visto {integrations.deploy.lastBuildSeen} ({fmt(integrations.deploy.lastBuildSeenAt)})
                </span>
              )}
            </li>
            <li>
              Storage verificado: {integrations?.storage.verifiedAt ? '✓' : '✗'}{' '}
              {integrations?.storage.provider && (
                <span className="text-slate-400">({integrations.storage.provider})</span>
              )}
              {integrations && !integrations.storage.verifiedAt && integrations.storage.checks.length > 0 && (
                <ul className="ml-4 mt-1 list-disc text-xs text-slate-400">
                  {integrations.storage.checks.map((c) => (
                    <li key={c.name}>
                      {c.passed ? '✓' : '✗'} {c.name}: {c.detail}
                    </li>
                  ))}
                </ul>
              )}
            </li>
            <li>
              Piso de Pruebas: {granted ? `✓ abierto (desde ${fmt(clearance?.grantedAt ?? integrations?.clearance.grantedAt)})` : '✗ cerrado'}
            </li>
          </ul>
        </section>

        {user && !isEval && (
          <section className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4">
            <h2 className="font-medium">Modo caos</h2>
            <p className="text-sm text-slate-400">
              La revisión automática exige refinar con caos 1 o 2 activado. Actual:{' '}
              <strong className="text-slate-100">{chaosLevel === undefined ? '…' : CHAOS_HELP[chaosLevel]}</strong>
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Nivel de caos">
              {([0, 1, 2] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  disabled={chaosSaving}
                  aria-pressed={chaosLevel === lvl}
                  onClick={() => void setChaos(lvl)}
                  className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${
                    chaosLevel === lvl ? 'border-amber-400 bg-amber-900/40' : 'border-slate-700'
                  }`}
                >
                  Caos {lvl}
                </button>
              ))}
            </div>
            {chaosError && <p role="alert" className="text-sm text-red-300">{chaosError}</p>}
          </section>
        )}

        {user && (
          <section className="space-y-3 rounded border border-slate-800 bg-slate-900 p-4">
            <h2 className="font-medium">Abrir el Piso de Pruebas</h2>
            <p className="text-sm text-slate-400">
              Revisa el uso real de la app desplegada en los últimos 15 minutos: dominio y build, un refresh
              exitoso, 30+ bloques pedidos y, con caos activado, 3 grupos refinados con un reintento de la misma
              Idempotency-Key. Desde localhost responde <code>403 CHECK_FROM_APP_REQUIRED</code>.
            </p>
            <button
              type="button"
              onClick={() => void runClearanceCheck()}
              disabled={checkRunning}
              className="rounded bg-slate-200 px-4 py-2 font-medium text-slate-900 disabled:opacity-50"
            >
              {checkRunning ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
            </button>
            {checkError && <p role="alert" className="text-sm text-red-300">{checkError}</p>}
            {clearance && clearance.checks.length > 0 && (
              <ul className="space-y-1 text-sm" aria-live="polite">
                {clearance.checks.map((c) => (
                  <li key={c.name} className={c.passed ? 'text-emerald-300' : 'text-red-300'}>
                    {c.passed ? '✓' : '✗'} <strong>{c.name}</strong>: {c.detail}
                  </li>
                ))}
              </ul>
            )}
            {granted && <p className="text-sm text-emerald-300">El Piso de Pruebas está abierto.</p>}
          </section>
        )}
      </div>
    </main>
  )
}
