// Tipos compartidos del contrato de la API de Lumon.
// Fuente de verdad: https://lumon-api.vercel.app/docs (openapi.json)

export interface User {
  id: number
  email: string
  displayName: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  /** Segundos de vida del access token (ej. 180). Varia por workspace. */
  expiresIn: number
}

export interface Team {
  code: string
  name: string
}

export interface RegisterResponse extends TokenPair {
  user: User
  team: Team
}

export type LoginResponse = RegisterResponse

/** Cuerpo de TODOS los errores de la API (ver GlobalExceptionHandler del lado del backend). */
export interface ApiErrorBody {
  error: string
  message: string
  details: unknown
  timestamp: string
  path: string
  requestId: string
}

/** Error tipado que lanza apiFetch. error.error es el codigo estable (ej. "TOKEN_EXPIRED"). */
export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }

  /** Atajo para comparar contra el codigo estable, ej. err.is('TOKEN_EXPIRED'). */
  is(code: string): boolean {
    return this.body.error === code
  }
}
