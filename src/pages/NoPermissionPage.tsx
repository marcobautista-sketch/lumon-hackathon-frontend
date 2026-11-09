import { Link } from 'react-router-dom'

export function NoPermissionPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
      <h1 className="text-2xl font-semibold">Sin permiso</h1>
      <p className="text-slate-400">Su rol actual no incluye este permiso.</p>
      <Link to="/" className="mt-4 underline">Volver al inicio</Link>
    </main>
  )
}
