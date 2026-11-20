import type { SVGProps } from "react"

const base = {
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const

export const ArrowUp = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
)
export const ArrowRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
)
export const Plus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M12 5v14" /><path d="M5 12h14" /></svg>
)
export const LogOut = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
)
export const Key = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8" /><path d="m17 6 3 3" /><path d="m14.5 8.5 2 2" /></svg>
)
