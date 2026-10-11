import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Desde el primer render, no después de montar. Con `undefined` de partida,
  // el primer fotograma era el de escritorio, y un efecto del mismo ciclo que
  // preguntara «¿es móvil?» oía que no: así se abría sola la última
  // conversación de Directos en el teléfono (11-oct-2026).
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(() =>
    typeof window === "undefined" ? undefined : window.innerWidth < MOBILE_BREAKPOINT
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
