import { useState, type FormEvent } from "react"
import { BlurFade } from "@/components/ui/blur-fade"
import { DotPattern } from "@/components/ui/dot-pattern"
import { MagicCard } from "@/components/ui/magic-card"
import { ArrowRight, Key } from "@/components/icons"
import { store, verify } from "@/lib/api"

export function Login({ message, onSuccess }: { message?: string; onSuccess: (providers: string[]) => void }) {
  const [token, setToken] = useState("")
  const [error, setError] = useState(message || "")
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = token.trim()
    if (!t) return
    setBusy(true)
    setError("")
    try {
      const { status, providers } = await verify(t)
      if (status === 200) { store.setToken(t); onSuccess(providers) }
      else setError(status === 401 ? "That token is not valid." : "Server error (" + status + ").")
    } catch {
      setError("Could not reach the server.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="relative grid min-h-full place-items-center overflow-hidden px-4 py-10">
      {/* Sized box so the dot grid stays small (one SVG circle per dot). */}
      <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 size-[880px] -translate-x-1/2 -translate-y-1/2">
        <DotPattern
          width={22}
          height={22}
          cr={1}
          className="text-line-strong [mask-image:radial-gradient(420px_circle_at_center,white,transparent)]"
        />
      </div>
      <BlurFade direction="up" offset={10} duration={0.5} className="relative w-full max-w-[380px]">
        <MagicCard
          className="rounded-2xl shadow-[0_1px_0_0_var(--line),0_24px_48px_-24px_rgb(28_26_23/0.25)]"
          gradientSize={260}
          gradientColor="color-mix(in srgb, var(--ember) 7%, transparent)"
          gradientOpacity={1}
          gradientFrom="var(--ember)"
          gradientTo="var(--amber)"
        >
          <form onSubmit={submit} autoComplete="off" className="grid gap-5 p-7 sm:p-8">
            <div className="grid gap-1.5">
              <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
                Private · token only
              </span>
              <h1 className="font-serif text-[44px] leading-none tracking-tight">
                LLM<em className="text-ember">ate</em>
              </h1>
              <p className="text-[15px] text-muted">Paste your access token to start chatting.</p>
            </div>

            <label className="group relative block">
              <span className="sr-only">Access token</span>
              <Key className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted transition-colors group-focus-within:text-ember" />
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Access token"
                required
                autoFocus
                className="w-full rounded-xl border border-line bg-paper py-3 pr-3.5 pl-11 font-mono text-[14px] outline-none transition-[border-color,box-shadow] placeholder:font-sans placeholder:text-muted/80 focus:border-ember focus:ring-4 focus:ring-ember/15"
              />
            </label>

            {error && <p role="alert" className="-mt-2 text-sm text-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 font-medium text-paper transition-[transform,opacity] hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
            >
              {busy ? "Checking…" : "Unlock"}
              <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </button>
          </form>
        </MagicCard>
      </BlurFade>
    </main>
  )
}
