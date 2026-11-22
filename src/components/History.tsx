import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check, Pencil, Plus, Trash, X } from "@/components/icons"
import { groupLabel, type ChatSummary } from "@/lib/chats"
import { label } from "@/lib/api"
import { cn } from "@/lib/utils"

// The list of saved chats. On wide screens it sits beside the chat; on phones it
// slides over it and closes when you pick a chat.
export function History({
  open, chats, loading, error, current, busy, onClose, onNew, onOpen, onRename, onDelete,
}: {
  open: boolean
  chats: ChatSummary[]
  loading: boolean
  error: string
  current: string | null
  busy: boolean
  onClose: () => void
  onNew: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const groups: { label: string; items: ChatSummary[] }[] = []
  for (const c of chats) {
    const g = groupLabel(c.updatedAt)
    if (groups.at(-1)?.label !== g) groups.push({ label: g, items: [] })
    groups.at(-1)!.items.push(c)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !window.matchMedia("(min-width: 1024px)").matches) onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-ink/25 backdrop-blur-[2px] transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        aria-label="Saved chats"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[min(300px,86vw)] flex-col border-r border-line bg-surface transition-transform duration-200 ease-out",
          "lg:static lg:z-auto lg:w-[272px] lg:shrink-0 lg:bg-paper lg:transition-none",
          open ? "translate-x-0" : "-translate-x-full lg:hidden",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
          <span className="px-1.5 font-mono text-[11px] tracking-[0.08em] text-muted uppercase">Chats</span>
          <button
            type="button"
            onClick={onClose}
            title="Hide chats"
            aria-label="Hide chats"
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-ink/5 hover:text-ink"
          >
            <X width={17} height={17} />
          </button>
        </div>
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onNew}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[14px] font-medium transition-colors hover:border-line-strong disabled:opacity-50"
          >
            <Plus width={16} height={16} className="text-ember" /> New chat
          </button>
        </div>

        <nav className="flex-1 overflow-x-hidden overflow-y-auto px-2 pb-4">
          {loading && chats.length === 0 && <Note>Loading your chats…</Note>}
          {!loading && !error && chats.length === 0 && (
            <Note>No saved chats yet. Each chat is saved after every reply and shows up here on all your devices.</Note>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mt-3 first:mt-1">
              <p className="px-2.5 pb-1 font-mono text-[10.5px] tracking-[0.06em] text-muted/90 uppercase">{g.label}</p>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
                {g.items.map((c) => (
                  <Row
                    key={c.id}
                    chat={c}
                    active={c.id === current}
                    disabled={busy}
                    onOpen={() => onOpen(c.id)}
                    onRename={(t) => onRename(c.id, t)}
                    onDelete={() => onDelete(c.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {error && <p className="border-t border-line px-4 py-2.5 text-[13px] leading-snug text-danger">{error}</p>}
      </aside>
    </>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-2 text-[13.5px] leading-relaxed text-muted">{children}</p>
}

function Row({ chat, active, disabled, onOpen, onRename, onDelete }: {
  chat: ChatSummary
  active: boolean
  disabled: boolean
  onOpen: () => void
  onRename: (title: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [mode, setMode] = useState<"view" | "rename" | "confirm">("view")
  const [title, setTitle] = useState(chat.title)
  const [working, setWorking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === "rename") { inputRef.current?.focus(); inputRef.current?.select() }
  }, [mode])

  async function saveTitle() {
    const t = title.trim()
    if (!t || t === chat.title) { setTitle(chat.title); setMode("view"); return }
    setWorking(true)
    try { await onRename(t); setMode("view") } catch { setTitle(chat.title); setMode("view") } finally { setWorking(false) }
  }

  async function confirmDelete() {
    setWorking(true)
    try { await onDelete() } finally { setWorking(false); setMode("view") }
  }

  if (mode === "rename") {
    return (
      <li className="flex items-center gap-1 rounded-xl bg-ink/5 py-1 pr-1 pl-2.5">
        <input
          ref={inputRef}
          value={title}
          maxLength={120}
          disabled={working}
          aria-label="Chat name"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); saveTitle() }
            if (e.key === "Escape") { e.stopPropagation(); setTitle(chat.title); setMode("view") }
          }}
          onBlur={saveTitle}
          className="min-w-0 flex-1 bg-transparent py-1 text-[14px] outline-none"
        />
        <IconBtn label="Save name" onMouseDown={(e) => e.preventDefault()} onClick={saveTitle}><Check width={15} height={15} /></IconBtn>
      </li>
    )
  }

  if (mode === "confirm") {
    return (
      <li className="flex items-center gap-2 rounded-xl bg-danger/8 py-1.5 pr-1.5 pl-2.5 text-[13.5px]">
        <span className="min-w-0 flex-1 truncate">Delete “{chat.title}”?</span>
        <button
          type="button"
          disabled={working}
          onClick={confirmDelete}
          className="rounded-lg bg-danger px-2 py-1 text-[12.5px] font-medium text-white disabled:opacity-60 dark:text-[#1a0b05]"
        >
          Delete
        </button>
        <button type="button" onClick={() => setMode("view")} className="rounded-lg px-2 py-1 text-[12.5px] text-muted hover:text-ink">
          Cancel
        </button>
      </li>
    )
  }

  return (
    <li className={cn("group relative flex items-center rounded-xl transition-colors", active ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]")}>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled && !active}
        aria-current={active ? "true" : undefined}
        title={chat.title + (chat.provider ? " · " + label(chat.provider) + (chat.model ? " · " + chat.model : "") : "")}
        className="min-w-0 flex-1 truncate py-2 pr-1 pl-2.5 text-left text-[14px] leading-5 disabled:cursor-default"
      >
        {active && <span className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-ember align-middle" />}
        {chat.title}
      </button>
      <div className="flex shrink-0 items-center pr-1 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-focus-within:flex [@media(hover:hover)]:group-hover:flex">
        <IconBtn label="Rename chat" onClick={() => { setTitle(chat.title); setMode("rename") }}><Pencil width={14} height={14} /></IconBtn>
        <IconBtn label="Delete chat" disabled={disabled && active} onClick={() => setMode("confirm")}><Trash width={14} height={14} /></IconBtn>
      </div>
    </li>
  )
}

function IconBtn({ children, label, ...props }: { children: ReactNode; label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      {...props}
    >
      {children}
    </button>
  )
}
