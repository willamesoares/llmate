import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react"
import { motion } from "motion/react"
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { BlurFade } from "@/components/ui/blur-fade"
import { BorderBeam } from "@/components/ui/border-beam"
import { ArrowUp, LogOut, Plus } from "@/components/icons"
import { label, quotaMessage, readStream, store } from "@/lib/api"
import { renderMarkdown } from "@/lib/markdown"
import { cn } from "@/lib/utils"

type Msg = {
  id: number
  role: "user" | "assistant"
  content: string
  pending?: boolean
  error?: boolean
  notice?: boolean
  meta?: string
}

let nextId = 1

export function Chat({ providers, onLogout }: { providers: string[]; onLogout: (message?: string) => void }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [provider, setProvider] = useState(() => {
    const saved = store.provider()
    return saved && providers.includes(saved) ? saved : providers[0] || ""
  })
  const [input, setInput] = useState("")
  const busy = messages.some((m) => m.pending)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const jumpToEnd = useRef(false)

  // The log never scrolls on its own while a reply streams; it only jumps to the
  // end right after you send a message.
  useLayoutEffect(() => {
    if (jumpToEnd.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
      jumpToEnd.current = false
    }
  }, [messages])

  useEffect(() => { inputRef.current?.focus() }, [])

  // Grow the textarea with its content, up to a limit.
  useLayoutEffect(() => {
    const t = inputRef.current
    if (!t) return
    t.style.height = "auto"
    t.style.height = Math.min(t.scrollHeight, 200) + "px"
  }, [input])

  function pickProvider(p: string) {
    setProvider(p)
    store.setProvider(p)
  }

  function update(id: number, patch: Partial<Msg> | ((m: Msg) => Partial<Msg>)) {
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)))
  }

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const text = input.trim()
    const token = store.token()
    if (!text || !token || busy) return
    if (!provider) {
      setMessages((l) => [...l, { id: nextId++, role: "assistant", content: "No provider is configured on the server.", error: true }])
      return
    }
    const turns = [...messages, { role: "user" as const, content: text }]
      .filter((m) => !("error" in m && m.error))
      .map(({ role, content }) => ({ role, content }))
    const id = nextId++
    jumpToEnd.current = true
    setInput("")
    setMessages((l) => [
      ...l,
      { id: nextId++, role: "user", content: text },
      { id, role: "assistant", content: "", pending: true },
    ])

    // Deltas arrive fast; collect them and paint once per frame.
    let text_ = ""
    let meta = ""
    let frame = 0
    const flush = () => { frame = 0; update(id, { content: text_, meta }) }
    let got = false

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ provider, messages: turns }),
      })
      if (res.status === 401) return onLogout("Your token was rejected. Log in again.")
      const type = res.headers.get("content-type") || ""
      if (res.ok && type.includes("ndjson")) {
        let failed = ""
        await readStream(res, (ev) => {
          if (ev.type === "meta") meta = label(ev.provider) + " · " + ev.model
          else if (ev.type === "delta") {
            got = true
            text_ += ev.text
            if (!frame) frame = requestAnimationFrame(flush)
          } else if (ev.type === "error") failed = ev.error
        })
        cancelAnimationFrame(frame)
        if (failed && !text_) update(id, { content: failed, error: true, pending: false })
        else update(id, { content: text_, meta: failed ? (meta ? meta + " · " : "") + "stopped early: " + failed : meta, pending: false })
      } else {
        let data: { error?: string; provider?: string; quota?: { kind?: string; retryAfterSeconds?: number } } = {}
        try { data = await res.json() } catch { /* not JSON */ }
        const notice = res.status === 429 ? quotaMessage(data, providers) : ""
        update(id, { content: notice || data.error || "Request failed (" + res.status + ").", error: true, notice: !!notice, pending: false })
      }
    } catch {
      cancelAnimationFrame(frame)
      if (got) update(id, { content: text_, meta: (meta || "") + " · connection lost", pending: false })
      else update(id, { content: "Could not reach the server.", error: true, pending: false })
    } finally {
      update(id, { pending: false })
      inputRef.current?.focus()
    }
  }

  function newChat() {
    if (busy) return
    setMessages([])
    inputRef.current?.focus()
  }

  // Copy buttons live inside the rendered Markdown, so one listener handles them all.
  async function onLogClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".copy")
    if (!btn) return
    const code = btn.parentElement?.querySelector("code")
    try {
      await navigator.clipboard.writeText(code?.textContent || "")
      btn.textContent = "Copied"
    } catch {
      btn.textContent = "Failed"
    }
    setTimeout(() => { btn.textContent = "Copy" }, 1500)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="z-10 border-b border-line bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <span className="font-display text-[22px] leading-none">
              LLM<span className="text-ember">ate</span>
            </span>
            <ProviderSwitch providers={providers} value={provider} onChange={pickProvider} disabled={busy} />
          </div>
          <div className="flex items-center gap-1">
            <HeaderButton onClick={newChat} disabled={busy} label="New chat"><Plus /></HeaderButton>
            <HeaderButton onClick={() => onLogout()} label="Log out"><LogOut /></HeaderButton>
          </div>
        </div>
      </header>

      <div ref={logRef} onClick={onLogClick} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-4 pt-8 pb-6 sm:px-5">
          {messages.length === 0 ? (
            <EmptyState provider={provider} />
          ) : (
            <div className="grid gap-7">
              {messages.map((m) => (
                <BlurFade key={m.id} direction="up" offset={8} duration={0.35} blur="4px">
                  <Message m={m} provider={provider} />
                </BlurFade>
              ))}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={send} className="px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-4">
        <div className="relative mx-auto flex max-w-[760px] items-end gap-2 rounded-2xl border border-line bg-surface p-2 pl-4 shadow-[0_12px_32px_-20px_rgb(28_26_23/0.35)] transition-colors focus-within:border-line-strong">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
            }}
            placeholder={"Message " + label(provider)}
            title="Enter to send, Shift+Enter for a new line"
            className="max-h-[200px] min-h-6 flex-1 resize-none self-center bg-transparent py-1.5 leading-6 outline-none placeholder:text-muted/80"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-ember text-white transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:bg-line-strong disabled:text-muted dark:text-[#1a0b05] disabled:dark:text-muted"
          >
            <ArrowUp />
          </button>
          {busy && (
            <BorderBeam size={90} duration={2.8} colorFrom="var(--ember)" colorTo="var(--amber)" borderWidth={1.5} />
          )}
        </div>
        <p className="mx-auto mt-2 hidden max-w-[760px] text-center font-mono text-[11px] tracking-wide text-muted/80 sm:block">
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </div>
  )
}

function HeaderButton({ children, label, ...props }: { children: React.ReactNode; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
      {...props}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

// Segmented control for the provider. You can switch at any point in a chat;
// the whole conversation goes to whichever one is selected. Locked while a reply streams.
function ProviderSwitch({ providers, value, onChange, disabled }: {
  providers: string[]; value: string; onChange: (p: string) => void; disabled: boolean
}) {
  if (providers.length < 2) {
    return providers[0] ? (
      <span className="rounded-full border border-line px-3 py-1 font-mono text-[12px] text-muted">{label(providers[0])}</span>
    ) : null
  }
  return (
    <div
      role="radiogroup"
      aria-label="Provider"
      title="Provider for the next message. You can switch at any time."
      className={cn("flex rounded-full border border-line bg-surface p-0.5", disabled && "opacity-60")}
    >
      {providers.map((p) => {
        const on = p === value
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(p)}
            className={cn(
              "relative rounded-full px-3 py-1 text-[13px] font-medium transition-colors",
              on ? "text-paper" : "text-muted hover:text-ink",
              disabled && "cursor-default",
            )}
          >
            {on && (
              <motion.span
                layoutId="provider-pill"
                className="absolute inset-0 rounded-full bg-ink"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{label(p)}</span>
          </button>
        )
      })}
    </div>
  )
}

function EmptyState({ provider }: { provider: string }) {
  return (
    <BlurFade direction="up" offset={10} duration={0.5} className="mt-[16vh] text-center">
      <h2 className="font-display text-[clamp(30px,6vw,44px)] leading-[1.1]">
        What's on <span className="text-ember">your</span> mind?
      </h2>
      <p className="mt-3 text-[15px] text-muted">
        {provider ? <>Replies come from {label(provider)}. Switch providers any time, even mid-chat.</> : "No provider is configured on the server."}
      </p>
    </BlurFade>
  )
}

function Message({ m, provider }: { m: Msg; provider: string }) {
  const html = useMemo(
    () => (m.error || (m.pending && !m.content) ? "" : renderMarkdown(m.content, { streaming: m.pending })),
    [m.content, m.pending, m.error],
  )

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="md user-md max-w-[85%] rounded-2xl rounded-br-md bg-user px-4 py-2.5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }

  if (m.pending && !m.content) {
    return (
      <div className="flex items-center gap-2.5 text-[15px]" aria-live="polite">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-ember opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-ember" />
        </span>
        <AnimatedShinyText className="mx-0 text-muted" shimmerWidth={60}>
          {label(provider)} is thinking…
        </AnimatedShinyText>
      </div>
    )
  }

  if (m.notice) {
    return (
      <div className="rounded-2xl border border-line bg-surface px-4 py-3 text-[15px]">{m.content}</div>
    )
  }

  if (m.error) {
    return (
      <div className="border-l-2 border-danger pl-3 text-[15px] text-danger">{m.content}</div>
    )
  }

  return (
    <div>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      {m.meta && !m.pending && (
        <div className="mt-2.5 font-mono text-[11px] tracking-wide text-muted/90">{m.meta}</div>
      )}
    </div>
  )
}
