import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Button,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  RadioGroup,
  FormControlLabel,
  Radio,
  IconButton,
  Tooltip,
  Table,
  TableHead,
  TableBody,
  TableFooter,
  TableRow,
  TableCell,
  InputAdornment,
  Avatar,
  Skeleton
} from '@mui/material'
import Autocomplete from '@mui/material/Autocomplete'
import {
  Pencil,
  Trash2,
  Plus,
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  UsersRound,
  ChevronRight
} from 'lucide-react'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import dayjs from 'dayjs'
import { apiGet, apiPost } from '../config/api'

/* ================= HELPERS ================= */

const formatINR = (n = 0) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(
    Number(n || 0)
  )

// Money that can go either way always carries its sign, so a negative never
// depends on colour alone to be read as an outflow.
const signed = (n = 0) => `${Number(n) < 0 ? '-' : '+'}${formatINR(Math.abs(Number(n) || 0))}`

const initials = (user) =>
  `${user?.first_name?.[0] || ''}${user?.last_name?.[0] || ''}`.toUpperCase() || '?'

/* Shared cell rhythm — same gutters as DataTable so every screen's rows line
   up with one another. */
const cellSx = {
  py: 0.75,
  fontVariantNumeric: 'tabular-nums',
  '&:first-of-type': { pl: 2 },
  '&:last-of-type': { pr: 2 },
}
const headSx = {
  ...cellSx,
  py: 1,
  position: 'sticky',
  top: 0,
  zIndex: 2,
  whiteSpace: 'nowrap',
}

/* ================= COMPONENT ================= */

function UserBalances() {
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)

  // Month bands the user has folded shut, keyed by band label.
  const [collapsed, setCollapsed] = useState(() => new Set())

  const [groups, setGroups] = useState([])
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [groupUsers, setGroupUsers] = useState([])
  const [groupLoading, setGroupLoading] = useState(false)

  const [summary, setSummary] = useState(null)
  const [rows, setRows] = useState([])

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)

  const [form, setForm] = useState({
    txn_date: dayjs(),
    txn_type: 'ADD',
    amount: ''
  })

  const [errors, setErrors] = useState({})

  /* ================= USER SEARCH ================= */

  // With a group picked we already hold its full member list, so typing filters
  // locally (Autocomplete's own matching) rather than hitting the server and
  // pulling in users from outside the group.
  const searchUsers = async (q) => {
    if (selectedGroup) return
    if (!q || q.length < 2) return
    const res = await apiPost('/users/balances/user-search.php', { q })
    setUsers(res.data || [])
  }

  /* ================= GROUP SCOPE ================= */

  const handleGroupChange = async (group) => {
    setSelectedGroup(group)
    setSelectedUser(null)
    setSummary(null)
    setRows([])

    if (!group) {
      setGroupUsers([])
      return
    }

    setGroupLoading(true)
    try {
      const res = await apiGet(`/masters/groups/users.php?group_id=${group.id}`)
      setGroupUsers(res.data || [])
    } catch (e) {
      console.error(e)
      setGroupUsers([])
    } finally {
      setGroupLoading(false)
    }
  }

  // The user picker is scoped to the group when one is active.
  const userOptions = selectedGroup ? groupUsers : users

  /* ================= LOAD DATA ================= */

  const loadData = async (userId) => {
    const [s, l] = await Promise.all([
      apiPost('/users/balances/summary.php', { user_id: userId }),
      apiPost('/users/balances/list.php', { user_id: userId })
    ])
    setSummary(s.data)
    setRows(l.data)
  }

  useEffect(() => {
    if (selectedUser?.id) loadData(selectedUser.id)
    // A fold is about the ledger you were reading, so a new user starts fully
    // expanded rather than inheriting the previous one's collapsed months.
    setCollapsed(new Set())
  }, [selectedUser?.id])

  const toggleMonth = (key) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  useEffect(() => {
    apiPost('/users/balances/user-search.php', {}).then(res =>
      setUsers(res.data || [])
    )
    apiGet('/masters/groups/list.php')
      .then(res => setGroups(res.data || []))
      .catch(e => console.error(e))
  }, [])

  /* ================= FORM ================= */

  const validate = () => {
    const e = {}
    if (!form.amount || Number(form.amount) <= 0)
      e.amount = 'Enter valid amount'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSave = async () => {
    if (!validate()) return

    const payload = {
      user_id: selectedUser.id,
      txn_date: form.txn_date.format('YYYY-MM-DD'),
      txn_type: form.txn_type,
      amount: form.amount
    }

    if (editing) {
      await apiPost('/users/balances/update.php', { id: editing.id, ...payload })
    } else {
      await apiPost('/users/balances/create.php', payload)
    }

    setOpen(false)
    setEditing(null)
    setForm({ txn_date: dayjs(), txn_type: 'ADD', amount: '' })
    loadData(selectedUser.id)
  }

  const handleAdd = () => {
    setEditing(null)
    setErrors({})
    setForm({ txn_date: dayjs(), txn_type: 'ADD', amount: '' })
    setOpen(true)
  }

  const handleEdit = (row) => {
    setEditing(row)
    setErrors({})
    setForm({
      txn_date: dayjs(row.txn_date),
      txn_type: row.txn_type,
      amount: row.amount
    })
    setOpen(true)
  }

  const handleDelete = async (row) => {
    if (!window.confirm('Delete this transaction?')) return
    await apiPost('/users/balances/delete.php', { id: row.id })
    loadData(selectedUser.id)
  }

  /* ================= TOTALS ================= */

  const totalAdded = rows
    .filter(r => r.txn_type === 'ADD')
    .reduce((s, r) => s + Number(r.amount), 0)

  const totalWithdrawn = rows
    .filter(r => r.txn_type === 'WITHDRAW')
    .reduce((s, r) => s + Number(r.amount), 0)

  const netAmount = totalAdded - totalWithdrawn

  /* Month bands, built in the order the server sent the rows — this groups
     consecutive runs rather than re-sorting, so the ledger's own ordering is
     never silently rearranged underneath the user. */
  const grouped = useMemo(() => {
    const out = []
    let current = null

    for (const r of rows) {
      const key = dayjs(r.txn_date).format('MMMM YYYY')
      if (!current || current.key !== key) {
        current = { key, items: [], net: 0 }
        out.push(current)
      }
      current.items.push(r)
      current.net += r.txn_type === 'ADD' ? Number(r.amount) : -Number(r.amount)
    }

    return out
  }, [rows])

  const loading = selectedUser && !summary

  /* ================= RENDER ================= */

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* PAGE HEADER — title, user picker, summary and the primary action all
          share one row so the table below gets the vertical space. */}
      <Box
        sx={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1.5,
          mb: 1.5,
        }}
      >
        <Typography variant="h5" fontWeight={700} sx={{ mr: 0.5 }}>
          User Balances
        </Typography>

        <Autocomplete
          options={groups}
          value={selectedGroup}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          getOptionLabel={(o) => o?.name || ''}
          onChange={(_, v) => handleGroupChange(v)}
          renderOption={(props, option) => (
            <Box component="li" {...props} sx={{ gap: 1.25 }}>
              <Box
                sx={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 26,
                  height: 26,
                  flex: 'none',
                  borderRadius: 1,
                  bgcolor: 'var(--ao-blue-bg)',
                  color: 'primary.main',
                }}
              >
                <UsersRound size={14} />
              </Box>
              <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, color: 'text.primary' }}>
                {option.name}
              </Typography>
            </Box>
          )}
          renderInput={(params) => (
            <TextField {...params} label="Group" placeholder="All groups" />
          )}
          sx={{ width: 220, flex: '0 1 220px' }}
        />

        <Autocomplete
          options={userOptions}
          value={selectedUser}
          loading={groupLoading}
          disabled={groupLoading}
          noOptionsText={selectedGroup ? 'No users in this group' : 'No users found'}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          getOptionLabel={(o) =>
            o ? `${o.first_name} ${o.last_name} (${o.username})` : ''
          }
          onInputChange={(_, v, r) => r === 'input' && searchUsers(v)}
          onChange={(_, v) => setSelectedUser(v)}
          renderOption={(props, option) => (
            <Box component="li" {...props} sx={{ gap: 1.25 }}>
              <Avatar
                sx={{
                  width: 26,
                  height: 26,
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  bgcolor: 'var(--ao-blue-surface)',
                  color: 'primary.main',
                }}
              >
                {initials(option)}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, color: 'text.primary' }}>
                  {option.first_name} {option.last_name}
                </Typography>
                <Typography sx={{ fontSize: '0.6875rem', color: 'text.secondary' }}>
                  {option.username}
                </Typography>
              </Box>
            </Box>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Select User"
              placeholder={
                selectedGroup
                  ? `Search ${groupUsers.length} member${groupUsers.length === 1 ? '' : 's'}`
                  : 'Search by name or username'
              }
            />
          )}
          sx={{ width: 280, flex: '0 1 280px' }}
        />

        {/* Tiles carry the same footprint whether they hold numbers or
            skeletons, so picking a user never shifts the layout. */}
        {loading ? (
          <Box sx={{ display: 'flex', gap: 1, ml: 'auto' }}>
            <Skeleton variant="rounded" width={132} height={38} />
            <Skeleton variant="rounded" width={132} height={38} />
            <Skeleton variant="rounded" width={132} height={38} />
          </Box>
        ) : summary ? (
          <Box sx={{ display: 'flex', gap: 1, ml: 'auto', flexWrap: 'wrap' }}>
            <SummaryTile
              label="Added"
              value={summary.total_added}
              accent="var(--ao-green)"
              icon={<ArrowDownLeft size={14} />}
            />
            <SummaryTile
              label="Withdrawn"
              value={summary.total_withdrawn}
              accent="var(--ao-red)"
              icon={<ArrowUpRight size={14} />}
            />
            <SummaryTile
              label="Net Investment"
              value={summary.net_investment}
              accent="var(--ao-blue)"
              icon={<Wallet size={14} />}
              strong
            />
          </Box>
        ) : (
          <Typography sx={{ fontSize: '0.8125rem', color: 'text.secondary', ml: 'auto', pr: 1 }}>
            Pick a user to see their balance summary.
          </Typography>
        )}

        <Button
          variant="contained"
          disabled={!selectedUser}
          onClick={handleAdd}
          startIcon={<Plus size={16} />}
          sx={{ flex: 'none' }}
        >
          Add Amount
        </Button>
      </Box>

      {/* TRANSACTIONS */}
      <Paper sx={{ flex: 1, minHeight: 0, p: 1.5, display: 'flex', flexDirection: 'column' }}>
        {!selectedUser ? (
          <EmptyState />
        ) : (
          <>
            <Box
              sx={{
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 1,
                px: 0.5,
              }}
            >
              <Typography sx={{ fontSize: '0.875rem', fontWeight: 700, color: 'text.primary' }}>
                Transactions
              </Typography>
              {!loading && (
                <Box sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.5 }}>
                  <Typography component="span" sx={{ fontSize: '0.8125rem', fontWeight: 800, color: 'text.primary' }}>
                    {rows.length}
                  </Typography>
                  <Typography
                    component="span"
                    sx={{
                      fontSize: '0.6875rem',
                      fontWeight: 700,
                      color: 'text.secondary',
                      textTransform: 'uppercase',
                      letterSpacing: '.04em',
                    }}
                  >
                    {rows.length === 1 ? 'entry' : 'entries'}
                  </Typography>
                </Box>
              )}
            </Box>

            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                border: '1px solid var(--ao-border-soft)',
                borderRadius: 1.5,
                bgcolor: 'background.paper',
              }}
            >
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={headSx}>Date</TableCell>
                    <TableCell align="right" sx={headSx}>Added</TableCell>
                    <TableCell align="right" sx={headSx}>Withdrawn</TableCell>
                    <TableCell align="right" sx={headSx}>Net</TableCell>
                    <TableCell align="center" sx={headSx}>Actions</TableCell>
                  </TableRow>
                </TableHead>

                <TableBody>
                  {loading &&
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={`balance-skeleton-${i}`}>
                        <TableCell sx={cellSx}><Skeleton variant="text" width="60%" /></TableCell>
                        <TableCell align="right" sx={cellSx}><Skeleton variant="text" width="55%" sx={{ ml: 'auto' }} /></TableCell>
                        <TableCell align="right" sx={cellSx}><Skeleton variant="text" width="55%" sx={{ ml: 'auto' }} /></TableCell>
                        <TableCell align="right" sx={cellSx}><Skeleton variant="text" width="55%" sx={{ ml: 'auto' }} /></TableCell>
                        <TableCell align="center" sx={cellSx}>
                          <Box sx={{ display: 'inline-flex', gap: 0.75 }}>
                            <Skeleton variant="circular" width={22} height={22} />
                            <Skeleton variant="circular" width={22} height={22} />
                          </Box>
                        </TableCell>
                      </TableRow>
                    ))}

                  {!loading && grouped.map(month => {
                    const isOpen = !collapsed.has(month.key)

                    return (
                    <Fragment key={month.key}>
                      {/* Month band: a scannable spine for a long ledger, and the
                          disclosure control for its rows. Its net stays visible
                          when folded, so collapsing never hides the answer. */}
                      <TableRow
                        onClick={() => toggleMonth(month.key)}
                        sx={{
                          cursor: 'pointer',
                          '&:hover td': { bgcolor: 'var(--ao-hover)' },
                        }}
                      >
                        <TableCell
                          colSpan={5}
                          sx={{
                            py: 0.5,
                            px: 2,
                            bgcolor: 'var(--ao-surface-2)',
                            borderBottom: '1px solid var(--ao-border-soft)',
                          }}
                        >
                          <Box
                            role="button"
                            tabIndex={0}
                            aria-expanded={isOpen}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleMonth(month.key)
                              }
                            }}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              outline: 'none',
                              '&:focus-visible': {
                                boxShadow: '0 0 0 2px var(--ao-blue)',
                                borderRadius: 0.5,
                              },
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                              <ChevronRight
                                size={13}
                                style={{
                                  flex: 'none',
                                  color: 'var(--ao-caption)',
                                  transform: isOpen ? 'rotate(90deg)' : 'none',
                                  transition: 'transform .15s ease',
                                }}
                              />
                              <Typography
                                component="span"
                                sx={{
                                  fontSize: '0.6875rem',
                                  fontWeight: 800,
                                  color: 'text.secondary',
                                  textTransform: 'uppercase',
                                  letterSpacing: '.06em',
                                }}
                              >
                                {month.key}
                              </Typography>
                              <Typography
                                component="span"
                                sx={{ fontSize: '0.625rem', fontWeight: 700, color: 'text.secondary', opacity: 0.7 }}
                              >
                                {month.items.length}
                              </Typography>
                            </Box>

                            <Typography
                              component="span"
                              sx={{
                                fontSize: '0.6875rem',
                                fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                                color: month.net < 0 ? 'var(--ao-red)' : 'var(--ao-green)',
                              }}
                            >
                              {signed(month.net)}
                            </Typography>
                          </Box>
                        </TableCell>
                      </TableRow>

                      {isOpen && month.items.map(r => {
                        const isAdd = r.txn_type === 'ADD'
                        const net = isAdd ? Number(r.amount) : -Number(r.amount)
                        const accent = isAdd ? 'var(--ao-green)' : 'var(--ao-red)'

                        return (
                          <TableRow key={r.id} hover>
                            {/* The date carries the direction: a tinted arrow chip
                                plus an accent rail, so fund-in and fund-out are
                                distinguishable at a glance and not by colour
                                alone. */}
                            <TableCell
                              sx={{
                                ...cellSx,
                                whiteSpace: 'nowrap',
                                boxShadow: `inset 3px 0 0 ${accent}`,
                              }}
                            >
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Box
                                  sx={{
                                    display: 'grid',
                                    placeItems: 'center',
                                    width: 22,
                                    height: 22,
                                    flex: 'none',
                                    borderRadius: 0.75,
                                    color: accent,
                                    bgcolor: isAdd ? 'var(--ao-green-bg)' : 'var(--ao-red-bg)',
                                  }}
                                >
                                  {isAdd ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                                </Box>

                                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
                                  <Typography component="span" sx={{ fontSize: '0.875rem', fontWeight: 700, color: 'text.primary' }}>
                                    {dayjs(r.txn_date).format('DD MMM YYYY')}
                                  </Typography>
                                  <Typography
                                    component="span"
                                    sx={{
                                      fontSize: '0.625rem',
                                      fontWeight: 800,
                                      letterSpacing: '.06em',
                                      color: accent,
                                    }}
                                  >
                                    {isAdd ? 'IN' : 'OUT'}
                                  </Typography>
                                </Box>
                              </Box>
                            </TableCell>

                            <TableCell align="right" sx={{ ...cellSx, color: 'var(--ao-green)', fontWeight: 700 }}>
                              {isAdd ? `+${formatINR(r.amount)}` : <Muted />}
                            </TableCell>

                            <TableCell align="right" sx={{ ...cellSx, color: 'var(--ao-red)', fontWeight: 700 }}>
                              {!isAdd ? `-${formatINR(r.amount)}` : <Muted />}
                            </TableCell>

                            <TableCell
                              align="right"
                              sx={{ ...cellSx, fontWeight: 800, color: net < 0 ? 'var(--ao-red)' : 'var(--ao-green)' }}
                            >
                              {signed(net)}
                            </TableCell>

                            <TableCell align="center" sx={cellSx}>
                              <Box sx={{ display: 'inline-flex', gap: 0.25 }}>
                                <Tooltip title="Edit">
                                  <IconButton
                                    size="small"
                                    onClick={() => handleEdit(r)}
                                    sx={{ '&:hover': { color: 'primary.main', bgcolor: 'var(--ao-blue-bg)' } }}
                                  >
                                    <Pencil size={15} />
                                  </IconButton>
                                </Tooltip>
                                <Tooltip title="Delete">
                                  <IconButton
                                    size="small"
                                    onClick={() => handleDelete(r)}
                                    sx={{ '&:hover': { color: 'error.main', bgcolor: 'var(--ao-red-bg)' } }}
                                  >
                                    <Trash2 size={15} />
                                  </IconButton>
                                </Tooltip>
                              </Box>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </Fragment>
                    )
                  })}

                  {!loading && rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 6, color: 'text.secondary', fontWeight: 600 }}>
                        No transactions yet for this user
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>

                {/* Totals stay pinned to the bottom of the scroll area so they
                    remain readable on long histories. */}
                {!loading && rows.length > 0 && (
                  <TableFooter
                    sx={{
                      position: 'sticky',
                      bottom: 0,
                      zIndex: 2,
                      '& td': {
                        bgcolor: 'var(--ao-surface-2)',
                        borderTop: '1px solid var(--ao-border-soft)',
                        borderBottom: 0,
                        fontSize: '0.875rem',
                      },
                    }}
                  >
                    <TableRow>
                      <TableCell
                        sx={{
                          ...cellSx,
                          fontWeight: 700,
                          color: 'text.secondary',
                          textTransform: 'uppercase',
                          fontSize: '0.75rem',
                          letterSpacing: '.04em',
                        }}
                      >
                        Total
                      </TableCell>
                      <TableCell align="right" sx={{ ...cellSx, fontWeight: 800, color: 'var(--ao-green)' }}>
                        +{formatINR(totalAdded)}
                      </TableCell>
                      <TableCell align="right" sx={{ ...cellSx, fontWeight: 800, color: 'var(--ao-red)' }}>
                        -{formatINR(totalWithdrawn)}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{ ...cellSx, fontWeight: 800, color: netAmount < 0 ? 'var(--ao-red)' : 'var(--ao-green)' }}
                      >
                        {signed(netAmount)}
                      </TableCell>
                      <TableCell sx={cellSx} />
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </Box>
          </>
        )}
      </Paper>

      {/* ADD / EDIT DIALOG */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          {editing ? 'Edit Transaction' : 'Add Transaction'}
          {selectedUser && (
            <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', fontWeight: 500, mt: 0.25 }}>
              {selectedUser.first_name} {selectedUser.last_name} ({selectedUser.username})
            </Typography>
          )}
        </DialogTitle>

        <DialogContent sx={{ pt: 1 }}>
          <DatePicker
            label="Date"
            format="DD/MM/YYYY"
            value={form.txn_date}
            onChange={(v) => setForm({ ...form, txn_date: v })}
            slotProps={{ textField: { fullWidth: true, margin: 'dense' } }}
          />

          <Box
            sx={{
              mt: 2,
              px: 1.5,
              py: 0.5,
              border: '1px solid var(--ao-border-soft)',
              borderRadius: 1.5,
              bgcolor: 'var(--ao-surface-2)',
            }}
          >
            <RadioGroup
              row
              value={form.txn_type}
              onChange={(e) => setForm({ ...form, txn_type: e.target.value })}
              sx={{ gap: 2, '& .MuiFormControlLabel-label': { fontSize: '0.875rem', fontWeight: 600 } }}
            >
              <FormControlLabel value="ADD" control={<Radio size="small" />} label="Add" />
              <FormControlLabel value="WITHDRAW" control={<Radio size="small" />} label="Withdraw" />
            </RadioGroup>
          </Box>

          <TextField
            fullWidth
            label="Amount"
            type="number"
            margin="normal"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            error={!!errors.amount}
            helperText={errors.amount}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Typography sx={{ fontSize: '0.8125rem', fontWeight: 700, color: 'text.secondary' }}>
                    Rs.
                  </Typography>
                </InputAdornment>
              ),
            }}
          />
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave}>Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

/* ================= UI HELPERS ================= */

function SummaryTile({ label, value, accent, icon, strong }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        py: 0.75,
        border: '1px solid var(--ao-border-soft)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 1.5,
        bgcolor: 'var(--ao-surface-2)',
      }}
    >
      <Box sx={{ display: 'grid', placeItems: 'center', flex: 'none', color: accent }}>
        {icon}
      </Box>

      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
        <Typography
          sx={{
            fontSize: '0.6875rem',
            fontWeight: 700,
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '.04em',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </Typography>
        <Typography
          sx={{
            fontSize: '0.9375rem',
            fontWeight: strong ? 800 : 700,
            color: 'text.primary',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {formatINR(value)}
        </Typography>
      </Box>
    </Box>
  )
}

/* Blank money cells read as a dash rather than an empty gap, so the eye can
   still follow the column. */
function Muted() {
  return <Box component="span" sx={{ color: 'text.secondary', opacity: 0.5 }}>—</Box>
}

function EmptyState() {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        py: 8,
      }}
    >
      <Box
        sx={{
          display: 'grid',
          placeItems: 'center',
          width: 48,
          height: 48,
          borderRadius: '50%',
          bgcolor: 'var(--ao-blue-bg)',
          color: 'primary.main',
        }}
      >
        <Wallet size={22} />
      </Box>
      <Typography sx={{ fontWeight: 700, color: 'text.primary' }}>
        No user selected
      </Typography>
      <Typography sx={{ fontSize: '0.8125rem', color: 'text.secondary' }}>
        Pick a group to narrow the list, then choose a user to see their transactions.
      </Typography>
    </Box>
  )
}

export default UserBalances
