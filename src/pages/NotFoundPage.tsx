import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
      <h1 className="text-3xl font-semibold">404</h1>
      <p className="text-slate-400">Esta puerta no da a ningun lado.</p>
      <Link to="/" className="mt-4 underline">Volver</Link>
    </main>
  )
}
