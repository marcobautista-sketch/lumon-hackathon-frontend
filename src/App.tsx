import { Routes, Route } from 'react-router-dom'

function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-slate-950 text-slate-100">
      <h1 className="text-3xl font-semibold">Lumon</h1>
      <p className="text-slate-400">hola mundo</p>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  )
}
