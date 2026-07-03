import { createTheme } from '@mui/material/styles'

const tokens = {
  blue: '#3F5BD9',
  blueHover: '#354CB5',
  blueSurface: '#E8ECFC',
  blueBg: '#F1F4FD',
  green: '#008F75',
  red: '#D64D4D',
  bold: '#253040',
  base: '#425061',
  caption: '#717A89',
  placeholder: '#959FB0',
  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surface2: '#F1F4FD',
  hover: '#F5F7FA',
  border: '#DDDFE4',
  borderSoft: '#EAEBF1',
}

export const adminTheme = createTheme({
  palette: {
    mode: 'light',
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
    borderRadius: 8,
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
          boxShadow: '0 1px 3px rgba(43, 47, 63, .04)',
        },
      },
    },
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: '52px !important',
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
          boxShadow: '0 1px 2px rgba(43, 47, 63, .06), 0 4px 16px rgba(43, 47, 63, .06)',
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
          borderRadius: 7,
          padding: '0 14px',
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
          width: 30,
          height: 30,
          borderRadius: 7,
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
          minHeight: 38,
          borderRadius: 8,
          backgroundColor: tokens.surface,
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#cfd3da' },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: tokens.blue,
            boxShadow: `0 0 0 3px ${tokens.blueSurface}`,
          },
        },
        notchedOutline: {
          borderColor: tokens.border,
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: tokens.caption,
          fontWeight: 600,
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: `1px solid ${tokens.borderSoft}`,
          color: tokens.base,
          fontSize: '0.8125rem',
        },
        head: {
          backgroundColor: tokens.surface2,
          color: tokens.caption,
          fontSize: '0.75rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.02em',
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
          boxShadow: '0 4px 24px rgba(0, 0, 0, .12)',
        },
      },
    },
  },
})
