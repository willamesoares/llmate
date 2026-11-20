import { marked } from "marked"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/common"

// Markdown -> sanitized HTML. Both your messages and the model's go through
// this, so nothing in a message can run script or restyle the page.
const LANG_RE = /^language-[\w+#.-]+$/

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noopener noreferrer")
  }
  if (node.hasAttribute("class") && !(node.tagName === "CODE" && LANG_RE.test(node.getAttribute("class") || ""))) {
    node.removeAttribute("class")
  }
})

function sanitize(text: string): string {
  const raw = marked.parse(text, { gfm: true, breaks: true, async: false })
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select", "iframe", "svg", "math"],
    FORBID_ATTR: ["style", "id"],
  })
}

// Highlights code blocks and adds a Copy button to each (done once a reply is complete).
function decorateCode(root: HTMLElement) {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    try {
      const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1]
      const res = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code.textContent || "", { language: lang, ignoreIllegals: true })
        : hljs.highlightAuto(code.textContent || "")
      code.innerHTML = res.value // hljs escapes the code text; it only adds <span class="hljs-*">
      code.classList.add("hljs")
    } catch {
      /* leave it plain */
    }
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "copy"
    btn.textContent = "Copy"
    code.parentElement?.append(btn)
  }
}

// Puts a blinking caret at the end of the last text block while a reply streams.
function addCaret(root: HTMLElement) {
  let t: Element = root
  while (t.lastElementChild && !["PRE", "TABLE", "UL", "OL"].includes(t.lastElementChild.tagName)) t = t.lastElementChild
  const last = t.lastElementChild
  if (last && (last.tagName === "UL" || last.tagName === "OL")) t = last.lastElementChild || t
  const c = document.createElement("span")
  c.className = "caret"
  t.append(c)
}

export function renderMarkdown(text: string, { streaming = false } = {}): string {
  const tmp = document.createElement("div")
  tmp.innerHTML = sanitize(text)
  if (streaming) addCaret(tmp)
  else decorateCode(tmp)
  return tmp.innerHTML
}
