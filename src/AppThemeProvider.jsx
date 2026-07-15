import { useLayoutEffect, useMemo, useState } from 'react'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { createAdminTheme } from './theme.js'
import { ThemeModeContext } from './themeMode.jsx'

const THEME_STORAGE_KEY = 'stackwealth-theme'

function AppThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const savedMode = localStorage.getItem(THEME_STORAGE_KEY)
    return savedMode === 'dark' || savedMode === 'light' ? savedMode : 'light'
  })
  const theme = useMemo(() => createAdminTheme(mode), [mode])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  }, [mode])

  const themeMode = useMemo(() => ({
    mode,
    toggleMode: () => setMode((current) => current === 'light' ? 'dark' : 'light'),
  }), [mode])

  return (
    <ThemeModeContext.Provider value={themeMode}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  )
}

export default AppThemeProvider
