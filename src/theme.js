import { createTheme } from '@mui/material/styles'

const lightTokens = {
  blue: '#4184F3',
  blueHover: '#2E6FE0',
  blueSurface: '#ECF3FE',
  blueBg: '#F4F8FE',
  green: '#088F8F',
  red: '#FF5722',
  bold: '#333333',
  base: '#444444',
  caption: '#9B9B9B',
  placeholder: '#9B9B9B',
  // Subtle cool grey canvas (matches --ao-bg); paper/surface stays white so
  // cards lift off it.
  bg: '#ECEEF3',
  surface: '#FFFFFF',
  surface2: '#FAFAFB',
  hover: '#F8F8F8',
  border: '#DDDDDD',
  borderSoft: '#EEEEEE',
}

const darkTokens = {
  blue: '#4184F3',
  blueHover: '#64A0FF',
  blueSurface: '#1D3150',
  blueBg: '#17263D',
  green: '#4CAF50',
  red: '#FF5722',
  bold: '#D8D8D8',
  base: '#C4C4C4',
  caption: '#8E8E8E',
  placeholder: '#777777',
  bg: '#0F1113',
  surface: '#181818',
  surface2: '#202020',
  hover: '#292929',
  border: '#3A3A3A',
  borderSoft: '#2D2D2D',
}

export const createAdminTheme = (mode = 'light') => {
  const tokens = mode === 'dark' ? darkTokens : lightTokens

  return createTheme({
  palette: {
    mode,
    primary: { main: tokens.blue, dark: tokens.blueHover, light: tokens.blueSurface },
    success: { main: tokens.green },
    error: { main: tokens.red },
    background: { default: tokens.bg, paper: tokens.surface },
    text: { primary: tokens.bold, secondary: tokens.caption },
    divider: tokens.borderSoft,
  },
  typography: {
    fontFamily: 'Roboto, ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif',
    h4: { fontWeight: 700, letterSpacing: 0 },
    h5: { fontWeight: 700, letterSpacing: 0 },
    h6: { fontWeight: 700, letterSpacing: 0 },
    button: { fontWeight: 700, letterSpacing: 0, textTransform: 'none' },
  },
  shape: {
    borderRadius: 7,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: tokens.bg,
          color: tokens.base,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: tokens.surface,
          color: tokens.bold,
          borderBottom: `1px solid ${tokens.borderSoft}`,
          boxShadow: mode === 'dark' ? '0 1px 3px rgba(0, 0, 0, .28)' : '0 1px 3px rgba(43, 47, 63, .05)',
        },
      },
    },
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: '46px !important',
          paddingLeft: '16px !important',
          paddingRight: '16px !important',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          borderRadius: 8,
          // Matches --ao-lift: a soft, navy-tinted card lift so Paper surfaces
          // (page cards, tables, dialogs) float on the grey canvas.
          boxShadow: mode === 'dark'
            ? '0 1px 2px rgba(0, 0, 0, .3), 0 2px 8px rgba(0, 0, 0, .26)'
            : '0 1px 2px rgba(23, 43, 77, .05), 0 2px 8px rgba(23, 43, 77, .06)',
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          minHeight: 34,
          borderRadius: 6,
          padding: '0 14px',
          fontSize: '0.875rem',
        },
        containedPrimary: {
          backgroundColor: tokens.blue,
          color: '#fff',
          boxShadow: '0 1px 2px rgba(63, 91, 217, .35)',
          '&:hover': { backgroundColor: tokens.blueHover },
        },
        outlined: {
          borderColor: tokens.border,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          width: 32,
          height: 32,
          borderRadius: 6,
          color: tokens.caption,
          '&:hover': {
            backgroundColor: tokens.surface2,
            color: tokens.base,
          },
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiFormControl: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          minHeight: 36,
          borderRadius: 7,
          fontSize: '0.875rem',
          backgroundColor: tokens.surface,
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: mode === 'dark' ? '#505866' : '#cfd3da' },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: tokens.blue,
            boxShadow: `0 0 0 3px ${tokens.blueSurface}`,
          },
        },
        input: {
          padding: '8px 14px',
        },
        inputSizeSmall: {
          padding: '7px 12px',
        },
        notchedOutline: {
          borderColor: tokens.border,
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          minHeight: 38,
          fontSize: '0.875rem',
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: tokens.caption,
          fontWeight: 600,
          fontSize: '0.875rem',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: `1px solid ${tokens.borderSoft}`,
          color: tokens.base,
          fontSize: '0.875rem',
          padding: '9px 14px',
        },
        sizeSmall: {
          padding: '8px 14px',
        },
        head: {
          backgroundColor: tokens.surface2,
          color: tokens.caption,
          fontSize: '0.75rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.04em',
          padding: '10px 14px',
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover td': { backgroundColor: tokens.hover },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 8,
          border: `1px solid ${tokens.borderSoft}`,
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          color: tokens.bold,
          fontWeight: 700,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          border: `1px solid ${tokens.borderSoft}`,
          boxShadow: mode === 'dark' ? '0 8px 30px rgba(0, 0, 0, .4)' : '0 4px 24px rgba(0, 0, 0, .12)',
        },
      },
    },
  },
  })
}
