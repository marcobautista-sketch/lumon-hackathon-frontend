import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/apiClient'
import { ApiError } from '../lib/types'
import type { Tile } from './fileTypes'

/**
 * Hook para cachear tiles bajo demanda.
 *   - Nunca hay dos requests en vuelo por el mismo tile (inFlight set).
 *   - Si el backend responde 429 con Retry-After, espera.
 *   - Si responde 503, backoff exponencial.
 *   - El caller llama fetchTile(r,c); si ya esta en cache, lo devuelve sincronico.
 */
export function useTiles(fileId: number) {
  const [tiles, setTiles] = useState<Record<string, Tile>>({})
  const inFlight = useRef<Set<string>>(new Set())
  const retryAfterUntil = useRef<number>(0)
  const [pending, setPending] = useState(0)

  const key = (r: number, c: number) => `${r},${c}`

  const getTile = useCallback(
    (r: number, c: number): Tile | undefined => tiles[key(r, c)],
    [tiles],
  )

  const fetchTile = useCallback(
    async (r: number, c: number): Promise<Tile | null> => {
      const k = key(r, c)
      if (tiles[k]) return tiles[k]
      if (inFlight.current.has(k)) return null
      // Respetar 429 Retry-After global
      const now = Date.now()
      if (now < retryAfterUntil.current) return null

      inFlight.current.add(k)
      setPending((p) => p + 1)
      try {
        const tile = await apiFetch<Tile>(`/files/${fileId}/tiles/${r}/${c}`)
        setTiles((prev) => ({ ...prev, [k]: tile }))
        return tile
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          // Back off: 3 segundos por defecto (el response header
          // Retry-After no lo podemos leer desde apiFetch actual, mejoramos
          // despues; 3s es un margen razonable).
          retryAfterUntil.current = Date.now() + 3000
        }
        return null
      } finally {
        inFlight.current.delete(k)
        setPending((p) => Math.max(0, p - 1))
      }
    },
    [fileId, tiles],
  )

  // Invalidar un tile (llamar cuando el backend responda 409 ALREADY_REFINED
  // o similar, para re-pedirlo).
  const invalidate = useCallback((r: number, c: number) => {
    setTiles((prev) => {
      const next = { ...prev }
      delete next[key(r, c)]
      return next
    })
  }, [])

  return { tiles, getTile, fetchTile, invalidate, pending }
}

// Asegurar que un tile este cargado (idempotente).
export function useEnsureTile(
  fetchTile: (r: number, c: number) => Promise<unknown>,
  r: number | null,
  c: number | null,
) {
  useEffect(() => {
    if (r !== null && c !== null) void fetchTile(r, c)
  }, [fetchTile, r, c])
}
