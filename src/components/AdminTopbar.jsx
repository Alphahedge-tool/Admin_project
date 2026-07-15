import {
  AppBar,
  Box,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Switch,
  Toolbar,
  Typography,
} from '@mui/material'
import { Activity, ChevronRight, Clock, KeyRound, LogOut, Moon, Rss, Settings, ShieldCheck, Sun, UserRound } from 'lucide-react'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ChangePasswordDialog from './ChangePasswordDialog'
import { useThemeMode } from '../themeMode'

const PAGE_LABELS = {
  '/admin': 'Overview',
  '/admin/users': 'Users',
  '/admin/trade-panel/client-dashboard': 'Client Dashboard',
  '/admin/trade-panel/positions': 'Positions',
  '/admin/trade-panel/order-book': 'Order Book',
  '/admin/trade-panel/trade-book': 'Trade Book',
  '/admin/transactions/sync-net-positions': 'Sync Positions',
}

function AdminTopbar({ admin, onLogout }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [anchorEl, setAnchorEl] = useState(null)
  const [openPwd, setOpenPwd] = useState(false)
  const { mode, toggleMode } = useThemeMode()

  const handleCloseMenu = () => setAnchorEl(null)
  const pageLabel = PAGE_LABELS[location.pathname]
    || location.pathname.split('/').filter(Boolean).at(-1)?.replaceAll('-', ' ')
    || 'Overview'
  const adminName = admin?.username || admin?.first_name || admin?.name || 'Admin'

  return (
    <>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ justifyContent: 'space-between', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.1, minWidth: 0 }}>
            <Box
              sx={{
                width: 30,
                height: 30,
                borderRadius: 1,
                display: 'grid',
                placeItems: 'center',
                color: 'primary.main',
                bgcolor: 'primary.light',
              }}
            >
              <ShieldCheck size={16} />
            </Box>
            <Typography sx={{ fontSize: '0.875rem', fontWeight: 850, color: 'text.primary', letterSpacing: '.015em' }}>
              STACKWEALTH
            </Typography>
            <ChevronRight size={13} color="var(--ao-placeholder)" />
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 700, color: 'text.secondary', textTransform: 'capitalize' }}>
              {pageLabel}
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              title="System operational"
              sx={{
                display: { xs: 'none', sm: 'inline-flex' }, alignItems: 'center', gap: .65,
                height: 26, px: 1, border: '1px solid var(--ao-border-soft)', borderRadius: 1,
                color: 'success.main', bgcolor: 'var(--ao-green-bg)', fontSize: '0.6875rem', fontWeight: 750,
              }}
            >
              <Activity size={12} /> Operational
            </Box>
            <Box sx={{ width: 1, height: 22, bgcolor: 'divider', mx: .25 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: .75 }}>
              <Box sx={{ width: 26, height: 26, borderRadius: 1, display: 'grid', placeItems: 'center', bgcolor: 'primary.light', color: 'primary.main' }}>
                <UserRound size={14} />
              </Box>
              <Box sx={{ display: { xs: 'none', md: 'grid' }, lineHeight: 1.1 }}>
                <Typography sx={{ fontSize: '0.6875rem', fontWeight: 800, color: 'text.primary' }}>{adminName}</Typography>
                <Typography sx={{ fontSize: '0.625rem', fontWeight: 650, color: 'text.secondary' }}>Administrator</Typography>
              </Box>
            </Box>
            <IconButton
              size="small"
              title="Settings"
              onClick={(e) => setAnchorEl(e.currentTarget)}
            >
              <Settings size={16} />
            </IconButton>
          </Box>

          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleCloseMenu}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{
              paper: {
                sx: {
                  mt: 1,
                  width: 268,
                  borderRadius: 2,
                  overflow: 'hidden',
                  border: '1px solid var(--ao-border-soft)',
                  boxShadow: '0 12px 40px rgba(37, 48, 64, .16)',
                  '& .MuiList-root': { py: 0 },
                },
              },
            }}
          >
            {/* IDENTITY HEADER */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.75,
                py: 1.5,
                background: 'linear-gradient(180deg, var(--ao-blue-bg), var(--ao-surface))',
                borderBottom: '1px solid var(--ao-border-soft)',
              }}
            >
              <Box sx={{ width: 38, height: 38, borderRadius: 1.5, display: 'grid', placeItems: 'center', bgcolor: 'primary.light', color: 'primary.main', flex: 'none' }}>
                <UserRound size={19} />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 800, color: 'text.primary', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {adminName}
                </Typography>
                <Typography sx={{ fontSize: '0.6875rem', fontWeight: 700, color: 'primary.main', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  Administrator
                </Typography>
              </Box>
            </Box>

            {/* LAST LOGIN */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.75, py: 1, color: 'text.secondary' }}>
              <Clock size={13} />
              <Typography sx={{ fontSize: '0.6875rem', fontWeight: 600 }}>
                Last login&nbsp;·&nbsp;{admin?.last_login ? new Date(admin.last_login).toLocaleString() : 'Not available'}
              </Typography>
            </Box>

            <Divider sx={{ borderColor: 'var(--ao-border-soft)' }} />

            {/* CONFIGURATION */}
            <SectionLabel>Configuration</SectionLabel>
            <MenuItem
              onClick={toggleMode}
              sx={{
                mx: 0.75, my: 0.25, px: 1, py: 0.75, gap: 1.25,
                borderRadius: 1.5, '&:hover': { bgcolor: 'var(--ao-hover)' },
              }}
            >
              <Box sx={{ width: 30, height: 30, borderRadius: 1.25, display: 'grid', placeItems: 'center', flex: 'none', color: 'primary.main', bgcolor: 'var(--ao-blue-bg)' }}>
                {mode === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 700, color: 'text.primary', lineHeight: 1.2 }}>
                  Appearance
                </Typography>
                <Typography sx={{ fontSize: '0.6875rem', fontWeight: 600, color: 'text.secondary', lineHeight: 1.2 }}>
                  {mode === 'dark' ? 'Night theme' : 'Day theme'}
                </Typography>
              </Box>
              <Switch
                size="small"
                checked={mode === 'dark'}
                onChange={toggleMode}
                onClick={(event) => event.stopPropagation()}
                inputProps={{ 'aria-label': 'Toggle day and night theme' }}
              />
            </MenuItem>
            <PanelItem
              icon={<Rss size={16} />}
              title="Feedmaster"
              subtitle="Live market data feed"
              accent
              onClick={() => {
                navigate('/admin/masters/feedmaster')
                handleCloseMenu()
              }}
            />

            <Divider sx={{ borderColor: 'var(--ao-border-soft)', my: 0.5 }} />

            {/* ACCOUNT */}
            <SectionLabel>Account</SectionLabel>
            <PanelItem
              icon={<KeyRound size={16} />}
              title="Change Password"
              onClick={() => {
                setOpenPwd(true)
                handleCloseMenu()
              }}
            />
            <PanelItem
              icon={<LogOut size={16} />}
              title="Logout"
              danger
              onClick={onLogout}
            />
            <Box sx={{ height: 6 }} />
          </Menu>
        </Toolbar>
      </AppBar>

      <ChangePasswordDialog
        open={openPwd}
        onClose={() => setOpenPwd(false)}
      />
    </>
  )
}

/* Small uppercase caption that groups the panel's actions. */
function SectionLabel({ children }) {
  return (
    <Typography
      sx={{
        px: 1.75,
        pt: 1,
        pb: 0.5,
        fontSize: '0.625rem',
        fontWeight: 800,
        color: 'text.secondary',
        textTransform: 'uppercase',
        letterSpacing: '.06em',
      }}
    >
      {children}
    </Typography>
  )
}

/* One row in the settings panel: icon + title (+ optional subtitle), with a
   trailing chevron. `accent` tints it blue, `danger` tints it red. */
function PanelItem({ icon, title, subtitle, onClick, accent = false, danger = false }) {
  const tone = danger ? 'error.main' : accent ? 'primary.main' : 'text.secondary'
  const hoverBg = danger ? 'var(--ao-red-bg)' : accent ? 'var(--ao-blue-bg)' : 'var(--ao-hover)'
  return (
    <MenuItem
      onClick={onClick}
      sx={{
        mx: 0.75,
        my: 0.25,
        px: 1,
        py: 0.875,
        gap: 1.25,
        borderRadius: 1.5,
        alignItems: 'center',
        '&:hover': { bgcolor: hoverBg },
      }}
    >
      <Box sx={{ width: 30, height: 30, borderRadius: 1.25, display: 'grid', placeItems: 'center', flex: 'none', color: tone, bgcolor: hoverBg }}>
        {icon}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: '0.8125rem', fontWeight: 700, color: danger ? 'error.main' : 'text.primary', lineHeight: 1.2 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography sx={{ fontSize: '0.6875rem', fontWeight: 600, color: 'text.secondary', lineHeight: 1.2 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      <ChevronRight size={14} color="var(--ao-placeholder)" />
    </MenuItem>
  )
}

export default AdminTopbar
