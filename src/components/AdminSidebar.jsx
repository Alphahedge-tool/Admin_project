import { useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material'
import {
  BarChart3,
  BriefcaseBusiness,
  ChevronDown,
  CircleDollarSign,
  Database,
  ExternalLink,
  FileText,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ReceiptText,
  Rss,
  ScrollText,
  Scale,
  TrendingUp,
  UserRound,
  Users2,
  UsersRound,
} from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

function AdminSidebar() {
  const location = useLocation()

  const [open, setOpen] = useState(true)
  const [mastersOpen, setMastersOpen] = useState(true)
  const [transactionsOpen, setTransactionsOpen] = useState(true)
  const [tradePanelOpen, setTradePanelOpen] = useState(true)

  const isMastersRoute = location.pathname.startsWith('/admin/masters')
  const isTransactionsRoute = location.pathname.startsWith('/admin/transactions')
  const isTradePanelRoute = location.pathname.startsWith('/admin/trade-panel')

  const NavIcon = ({ children }) => (
    <Box sx={{ display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
      {children}
    </Box>
  )

  const navSx = (path, nested = false) => {
    const active = location.pathname === path
    return {
      minHeight: 36,
      mx: 1,
      my: 0.25,
      pl: nested ? 4.5 : 1.5,
      pr: 1,
      gap: 1,
      borderRadius: 1,
      color: active ? 'primary.main' : 'text.secondary',
      bgcolor: active ? 'primary.light' : 'transparent',
      '&:hover': {
        bgcolor: active ? 'primary.light' : 'var(--ao-hover)',
        color: active ? 'primary.main' : 'text.primary',
      },
      '& .MuiListItemText-primary': {
        fontSize: '0.8125rem',
        fontWeight: active ? 700 : 600,
      },
    }
  }

  const summarySx = (active) => ({
    minHeight: 38,
    mx: 1,
    my: 0.25,
    px: 1.5,
    borderRadius: 1,
    color: active ? 'primary.main' : 'text.secondary',
    bgcolor: active ? 'primary.light' : 'transparent',
    '&:hover': { bgcolor: active ? 'primary.light' : 'var(--ao-hover)' },
    '& .MuiAccordionSummary-content': {
      alignItems: 'center',
      gap: 1,
      margin: 0,
    },
    '& .MuiListItemText-primary': {
      fontSize: '0.8125rem',
      fontWeight: 700,
    },
  })

  const openTradePanelTab = (event) => {
    event.preventDefault()
    event.stopPropagation()
    window.open('/admin/trade-panel/standalone', '_blank', 'noopener,noreferrer')
  }

  return (
    <Box
      sx={{
        width: open ? 232 : 46,
        minWidth: open ? 232 : 46,
        flexShrink: 0,
        height: '100%',
        borderRight: '1px solid var(--ao-border-soft)',
        background: 'var(--ao-surface)',
        zIndex: 20,
        overflow: 'hidden',
      }}
    >
      {!open && (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          py: 1,
        }}
      >
        <IconButton
          size="small"
          title="Open sidebar"
          onClick={() => setOpen(true)}
        >
          <PanelLeftOpen size={17} />
        </IconButton>
      </Box>
      )}

      {open && (
      <>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          px: 1,
          pb: 0.75,
        }}
      >
        <IconButton
          size="small"
          title="Close sidebar"
          onClick={() => setOpen(false)}
        >
          <PanelLeftClose size={17} />
        </IconButton>
      </Box>
      <List sx={{ p: 0 }}>
        <ListItemButton component={Link} to="/admin" sx={navSx('/admin')}>
          <NavIcon><LayoutDashboard size={16} /></NavIcon>
          <ListItemText primary="Dashboard" />
        </ListItemButton>

        <ListItemButton component={Link} to="/admin/users" sx={navSx('/admin/users')}>
          <NavIcon><UsersRound size={16} /></NavIcon>
          <ListItemText primary="Users" />
        </ListItemButton>

        <Accordion
          expanded={mastersOpen || isMastersRoute}
          onChange={() => setMastersOpen(!mastersOpen)}
          elevation={0}
          disableGutters
          square
          sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}
        >
          <AccordionSummary expandIcon={<ChevronDown size={15} />} sx={summarySx(isMastersRoute)}>
            <NavIcon><Database size={16} /></NavIcon>
            <ListItemText primary="Masters" />
          </AccordionSummary>

          <AccordionDetails sx={{ p: 0 }}>
            <List component="div" disablePadding>
              <ListItemButton component={Link} to="/admin/masters/stocks" sx={navSx('/admin/masters/stocks', true)}>
                <NavIcon><Scale size={15} /></NavIcon>
                <ListItemText primary="Stocks Master" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/masters/mutual-funds" sx={navSx('/admin/masters/mutual-funds', true)}>
                <NavIcon><CircleDollarSign size={15} /></NavIcon>
                <ListItemText primary="MF Master" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/masters/brokers" sx={navSx('/admin/masters/brokers', true)}>
                <NavIcon><UserRound size={15} /></NavIcon>
                <ListItemText primary="Broker Master" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/masters/groups" sx={navSx('/admin/masters/groups', true)}>
                <NavIcon><Users2 size={15} /></NavIcon>
                <ListItemText primary="Group Master" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/masters/feedmaster" sx={navSx('/admin/masters/feedmaster', true)}>
                <NavIcon><Rss size={15} /></NavIcon>
                <ListItemText primary="Feedmaster" />
              </ListItemButton>
            </List>
          </AccordionDetails>
        </Accordion>

        <Accordion
          expanded={transactionsOpen || isTransactionsRoute}
          onChange={() => setTransactionsOpen(!transactionsOpen)}
          elevation={0}
          disableGutters
          square
          sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}
        >
          <AccordionSummary expandIcon={<ChevronDown size={15} />} sx={summarySx(isTransactionsRoute)}>
            <NavIcon><RefreshCw size={16} /></NavIcon>
            <ListItemText primary="Transactions" />
          </AccordionSummary>

          <AccordionDetails sx={{ p: 0 }}>
            <List component="div" disablePadding>
              <ListItemButton component={Link} to="/admin/transactions/user-balances" sx={navSx('/admin/transactions/user-balances', true)}>
                <NavIcon><CircleDollarSign size={15} /></NavIcon>
                <ListItemText primary="User Balances" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/transactions/sync-net-positions" sx={navSx('/admin/transactions/sync-net-positions', true)}>
                <NavIcon><RefreshCw size={15} /></NavIcon>
                <ListItemText primary="Sync Net Positions" />
              </ListItemButton>
            </List>
          </AccordionDetails>
        </Accordion>

        <Accordion
          expanded={tradePanelOpen || isTradePanelRoute}
          onChange={() => setTradePanelOpen(!tradePanelOpen)}
          elevation={0}
          disableGutters
          square
          sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}
        >
          <AccordionSummary expandIcon={<ChevronDown size={15} />} sx={summarySx(isTradePanelRoute)}>
            <NavIcon><TrendingUp size={16} /></NavIcon>
            <ListItemText primary="Trade Panel" />
            <IconButton
              component="span"
              size="small"
              role="button"
              tabIndex={0}
              title="Open Trade Panel in new tab"
              onClick={openTradePanelTab}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') openTradePanelTab(event)
              }}
              sx={{
                width: 26,
                height: 26,
                mr: 0.25,
                color: 'text.secondary',
                '&:hover': {
                  color: 'primary.main',
                  bgcolor: 'primary.light',
                },
              }}
            >
              <ExternalLink size={14} />
            </IconButton>
          </AccordionSummary>

          <AccordionDetails sx={{ p: 0 }}>
            <List component="div" disablePadding>
              <ListItemButton component={Link} to="/admin/trade-panel/client-dashboard" sx={navSx('/admin/trade-panel/client-dashboard', true)}>
                <NavIcon><LayoutDashboard size={15} /></NavIcon>
                <ListItemText primary="Client Dashboard" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/trade-panel/enter-trade" sx={navSx('/admin/trade-panel/enter-trade', true)}>
                <NavIcon><BarChart3 size={15} /></NavIcon>
                <ListItemText primary="Enter Trade" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/trade-panel/positions" sx={navSx('/admin/trade-panel/positions', true)}>
                <NavIcon><BriefcaseBusiness size={15} /></NavIcon>
                <ListItemText primary="Get Position" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/trade-panel/order-book" sx={navSx('/admin/trade-panel/order-book', true)}>
                <NavIcon><ScrollText size={15} /></NavIcon>
                <ListItemText primary="Get OrderBook" />
              </ListItemButton>

              <ListItemButton component={Link} to="/admin/trade-panel/trade-book" sx={navSx('/admin/trade-panel/trade-book', true)}>
                <NavIcon><ReceiptText size={15} /></NavIcon>
                <ListItemText primary="Get TradeBook" />
              </ListItemButton>
            </List>
          </AccordionDetails>
        </Accordion>

        <ListItemButton disabled sx={{ ...navSx('/admin/reports'), opacity: .48 }}>
          <NavIcon><FileText size={16} /></NavIcon>
          <ListItemText primary="Reports" />
        </ListItemButton>
      </List>
      </>
      )}
    </Box>
  )
}

export default AdminSidebar
