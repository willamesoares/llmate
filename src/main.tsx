// Loads the React Fast Refresh preamble as a module instead of an inline script,
// so `netlify dev` works under the strict CSP in netlify.toml. No-op in builds.
import "@vitejs/plugin-react/preamble"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
