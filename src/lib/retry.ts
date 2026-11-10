import { ApiError } from './types'

/** Espera `ms` milisegundos; se corta (rechaza con AbortError) si se aborta la señal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

interface RetryOptions {
  signal?: AbortSignal
  /** Intentos totales (incluido el primero). */
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Reintenta `fn` ante 503 / 429 (modo caos) y cortes de red.
 * - Si el servidor manda Retry-After, se respeta tal cual (segundos).
 * - Si no, espera creciente (exponencial con jitter).
 * Cualquier otro error (4xx de negocio) se propaga sin reintentar.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, attempts = 5, baseDelayMs = 500, maxDelayMs = 8000 } = options
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err
      const retriable =
        err instanceof ApiError ? err.status === 503 || err.status === 429 : err instanceof TypeError // TypeError = fallo de red en fetch
      if (!retriable || attempt === attempts - 1) throw err
      lastError = err
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + Math.random() / 2)
      const delay = err instanceof ApiError && err.retryAfter !== null ? err.retryAfter * 1000 : backoff
      await sleep(delay, signal)
    }
  }
  throw lastError
}

/** Errores transitorios que vale la pena reintentar: 503, 429 y fallos de red. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 503 || err.status === 429
  return err instanceof TypeError
}

/** Espera antes del intento `attempt`: Retry-After si vino, si no exponencial con jitter (hasta 8 s). */
export function backoffDelay(attempt: number, err: unknown): number {
  if (err instanceof ApiError && err.retryAfter) return err.retryAfter * 1000
  const base = Math.min(8000, 500 * 2 ** attempt)
  return base / 2 + Math.random() * (base / 2)
}

/** Mensaje legible para mostrar en la UI. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.body.message || `Error ${err.status}`
  if (err instanceof TypeError) return 'No se pudo conectar con Lumon. Revisa tu conexión.'
  return 'Ocurrió un error inesperado.'
}
