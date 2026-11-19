Third-party files served as-is (no CDN, so the page's CSP can stay `script-src 'self'`).

| File | Package | License |
|---|---|---|
| marked.umd.js | marked@18.1.2 (`lib/marked.umd.js`) | MIT |
| purify.min.js | dompurify@3.4.17 (`dist/purify.min.js`) | Apache-2.0 or MPL-2.0 |
| highlight.min.js, hljs-*.min.css | @highlightjs/cdn-assets@11.12.0 | BSD-3-Clause |

To update, `npm pack` the new version and copy the same files.
