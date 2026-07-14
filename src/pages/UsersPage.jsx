import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormGroup,
  FormControlLabel,
  Checkbox,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Alert, 
  IconButton
} from '@mui/material'
import DataTable from '../components/common/DataTable'
import { apiGet, apiPost } from '../config/api'
import { refreshBrokerAccounts } from '../feedmaster/angelSessionStore'
import { Settings } from 'lucide-react'
import Tooltip from '@mui/material/Tooltip'

import BrokerConfigDialog from '../components/users/BrokerConfigDialog'


const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const mobileRegex = /^[0-9]{10}$/

function UsersPage() {
  /* ================= STATE ================= */
  const [users, setUsers] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [groupsLoading, setGroupsLoading] = useState(false)

  const [open, setOpen] = useState(false)
  const [errors, setErrors] = useState({})
  const [apiError, setApiError] = useState('')
  const [successInfo, setSuccessInfo] = useState(null)
  const [saving, setSaving] = useState(false)

  const [editingUser, setEditingUser] = useState(null)
  const [deleteUser, setDeleteUser] = useState(null)

  const [brokerUser, setBrokerUser] = useState(null)

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    username: '',
    email: '',
    mobile: '',
    group_name: '',
    password: '@welcome#123',
    segments: { mf: false, equity: false, fno: false },
    is_active: 1
  })

  /* ================= LOAD USERS ================= */
  const loadUsers = async () => {
    setLoading(true)
    try {
      const res = await apiGet('/users/list.php')

      const normalized = res.data.map(u => ({
        id: u.id,
        first_name: `${u.first_name} ${u.last_name}`,
        username: u.username,
        email: u.email,
        mobile: u.mobile,
        group_name: u.group_name ?? '',
        segments: {
          mf: Boolean(u.segment_mf),
          eq: Boolean(u.segment_equity),
          fo: Boolean(u.segment_fno)
        },
        active: Boolean(u.is_active)
      }))

      setUsers(normalized)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const loadGroups = async () => {
    setGroupsLoading(true)
    try {
      const res = await apiGet('/masters/groups/list.php')
      setGroups(res.data || [])
    } catch (e) {
      console.error(e)
      setGroups([])
    } finally {
      setGroupsLoading(false)
    }
  }

  useEffect(() => {
    loadUsers()
    loadGroups()
  }, [])

  /* ================= TABLE CONFIG ================= */
  const columns = [
    { field: 'first_name', label: 'Name', sortable: true },
    { field: 'username', label: 'Username', sortable: true },
    { field: 'email', label: 'Email', sortable: true },
    { field: 'mobile', label: 'Mobile', sortable: true },
    {
      field: 'group_name',
      label: 'Group',
      sortable: true,
      render: (row) => (
        row.group_name
          ? <SegmentChip label={row.group_name} bg="#eef2ff" color="#4338ca" />
          : <Typography variant="caption" color="text.secondary">No group</Typography>
      )
    },
    {
      field: 'segments',
      label: 'Segments',
      render: (row) => (
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {row.segments.mf && <SegmentChip label="MF" bg="#dbeafe" color="#1e40af" />}
          {row.segments.eq && <SegmentChip label="EQ" bg="#dcfce7" color="#166534" />}
          {row.segments.fo && <SegmentChip label="FO" bg="#fef3c7" color="#92400e" />}
        </Box>
      )
    },
    {
      field: 'broker_config',
      label: 'Broker Config',
      align: 'center',
      render: (row) => (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Tooltip title="Broker Configuration">
            <IconButton
              size="small"
              onClick={() => setBrokerUser(row)}
            >
              <Settings size={15} />
            </IconButton>
          </Tooltip>
        </Box>
      )
    }

  ]

  /* ================= HELPERS ================= */
  const handleChange = (field) => (e) => {
    setForm({ ...form, [field]: e.target.value })
  }

  const toggleSegment = (key) => {
    setForm({
      ...form,
      segments: { ...form.segments, [key]: !form.segments[key] }
    })
  }

  const validate = () => {
    const e = {}

    if (!form.firstName.trim()) e.firstName = 'First name required'
    if (!form.lastName.trim()) e.lastName = 'Last name required'
    if (!form.username.trim()) e.username = 'Username required'

    if (!form.email.trim()) e.email = 'Email required'
    else if (!emailRegex.test(form.email)) e.email = 'Invalid email'

    if (!form.mobile.trim()) e.mobile = 'Mobile required'
    else if (!mobileRegex.test(form.mobile)) e.mobile = 'Mobile must be 10 digits'

    if (!form.segments.mf && !form.segments.equity && !form.segments.fno) {
      e.segments = 'Select at least one segment'
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  /* ================= STATUS TOGGLE ================= */
  const handleStatusToggle = async (row) => {
  const newStatus = row.active ? 'Inactive' : 'Active'

  console.log('TOGGLE PAYLOAD', {
    id: row.id,
    status: newStatus
  })

  try {
    await apiPost('/users/toggle-status.php', {
      id: row.id
    })

    loadUsers()
  } catch (err) {
    console.error('Toggle failed:', err)
    alert('Failed to update status')
  }
}

  /* ================= EDIT ================= */
  const handleEdit = (row) => {
    setEditingUser(row)

    const parts = row.first_name.split(' ')
    setForm({
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
      username: row.username,
      email: row.email,
      mobile: row.mobile,
      group_name: row.group_name ?? '',
      password: '',
      segments: row.segments,
      is_active: row.active ? 1 : 0
    })

    setOpen(true)
  }

  /* ================= DELETE ================= */
const handleDelete = (row) => {
  setDeleteUser(row)
}

  /* ================= SAVE ================= */
  const handleSave = async () => {
    if (!validate()) return

    setSaving(true)
    setApiError('')

    try {
      const payload = {
        first_name: form.firstName,
        last_name: form.lastName,
        username: form.username,
        email: form.email,
        mobile: form.mobile,
        group_name: form.group_name || null,
        segment_mf: form.segments.mf,
        segment_equity: form.segments.equity,
        segment_fno: form.segments.fno,
        is_active: form.is_active
      }

      if (editingUser) {
        await apiPost('/users/update.php', { id: editingUser.id, ...payload })
      } else {
        const res = await apiPost('/users/create.php', payload)
        setSuccessInfo({ username: form.username, password: res.default_password })
      }

      setOpen(false)
      setEditingUser(null)
      loadUsers()
      resetForm()
      // Keep the session store's user list in step, so the new user is selectable
      // on the Trade Panel and Feedmaster without a reload.
      refreshBrokerAccounts().catch(() => {})
    } catch (err) {
      setApiError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setForm({
      firstName: '',
      lastName: '',
      username: '',
      email: '',
      mobile: '',
      group_name: '',
      password: '@welcome#123',
      segments: { mf: false, equity: false, fno: false },
      is_active: 1
    })
  }

  /* ================= RENDER ================= */
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h5" fontWeight={600}>Users</Typography>
        <Button variant="contained" onClick={() => setOpen(true)}>Add User</Button>
      </Box>

      {/* TABLE */}
      <Paper sx={{ flex: 1, p: 2 }}>
        <DataTable
          columns={columns}
          rows={users}
          showStatus
          onStatusToggle={handleStatusToggle}
          showActions
          onEdit={handleEdit}
          onDelete={handleDelete}
          pageSize={5}
        />
      </Paper>

      {/* ADD / EDIT DIALOG */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingUser ? 'Edit User' : 'Add New User'}</DialogTitle>

        <DialogContent>
          {apiError && <Alert severity="error">{apiError}</Alert>}

          <TextField fullWidth label="First Name" margin="normal"
            value={form.firstName} onChange={handleChange('firstName')}
            error={!!errors.firstName} helperText={errors.firstName}
          />
          <TextField fullWidth label="Last Name" margin="normal"
            value={form.lastName} onChange={handleChange('lastName')}
            error={!!errors.lastName} helperText={errors.lastName}
          />
          <TextField fullWidth label="Username" margin="normal"
            value={form.username} onChange={handleChange('username')}
            error={!!errors.username} helperText={errors.username}
          />
          <TextField fullWidth label="Email" margin="normal"
            value={form.email} onChange={handleChange('email')}
            error={!!errors.email} helperText={errors.email}
          />
          <TextField fullWidth label="Mobile" margin="normal"
            value={form.mobile} onChange={handleChange('mobile')}
            error={!!errors.mobile} helperText={errors.mobile}
          />
          <FormControl fullWidth margin="normal">
            <InputLabel shrink>Group (optional)</InputLabel>
            <Select
              displayEmpty
              value={form.group_name}
              label="Group (optional)"
              onChange={handleChange('group_name')}
              disabled={groupsLoading}
              renderValue={(selected) => (
                selected
                  ? <GroupOptionChip label={selected} />
                  : <Typography color="text.secondary">No group</Typography>
              )}
              MenuProps={{
                PaperProps: {
                  sx: {
                    mt: 0.75,
                    borderRadius: 1.5,
                    border: '1px solid #dbe3ee',
                    boxShadow: '0 18px 45px rgba(15, 23, 42, 0.16)',
                    overflow: 'hidden',
                    '& .MuiMenuItem-root': {
                      minHeight: 42,
                      px: 1.5,
                      py: 0.75,
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      '&:hover': {
                        bgcolor: '#f8fbff'
                      },
                      '&.Mui-selected': {
                        bgcolor: '#eef2ff',
                        '&:hover': { bgcolor: '#e0e7ff' }
                      }
                    }
                  }
                }
              }}
              sx={{
                borderRadius: 1.25,
                bgcolor: '#fff',
                '& .MuiOutlinedInput-notchedOutline': {
                  borderColor: '#d7deea'
                },
                '&:hover .MuiOutlinedInput-notchedOutline': {
                  borderColor: '#9fb1d1'
                },
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                  borderColor: '#4f63ff',
                  borderWidth: 2,
                  boxShadow: '0 0 0 3px rgba(79, 99, 255, 0.12)'
                },
                '& .MuiSelect-select': {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  minHeight: 26,
                  py: 1.25,
                  fontWeight: 700
                }
              }}
            >
              <MenuItem value="">
                <Typography color="text.secondary" sx={{ fontSize: '0.85rem', fontWeight: 600 }}>
                  {groupsLoading ? 'Loading groups...' : 'No group'}
                </Typography>
              </MenuItem>
              {groups.map((group) => (
                <MenuItem key={group.id} value={group.name}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                    <GroupOptionChip label={group.name} />
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography mt={2} fontWeight={500}>Segments</Typography>
          <FormGroup row>
            <FormControlLabel control={<Checkbox checked={form.segments.mf} onChange={() => toggleSegment('mf')} />} label="MF" />
            <FormControlLabel control={<Checkbox checked={form.segments.equity} onChange={() => toggleSegment('equity')} />} label="Equity" />
            <FormControlLabel control={<Checkbox checked={form.segments.fno} onChange={() => toggleSegment('fno')} />} label="F&O" />
          </FormGroup>
          {errors.segments && <Typography color="error">{errors.segments}</Typography>}

          <FormControl fullWidth margin="normal">
              <InputLabel>Active</InputLabel>
              <Select
                value={form.is_active}
                label="Active"
                onChange={(e) =>
                  setForm({ ...form, is_active: Number(e.target.value) })
                }
              >
                <MenuItem value={1}>Active</MenuItem>
                <MenuItem value={0}>Inactive</MenuItem>
              </Select>
            </FormControl>
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} disabled={saving}>Save</Button>
        </DialogActions>
      </Dialog>

      {/* DELETE CONFIRM */}
      <Dialog open={!!deleteUser} onClose={() => setDeleteUser(null)}>
        <DialogTitle>Delete User</DialogTitle>
        <DialogContent>
          Are you sure you want to delete <b>{deleteUser?.username}</b>?
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteUser(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={async () => {
            await apiPost('/users/delete.php', { id: deleteUser.id })
            setDeleteUser(null)
            loadUsers()
            refreshBrokerAccounts().catch(() => {})
          }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* SUCCESS */}
      {successInfo && (
        <Dialog open onClose={() => setSuccessInfo(null)}>
          <DialogTitle>User Created</DialogTitle>
          <DialogContent>
            <Alert severity="success">
              User <b>{successInfo.username}</b> created.<br /><br />
              <b>Default Password:</b> {successInfo.password}
            </Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setSuccessInfo(null)}>OK</Button>
          </DialogActions>
        </Dialog>
      )}

      {/* BROKER CONFIG DIALOG (STEP 2 PLACEHOLDER) */}
      <BrokerConfigDialog
        key={brokerUser?.id || 'broker-config'}
        open={!!brokerUser}
        user={brokerUser}
        onClose={() => setBrokerUser(null)}
      />

 
    </Box>
  )
}

/* ================= SEGMENT CHIP ================= */
function SegmentChip({ label, bg, color }) {
  return (
    <Box sx={{
      px: 1,
      py: '2px',
      fontSize: '0.7rem',
      borderRadius: 1,
      background: bg,
      color,
      fontWeight: 600
    }}>
      {label}
    </Box>
  )
}

function GroupOptionChip({ label }) {
  return (
    <Box sx={{
      px: 1.15,
      py: '5px',
      borderRadius: 1.25,
      border: '1px solid #c7d2fe',
      background: 'linear-gradient(180deg, #f8fbff 0%, #eef2ff 100%)',
      color: '#3730a3',
      fontSize: '0.75rem',
      fontWeight: 800,
      lineHeight: 1,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9)'
    }}>
      {label}
    </Box>
  )
}

export default UsersPage
