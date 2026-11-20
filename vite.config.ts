import { fileURLToPath, URL } from "node:url"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The React plugin injects its Fast Refresh preamble as an inline <script> in dev.
// The CSP in netlify.toml (script-src 'self') blocks inline scripts, and `netlify dev`
// applies that CSP, so drop the inline copy; src/main.tsx imports the preamble instead.
const noInlinePreamble = (): Plugin => ({
  name: "llmate:no-inline-react-preamble",
  apply: "serve",
  transformIndexHtml: {
    order: "post",
    handler: (html) => html.replace(/<script type="module">\s*import \{ injectIntoGlobalHook \}[\s\S]*?<\/script>\s*/, ""),
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), noInlinePreamble()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    // Keep every asset (fonts included) as a real file so the CSP never needs data: URLs.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 800,
  },
})
