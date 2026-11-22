import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react"
import { motion } from "motion/react"
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { BlurFade } from "@/components/ui/blur-fade"
import { BorderBeam } from "@/components/ui/border-beam"
import { History } from "@/components/History"
import { ArrowUp, Check, ChevronDown, Gauge, LogOut, PanelLeft, Plus } from "@/components/icons"
import { effortLabel, effortOptions, findModel, label, modelKey, quotaMessage, readStream, store, type Model } from "@/lib/api"
import { chats, newChatId, Unauthorized, type ChatSummary, type SavedMessage } from "@/lib/chats"
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

const isWide = () => window.matchMedia("(min-width: 1024px)").matches

// What gets stored for a message: no ids, nothing still streaming.
const toSaved = (list: Msg[]): SavedMessage[] =>
  list.filter((m) => !m.pending).map(({ role, content, meta, error, notice }) => ({
    role, content, ...(meta && { meta }), ...(error && { error }), ...(notice && { notice }),
  }))

export function Chat({ models, onLogout }: { models: Model[]; onLogout: (message?: string) => void }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))], [models])
  const [model, setModel] = useState<Model | undefined>(() => {
    const saved = store.model()
    return models.find((m) => modelKey(m) === saved) || models[0]
  })
  const provider = model?.provider || ""
  const [effort, setEffort] = useState(() => store.effort(model))
  const [input, setInput] = useState("")
  const busy = messages.some((m) => m.pending)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const jumpToEnd = useRef(false)

  // Saved chats. chatId is null until the first message of a new chat is sent.
  const [chatId, setChatId] = useState<string | null>(null)
  const [saved, setSaved] = useState<ChatSummary[]>([])
  const [savedLoading, setSavedLoading] = useState(true)
  const [savedError, setSavedError] = useState("")
  const [navOpen, setNavOpen] = useState(isWide)
  const saveNext = useRef<string | null>(null)

  const storageFailed = useCallback((err: unknown, what: string) => {
    if (err instanceof Unauthorized) return onLogout(err.message)
    setSavedError(what + ": " + (err instanceof Error ? err.message : String(err)))
  }, [onLogout])

  useEffect(() => {
    chats.list()
      .then((list) => { setSaved(list); setSavedError("") })
      .catch((err) => storageFailed(err, "Couldn't load your chats"))
      .finally(() => setSavedLoading(false))
  }, [storageFailed])

  // Save once a reply has finished (or failed), with the chat's model and effort.
  useEffect(() => {
    const id = saveNext.current
    if (busy || !id) return
    saveNext.current = null
    chats.save({ id, provider, model: model?.id || "", effort, messages: toSaved(messages) })
      .then((c) => { setSaved((l) => [c, ...l.filter((x) => x.id !== c.id)]); setSavedError("") })
      .catch((err) => storageFailed(err, "Couldn't save this chat"))
  }, [busy, messages, provider, model, effort, storageFailed])

  const closeNavOnPhone = () => { if (!isWide()) setNavOpen(false) }

  async function openChat(id: string) {
    if (busy) return
    closeNavOnPhone()
    if (id === chatId) return
    try {
      const c = await chats.get(id)
      setMessages(c.messages.map((m) => ({ ...m, id: nextId++ })))
      setChatId(c.id)
      // Pick up where the chat left off, if that model is still offered. Chats
      // saved before the model picker only know their provider: use its default.
      const m = findModel(models, c.provider, c.model) || (!c.model ? models.find((x) => x.provider === c.provider) : undefined)
      if (m) {
        setModel(m)
        setEffort(c.effort && m.effort?.levels.includes(c.effort) ? c.effort : store.effort(m))
      }
      setSavedError("")
      inputRef.current?.focus()
    } catch (err) {
      storageFailed(err, "Couldn't open that chat")
    }
  }

  async function renameChat(id: string, title: string) {
    try {
      const c = await chats.rename(id, title)
      setSaved((l) => l.map((x) => (x.id === id ? c : x)))
      setSavedError("")
    } catch (err) {
      storageFailed(err, "Couldn't rename that chat")
      throw err
    }
  }

  async function deleteChat(id: string) {
    try {
      await chats.remove(id)
      setSaved((l) => l.filter((x) => x.id !== id))
      setSavedError("")
      if (id === chatId) newChat()
    } catch (err) {
      storageFailed(err, "Couldn't delete that chat")
    }
  }

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

  function pickModel(m: Model) {
    setModel(m)
    store.setModel(m)
    setEffort(store.effort(m))
  }

  function pickEffort(v: string) {
    setEffort(v)
    if (model) store.setEffort(model, v)
  }

  function update(id: number, patch: Partial<Msg> | ((m: Msg) => Partial<Msg>)) {
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)))
  }

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const text = input.trim()
    const token = store.token()
    if (!text || !token || busy) return
    if (!model) {
      setMessages((l) => [...l, { id: nextId++, role: "assistant", content: "No provider is configured on the server.", error: true }])
      return
    }
    const turns = [...messages, { role: "user" as const, content: text }]
      .filter((m) => !("error" in m && m.error))
      .map(({ role, content }) => ({ role, content }))
    const id = nextId++
    const cid = chatId ?? newChatId()
    if (!chatId) setChatId(cid)
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
        body: JSON.stringify({ provider, model: model.id, messages: turns, ...(effort && { effort }) }),
      })
      if (res.status === 401) return onLogout("Your token was rejected. Log in again.")
      const type = res.headers.get("content-type") || ""
      if (res.ok && type.includes("ndjson")) {
        let failed = ""
        await readStream(res, (ev) => {
          if (ev.type === "meta") {
            meta = label(ev.provider) + " · " + (findModel(models, ev.provider, ev.model)?.label || ev.model)
            if (ev.effort) meta += " · " + effortLabel(ev.effort).toLowerCase() + " effort"
          }
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
      saveNext.current = cid
      update(id, { pending: false })
      inputRef.current?.focus()
    }
  }

  function newChat() {
    if (busy) return
    setMessages([])
    setChatId(null)
    closeNavOnPhone()
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
    <div className="flex h-full">
    <History
      open={navOpen}
      chats={saved}
      loading={savedLoading}
      error={savedError}
      current={chatId}
      busy={busy}
      onClose={() => setNavOpen(false)}
      onNew={newChat}
      onOpen={openChat}
      onRename={renameChat}
      onDelete={deleteChat}
    />
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="relative z-20 border-b border-line bg-paper/85 backdrop-blur-md">
        <div className="relative mx-auto flex max-w-[760px] items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setNavOpen((o) => !o)}
              title={navOpen ? "Hide chats" : "Show chats"}
              aria-label={navOpen ? "Hide chats" : "Show chats"}
              aria-expanded={navOpen}
              className="-ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <PanelLeft />
            </button>
            <span className="shrink-0 font-display text-[20px] leading-none max-[419px]:hidden sm:text-[22px]">
              LLM<span className="text-ember">ate</span>
            </span>
            <ModelPicker models={models} value={model} onChange={pickModel} disabled={busy} />
            <EffortPicker model={model} value={effort} onChange={pickEffort} disabled={busy} />
          </div>
          <div className="flex shrink-0 items-center sm:gap-1">
            <HeaderButton onClick={newChat} disabled={busy} label="New chat"><Plus /></HeaderButton>
            <HeaderButton onClick={() => onLogout()} label="Log out"><LogOut /></HeaderButton>
          </div>
        </div>
      </header>

      <div ref={logRef} onClick={onLogClick} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-4 pt-8 pb-6 sm:px-5">
          {messages.length === 0 ? (
            <EmptyState model={model} />
          ) : (
            <div className="grid gap-7">
              {messages.map((m) => (
                <BlurFade key={m.id} direction="up" offset={8} duration={0.35} blur="4px">
                  <Message m={m} name={model?.label || label(provider)} />
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
            placeholder={"Message " + (model?.label || "the model")}
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
    </div>
  )
}

function HeaderButton({ children, label, ...props }: { children: React.ReactNode; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm sm:px-2.5 text-muted transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
      {...props}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

// The model for the next message, grouped by provider. You can switch at any
// point in a chat; the whole conversation goes to whichever model is selected.
// A native select keeps the long list easy to use on phones. Locked while a reply streams.
function ModelPicker({ models, value, onChange, disabled }: {
  models: Model[]; value?: Model; onChange: (m: Model) => void; disabled: boolean
}) {
  if (models.length < 2) {
    return value ? (
      <span className="truncate rounded-full border border-line px-3 py-1 font-mono text-[12px] text-muted">{value.label}</span>
    ) : null
  }
  const groups: { provider: string; items: Model[] }[] = []
  for (const m of models) {
    if (groups.at(-1)?.provider !== m.provider) groups.push({ provider: m.provider, items: [] })
    groups.at(-1)!.items.push(m)
  }
  // The visible pill shows only the current model, so it stays as narrow as its
  // name; the real (transparent) select sits on top and opens the native list.
  return (
    <label
      className={cn(
        "relative inline-flex min-w-0 items-center rounded-full border border-line bg-surface py-1 pr-7 pl-3 text-[13px] font-medium text-ink transition-colors focus-within:border-line-strong",
        disabled ? "opacity-60" : "hover:border-line-strong",
      )}
      title={value ? label(value.provider) + " · " + value.label + ". You can switch at any time." : "Model"}
    >
      <span className="sr-only">Model</span>
      <span aria-hidden className="truncate">{value?.label || "Pick a model"}</span>
      <ChevronDown width={14} height={14} className="pointer-events-none absolute right-2.5 text-muted" />
      <select
        value={value ? modelKey(value) : ""}
        disabled={disabled}
        onChange={(e) => {
          const m = models.find((x) => modelKey(x) === e.target.value)
          if (m) onChange(m)
        }}
        className={cn("absolute inset-0 size-full appearance-none opacity-0 [color-scheme:light_dark]", disabled ? "cursor-default" : "cursor-pointer")}
      >
        {groups.map((g) => (
          <optgroup key={g.provider} label={label(g.provider)}>
            {g.items.map((m) => (
              <option key={modelKey(m)} value={modelKey(m)}>{m.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

// Effort for the selected model, if it takes one, with a short note on each level.
// The menu is placed against the header row so it stays on screen on phones.
function EffortPicker({ model, value, onChange, disabled }: {
  model?: Model; value: string; onChange: (v: string) => void; disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [left, setLeft] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const options = effortOptions(model)

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return
    const row = menuRef.current.offsetParent as HTMLElement | null
    if (!row) return
    const b = btnRef.current.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    const w = menuRef.current.offsetWidth
    setLeft(Math.max(12, Math.min(b.left - r.left, r.width - w - 12)))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btnRef.current?.focus() }
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey) }
  }, [open])

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  if (!model?.effort || options.length === 0) return null
  const current = options.find((o) => o.value === value) || options[0]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        title={"Effort: " + current.label + ". " + current.hint}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface py-1 pr-2 pl-2 text-[13px] font-medium text-ink transition-colors hover:border-line-strong",
          open && "border-line-strong",
          disabled && "cursor-default opacity-60 hover:border-line",
        )}
      >
        <Gauge width={15} height={15} className="text-ember" />
        <span className="sr-only sm:not-sr-only">Effort:&nbsp;</span>
        <span>{current.label}</span>
        <ChevronDown width={14} height={14} className={cn("hidden text-muted transition-transform sm:block", open && "rotate-180")} />
      </button>
      {open && (
        <motion.div
          ref={menuRef}
          id={id}
          role="radiogroup"
          aria-label={model.label + " effort"}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.14 }}
          style={{ left }}
          className="absolute top-full mt-1.5 w-[min(320px,calc(100%-24px))] rounded-2xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_-18px_rgb(28_26_23/0.45)]"
        >
          <p className="px-2.5 pt-1.5 pb-1 font-mono text-[11px] tracking-wide text-muted">
            {"How long " + model.label + " thinks before answering"}
          </p>
          {options.map((o) => {
            const on = o.value === current.value
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => { onChange(o.value); setOpen(false); btnRef.current?.focus() }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-ink/5",
                  on && "bg-ink/5",
                )}
              >
                <span className={cn("mt-1 grid size-4 shrink-0 place-items-center", on ? "text-ember" : "text-transparent")}>
                  <Check width={15} height={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium leading-5">
                    {o.label}
                    {o.value === model.effort?.default && <span className="ml-1.5 font-mono text-[10.5px] font-normal tracking-wide text-muted">default</span>}
                  </span>
                  <span className="block text-[13px] leading-[1.45] text-muted">{o.hint}</span>
                </span>
              </button>
            )
          })}
        </motion.div>
      )}
    </>
  )
}

function EmptyState({ model }: { model?: Model }) {
  return (
    <BlurFade direction="up" offset={10} duration={0.5} className="mt-[16vh] text-center">
      <h2 className="font-display text-[clamp(30px,6vw,44px)] leading-[1.1]">
        What's on <span className="text-ember">your</span> mind?
      </h2>
      <p className="mt-3 text-[15px] text-muted">
        {model ? <>Replies come from {model.label} on {label(model.provider)}. Switch models any time, even mid-chat.</> : "No provider is configured on the server."}
      </p>
    </BlurFade>
  )
}

function Message({ m, name }: { m: Msg; name: string }) {
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
          {name} is thinking…
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
