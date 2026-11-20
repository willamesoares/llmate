import { useEffect, useState } from "react"
import { Login } from "@/components/Login"
import { Chat } from "@/components/Chat"
import { store, verify } from "@/lib/api"

type View = { name: "boot" } | { name: "login"; message?: string } | { name: "chat"; providers: string[] }

export default function App() {
  const [view, setView] = useState<View>({ name: "boot" })

  // Restore a saved token, checking it is still valid.
  useEffect(() => {
    const token = store.token()
    if (!token) return setView({ name: "login" })
    verify(token)
      .then(({ status, providers }) => {
        if (status === 200) setView({ name: "chat", providers })
        else { store.clearToken(); setView({ name: "login", message: "Your saved token is no longer valid." }) }
      })
      .catch(() => setView({ name: "chat", providers: [] }))
  }, [])

  const logout = (message?: string) => {
    store.clearToken()
    setView({ name: "login", message })
  }

  if (view.name === "boot") return null
  if (view.name === "login") {
    return <Login message={view.message} onSuccess={(providers) => setView({ name: "chat", providers })} />
  }
  return <Chat providers={view.providers} onLogout={logout} />
}
