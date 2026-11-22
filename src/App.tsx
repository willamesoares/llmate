import { useEffect, useState } from "react"
import { Login } from "@/components/Login"
import { Chat } from "@/components/Chat"
import { store, verify, type Model } from "@/lib/api"

type View = { name: "boot" } | { name: "login"; message?: string } | { name: "chat"; models: Model[] }

export default function App() {
  const [view, setView] = useState<View>({ name: "boot" })

  // Restore a saved token, checking it is still valid.
  useEffect(() => {
    const token = store.token()
    if (!token) return setView({ name: "login" })
    verify(token)
      .then(({ status, models }) => {
        if (status === 200) setView({ name: "chat", models })
        else { store.clearToken(); setView({ name: "login", message: "Your saved token is no longer valid." }) }
      })
      .catch(() => setView({ name: "chat", models: [] }))
  }, [])

  const logout = (message?: string) => {
    store.clearToken()
    setView({ name: "login", message })
  }

  if (view.name === "boot") return null
  if (view.name === "login") {
    return <Login message={view.message} onSuccess={(models) => setView({ name: "chat", models })} />
  }
  return <Chat models={view.models} onLogout={logout} />
}
