import { createContext, useContext } from 'react'

export const ThemeModeContext = createContext({
  mode: 'light',
  toggleMode: () => {},
})

export function useThemeMode() {
  return useContext(ThemeModeContext)
}
