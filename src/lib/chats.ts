import { store } from "@/lib/api"

// Saved chats, stored server-side in Netlify Blobs under a hash of the token.

export type ChatSummary = {
  id: string
  title: string
  provider: string | null
  effort: string | null
  createdAt: string
  updatedAt: string
}
export type SavedMessage = {
  role: "user" | "assistant"
  content: string
  meta?: string
  error?: boolean
  notice?: boolean
}
export type SavedChat = ChatSummary & { messages: SavedMessage[] }

// Thrown on 401 so the caller can send the user back to the login screen.
export class Unauthorized extends Error {}

async function call<T>(action: string, body: object = {}): Promise<T> {
  const res = await fetch("/api/chats/" + action, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (store.token() || "") },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new Unauthorized("Your token was rejected. Log in again.")
  let data: { error?: string } & T
  try { data = await res.json() } catch { throw new Error("Request failed (" + res.status + ").") }
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ").")
  return data
}

export const chats = {
  list: () => call<{ chats: ChatSummary[] }>("list").then((d) => d.chats),
  get: (id: string) => call<{ chat: SavedChat }>("get", { id }).then((d) => d.chat),
  save: (c: { id: string; provider: string; effort: string; messages: SavedMessage[] }) =>
    call<{ chat: ChatSummary }>("save", c).then((d) => d.chat),
  rename: (id: string, title: string) => call<{ chat: ChatSummary }>("rename", { id, title }).then((d) => d.chat),
  remove: (id: string) => call<{ ok: true }>("delete", { id }),
}

export function newChatId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return "c_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

// "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then month names.
export function groupLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return "Previous 7 days"
  if (days < 30) return "Previous 30 days"
  return d.toLocaleDateString(undefined, { month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })
}
