# Lumon Hackathon — Frontend

Frontend en React + TypeScript + Vite para la hackathon Lumon Industries (Macrodata Refinement).

## Stack

- React 19 + TypeScript
- Vite
- React Router
- Tailwind CSS
- `fetch` nativo (sin librerías de estado de servidor)

## Contrato de la API

**Swagger manda sobre todo lo demás:** https://lumon-api.vercel.app/docs

## Correr en local

```bash
npm install
cp .env.example .env   # ya viene con los valores correctos, no hace falta tocarlo
npm run dev
```

## Variables de entorno

| Variable | Qué es |
|---|---|
| `VITE_API_BASE_URL` | Base de la API REST |
| `VITE_WS_BASE_URL` | Base del WebSocket del piso compartido |

En Vercel hay que cargarlas también en **Settings → Environment Variables** (el `.env` local no se sube).

## Header `X-Lumon-Build`

El backend exige este header en cada petición hecha desde un origen que no sea `localhost`. Se resuelve solo en el build (`vite.config.ts`): usa `VERCEL_GIT_COMMIT_SHA` si Vercel lo provee, si no corre `git rev-parse --short HEAD`, y si tampoco hay git usa `"dev"`. No hay que configurar nada a mano.

## Estructura

```
src/
  lib/
    apiClient.ts   # fetch con headers automáticos, refresh transparente, errores tipados
    session.ts     # guarda accessToken (memoria) y refreshToken (localStorage, rotación de un solo uso)
    types.ts       # tipos del contrato (User, TokenPair, ApiError, ...)
```

## Deploy

1. Importar el repo en Vercel.
2. Cargar las variables de entorno de arriba.
3. Verificar que `vercel.json` esté en la raíz (regla de reescritura para rutas directas de React Router).
4. Después del primer deploy: pedir el token de verificación de dominio, pegarlo en `public/.well-known/lumon-verification.txt`, y volver a desplegar.
