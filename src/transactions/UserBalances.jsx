import { useEffect, useState } from 'react'
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
  IconButton
} from '@mui/material'
import Autocomplete from '@mui/material/Autocomplete'
import { Pencil, Trash2 } from 'lucide-react'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import dayjs from 'dayjs'
import { apiPost } from '../config/api'

/* ================= HELPERS ================= */

const formatINR = (n = 0) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(
    Number(n || 0)
  )

/* ================= COMPONENT ================= */

function UserBalances() {
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)

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

  const searchUsers = async (q) => {
    if (!q || q.length < 2) return
    const res = await apiPost('/users/balances/user-search.php', { q })
    setUsers(res.data || [])
  }

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
  }, [selectedUser?.id])

  useEffect(() => {
    apiPost('/users/balances/user-search.php', {}).then(res =>
      setUsers(res.data || [])
    )
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

  const handleEdit = (row) => {
    setEditing(row)
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

  /* ================= RENDER ================= */

  return (
    <Box>
      <Typography variant="h5" fontWeight={600} mb={2}>
        User Balances
      </Typography>

      {/* TOP BAR */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
        <Autocomplete
          options={users}
          value={selectedUser}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          getOptionLabel={(o) =>
            o ? `${o.first_name} ${o.last_name} (${o.username})` : ''
          }
          onInputChange={(_, v, r) => r === 'input' && searchUsers(v)}
          onChange={(_, v) => setSelectedUser(v)}
          renderInput={(params) => (
            <TextField {...params} label="Select User" />
          )}
          sx={{ width: 360 }}
        />

        {summary && (
          <Box sx={{ display: 'flex', gap: 2 }}>
            <SummaryTile label="Added" value={summary.total_added} color="green" />
            <SummaryTile
              label="Withdrawn"
              value={summary.total_withdrawn}
              color="red"
            />
            <SummaryTile label="Net" value={summary.net_investment} bold />
          </Box>
        )}
      </Box>

      {selectedUser && summary && (
        <Paper sx={{ p: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
            <Typography fontWeight={600}>Transactions</Typography>
            <Button size="small" variant="contained" onClick={() => setOpen(true)}>
              Add Amount
            </Button>
          </Box>

          {rows.length === 0 ? (
            <Typography align="center" sx={{ py: 4, color: '#6b7280' }}>
              No record found
            </Typography>
          ) : (
            <table width="100%" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th align="center">Date</Th>
                  <Th align="right">Added</Th>
                  <Th align="right">Withdrawn</Th>
                  <Th align="right">Net</Th>
                  <Th align="center">Actions</Th>
                </tr>
              </thead>

              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <Td align="center">
                      {dayjs(r.txn_date).format('DD/MM/YYYY')}
                    </Td>

                    <Td align="right" color="green">
                      {r.txn_type === 'ADD' ? formatINR(r.amount) : ''}
                    </Td>

                    <Td align="right" color="red">
                      {r.txn_type === 'WITHDRAW' ? formatINR(r.amount) : ''}
                    </Td>

                    <Td align="right">
                      {formatINR(
                        r.txn_type === 'ADD'
                          ? r.amount
                          : -r.amount
                      )}
                    </Td>

                    <Td align="center">
                      <IconButton size="small" onClick={() => handleEdit(r)}>
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleDelete(r)}>
                        <Trash2 size={15} />
                      </IconButton>
                    </Td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <Td align="center" bold bg="#f3f4f6">Total</Td>
                  <Td align="right" color="green" bold bg="#f3f4f6">
                    {formatINR(totalAdded)}
                  </Td>
                  <Td align="right" color="red" bold bg="#f3f4f6">
                    {formatINR(totalWithdrawn)}
                  </Td>
                  <Td align="right" bold bg="#f3f4f6">
                    {formatINR(netAmount)}
                  </Td>
                  <Td bg="#f3f4f6" />
                </tr>
              </tfoot>
            </table>
          )}
        </Paper>
      )}

      {/* ADD / EDIT DIALOG */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{editing ? 'Edit' : 'Add'} Transaction</DialogTitle>
        <DialogContent>
          <DatePicker
            label="Date"
            format="DD/MM/YYYY"
            value={form.txn_date}
            onChange={(v) => setForm({ ...form, txn_date: v })}
            slotProps={{ textField: { fullWidth: true, margin: 'normal' } }}
          />
          <RadioGroup
            row
            value={form.txn_type}
            onChange={(e) => setForm({ ...form, txn_type: e.target.value })}
          >
            <FormControlLabel value="ADD" control={<Radio />} label="Add" />
            <FormControlLabel value="WITHDRAW" control={<Radio />} label="Withdraw" />
          </RadioGroup>
          <TextField
            fullWidth
            label="Amount"
            type="number"
            margin="normal"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            error={!!errors.amount}
            helperText={errors.amount}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave}>Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

/* ================= UI HELPERS ================= */

function SummaryTile({ label, value, color = 'text.primary', bold }) {
  return (
    <Box sx={{ px: 2.5, py: 1.5, border: '1px solid #e5e7eb', borderRadius: 2 }}>
      <Typography fontSize="0.75rem" color="#6b7280">{label}</Typography>
      <Typography fontSize="1.1rem" fontWeight={bold ? 700 : 600} color={color}>
        Rs. {formatINR(value)}
      </Typography>
    </Box>
  )
}

function Th({ children, align }) {
  return (
    <th style={{ textAlign: align, padding: '10px 16px', borderBottom: '1px solid #d1d5db' }}>
      {children}
    </th>
  )
}

function Td({ children, align, color, bold, bg }) {
  return (
    <td
      style={{
        textAlign: align,
        padding: '10px 16px',
        color,
        fontWeight: bold ? 600 : 400,
        background: bg,
        minWidth: 120,
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {children || '\u00A0'}
    </td>
  )
}

export default UserBalances
