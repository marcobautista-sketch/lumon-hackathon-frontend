// Tipos del contrato de la API de Lumon.
// Fuente de verdad: https://lumon-api.vercel.app/docs (openapi.json).
// Si algo del codigo contradice Swagger, manda Swagger (regla del enunciado).

export interface User {
  id: number
  email: string
  displayName: string
}

export interface Team {
  code: string
  name: string
}

export interface Role {
  code: string
  name: string
}

export interface Clearance {
  granted: boolean
  grantedAt: string | null
}

/** Respuesta de GET /auth/me. OJO: campos de usuario estan en la RAIZ, no envueltos. */
export interface MeResponse {
  id: number
  email: string
  displayName: string
  team: Team
  role: Role
  /** La interfaz se decide por permissions, NO por role.code. */
  permissions: string[]
  clearance: Clearance
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  /** Segundos de vida del accessToken (ej. 180). Varia por workspace. */
  expiresIn: number
}

export interface AuthResponse extends TokenPair {
  user: User
  /** team solo viene en register. En login viene en la siguiente llamada a /auth/me. */
  team?: Team
}

/** Formato de TODOS los errores de la API. */
export interface ApiErrorBody {
  error: string
  message: string
  details: unknown
  timestamp: string
  path: string
  requestId: string
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody
  /** Segundos de la cabecera Retry-After (429 / 503), si vino. */
  readonly retryAfter: number | null

  constructor(status: number, body: ApiErrorBody, retryAfter: number | null = null) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }

  /** err.is('TOKEN_EXPIRED') es mas legible que err.body.error === '...' */
  is(code: string): boolean {
    return this.body.error === code
  }
}

// Detalles tipados del 400 VALIDATION_ERROR (hace falta para pintar errores
// por campo en login/register, como pide CP1).
export interface ValidationErrorDetails {
  fields: Record<string, string>
}

export function isValidationError(err: unknown): err is ApiError & { body: { details: ValidationErrorDetails } } {
  if (!(err instanceof ApiError) || !err.is('VALIDATION_ERROR')) return false
  const details = err.body.details
  return typeof details === 'object' && details !== null && 'fields' in details
}
