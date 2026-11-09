import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ApiError, isValidationError } from '../lib/types'

export function RegisterPage() {
  const { user, ready, register } = useAuth()
  const navigate = useNavigate()

  const [teamName, setTeamName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  if (ready && user) {
    return <Navigate to="/" replace />
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setGeneralError(null)
    setFieldErrors({})
    setSubmitting(true)
    try {
      await register(teamName, email, password)
      navigate('/', { replace: true })
    } catch (err) {
      if (isValidationError(err)) {
        setFieldErrors(err.body.details.fields)
      } else if (err instanceof ApiError) {
        setGeneralError(err.body.message || 'No se pudo registrar la cuadrilla.')
      } else {
        setGeneralError('No se pudo conectar con Lumon.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded border border-slate-800 bg-slate-900 p-6"
      >
        <h1 className="text-xl font-semibold">Registrar cuadrilla</h1>

        {generalError && (
          <p role="alert" className="rounded bg-red-900/40 p-2 text-sm text-red-200">
            {generalError}
          </p>
        )}

        <div>
          <label htmlFor="teamName" className="block text-sm">Nombre del equipo</label>
          <input
            id="teamName"
            name="teamName"
            type="text"
            required
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            aria-invalid={!!fieldErrors.teamName}
            aria-describedby={fieldErrors.teamName ? 'teamName-error' : undefined}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1"
          />
          {fieldErrors.teamName && (
            <p id="teamName-error" className="mt-1 text-sm text-red-300">{fieldErrors.teamName}</p>
          )}
        </div>

        <div>
          <label htmlFor="email" className="block text-sm">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? 'email-error' : undefined}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1"
          />
          {fieldErrors.email && (
            <p id="email-error" className="mt-1 text-sm text-red-300">{fieldErrors.email}</p>
          )}
        </div>

        <div>
          <label htmlFor="password" className="block text-sm">Contrasena</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!fieldErrors.password}
            aria-describedby={fieldErrors.password ? 'password-error' : undefined}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1"
          />
          {fieldErrors.password && (
            <p id="password-error" className="mt-1 text-sm text-red-300">{fieldErrors.password}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-slate-200 py-2 font-medium text-slate-900 disabled:opacity-50"
        >
          {submitting ? 'Registrando…' : 'Registrar'}
        </button>

        <p className="text-center text-sm text-slate-400">
          ¿Ya tienen cuenta? <Link to="/login" className="underline">Ingresar</Link>
        </p>
      </form>
    </main>
  )
}
