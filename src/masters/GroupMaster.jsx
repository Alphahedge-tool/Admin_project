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
  Alert,
  Link,
  CircularProgress,
  Divider,
  IconButton
} from '@mui/material'
import DataTable from '../components/common/DataTable'
import { apiGet, apiPost } from '../config/api'
import { UsersRound, X } from 'lucide-react'

function GroupMaster() {
  /* ================= STATE ================= */
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleteRow, setDeleteRow] = useState(null)

  const [groupName, setGroupName] = useState('')
  const [error, setError] = useState('')

  /* users-under-group viewer */
  const [viewGroup, setViewGroup] = useState(null)
  const [groupUsers, setGroupUsers] = useState([])
  const [usersLoading, setUsersLoading] = useState(false)

  /* ================= LOAD ================= */
  const loadGroups = async () => {
    setLoading(true)
    try {
      const res = await apiGet('/masters/groups/list.php')
      setGroups(res.data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadGroups()
  }, [])

  /* ================= VIEW USERS UNDER GROUP ================= */
  const handleViewUsers = async (group) => {
    setViewGroup(group)
    setUsersLoading(true)
    setGroupUsers([])
    try {
      const res = await apiGet(`/masters/groups/users.php?group_id=${group.id}`)
      setGroupUsers(res.data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setUsersLoading(false)
    }
  }

  /* ================= TABLE ================= */
  const columns = [
    {
      field: 'name',
      label: 'Group Name',
      sortable: true,
      render: (row) => (
        <Link
          component="button"
          type="button"
          underline="hover"
          sx={{ fontWeight: 600, textAlign: 'left' }}
          onClick={() => handleViewUsers(row)}
        >
          {row.name}
        </Link>
      )
    }
  ]

  /* ================= SAVE ================= */
  const handleSave = async () => {
    if (!groupName.trim()) {
      setError('Group name is required')
      return
    }

    try {
      if (editing) {
        await apiPost('/masters/groups/update.php', {
          id: editing.id,
          name: groupName
        })
      } else {
        await apiPost('/masters/groups/create.php', {
          name: groupName
        })
      }

      setOpen(false)
      setEditing(null)
      setGroupName('')
      setError('')
      loadGroups()
    } catch (err) {
      setError(err.message || 'Failed to save group')
    }
  }

  /* ================= EDIT ================= */
  const handleEdit = (row) => {
    setEditing(row)
    setGroupName(row.name)
    setOpen(true)
  }

  /* ================= DELETE ================= */
  const handleDelete = (row) => {
    setDeleteRow(row)
  }

  const activeGroupUsers = groupUsers.filter((user) => Number(user.is_active)).length
  const groupSegmentCounts = {
    mf: groupUsers.filter((user) => user.segment_mf).length,
    eq: groupUsers.filter((user) => user.segment_equity).length,
    fo: groupUsers.filter((user) => user.segment_fno).length
  }

  /* ================= RENDER ================= */
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h5" fontWeight={600}>
          Group Master
        </Typography>
        <Button variant="contained" onClick={() => setOpen(true)}>
          ADD GROUP
        </Button>
      </Box>

      {/* TABLE */}
      <Paper sx={{ flex: 1, p: 2 }}>
        <DataTable
          columns={columns}
          rows={groups}
          loading={loading}
          showStatus={false}
          showActions
          onEdit={handleEdit}
          onDelete={handleDelete}
          pageSize={5}
        />
      </Paper>

      {/* ADD / EDIT */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{editing ? 'Edit Group' : 'Add Group'}</DialogTitle>

        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <TextField
            fullWidth
            label="Group Name"
            placeholder="Enter group name"
            value={groupName}
            margin="normal"
            onChange={(e) => setGroupName(e.target.value)}
            slotProps={{
              inputLabel: {
                shrink: true
              }
            }}
          />
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* DELETE CONFIRM */}
      <Dialog open={!!deleteRow} onClose={() => setDeleteRow(null)}>
        <DialogTitle>Delete Group</DialogTitle>
        <DialogContent>
          Are you sure you want to delete <b>{deleteRow?.name}</b>?
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteRow(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={async () => {
              await apiPost('/masters/groups/delete.php', { id: deleteRow.id })
              setDeleteRow(null)
              loadGroups()
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* USERS UNDER GROUP */}
      <Dialog
        open={!!viewGroup}
        onClose={() => setViewGroup(null)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            overflow: 'hidden',
            boxShadow: '0 28px 80px rgba(15, 23, 42, 0.28)'
          }
        }}
      >
        <DialogTitle sx={{
          px: 3,
          py: 2.25,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          background: 'linear-gradient(180deg, var(--ao-blue-bg) 0%, var(--ao-surface) 100%)',
          borderBottom: '1px solid var(--ao-border-soft)'
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
            <Box sx={{
              width: 38,
              height: 38,
              borderRadius: 1.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'primary.main',
              background: 'var(--ao-blue-bg)',
              border: '1px solid var(--ao-border)'
            }}>
              <UsersRound size={19} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: '1.05rem', fontWeight: 800, color: 'text.primary', lineHeight: 1.2 }}>
                Users in {viewGroup?.name}
              </Typography>
              <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', fontWeight: 650, mt: 0.35 }}>
                Group membership details and assigned segments
              </Typography>
            </Box>
          </Box>

          <IconButton size="small" onClick={() => setViewGroup(null)} sx={{
            width: 32,
            height: 32,
            border: '1px solid var(--ao-border)',
            borderRadius: 1,
            color: 'text.secondary'
          }}>
            <X size={16} />
          </IconButton>
        </DialogTitle>

        <DialogContent sx={{ px: 3, py: 2.25, bgcolor: 'background.paper' }}>
          {usersLoading ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 5 }}>
              <CircularProgress />
              <Typography sx={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 650 }}>
                Loading group users...
              </Typography>
            </Box>
          ) : groupUsers.length === 0 ? (
            <Alert severity="info" sx={{ mt: 1, borderRadius: 1.5 }}>
              No users are registered under this group.
            </Alert>
          ) : (
            <>
            <Box sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
              gap: 1.25,
              mb: 2
            }}>
              <GroupMetric label="Total Users" value={groupUsers.length} helper={`${activeGroupUsers} active`} tone="blue" />
              <GroupMetric label="Segments" value={groupSegmentCounts.mf + groupSegmentCounts.eq + groupSegmentCounts.fo} helper={`MF ${groupSegmentCounts.mf} / EQ ${groupSegmentCounts.eq} / FO ${groupSegmentCounts.fo}`} tone="green" />
              <GroupMetric label="Group" value={viewGroup?.name || '-'} helper="Selected from Group Master" tone="purple" />
            </Box>

            <Divider sx={{ mb: 1.75 }} />

            <DataTable
              columns={[
                {
                  field: 'name',
                  label: 'Name',
                  render: (r) => <UserNameCell user={r} />
                },
                {
                  field: 'username',
                  label: 'Username',
                  render: (r) => <SoftText value={r.username} />
                },
                {
                  field: 'email',
                  label: 'Email',
                  render: (r) => <SoftText value={r.email} />
                },
                {
                  field: 'mobile',
                  label: 'Mobile',
                  render: (r) => <SoftText value={r.mobile} />
                },
                {
                  field: 'segments',
                  label: 'Segments',
                  render: (r) =>
                    [
                      r.segment_mf ? 'MF' : null,
                      r.segment_equity ? 'EQ' : null,
                      r.segment_fno ? 'FO' : null
                    ]
                      .filter(Boolean)
                      .join(', ') || '—'
                },
                {
                  field: 'is_active',
                  label: 'Status',
                  render: (r) => <StatusPill active={Number(r.is_active)} />
                }
              ]}
              rows={groupUsers}
              showStatus={false}
              showActions={false}
              pageSize={5}
            />
            </>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.75, borderTop: '1px solid #e5eaf3', bgcolor: '#fbfcff' }}>
          <Button variant="contained" onClick={() => setViewGroup(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

function GroupMetric({ label, value, helper, tone }) {
  const colors = {
    blue: ['#eff6ff', '#bfdbfe', '#1d4ed8'],
    green: ['#ecfdf5', '#bbf7d0', '#15803d'],
    purple: ['#f5f3ff', '#ddd6fe', '#6d28d9']
  }[tone] || ['#f8fafc', '#e2e8f0', '#334155']

  return (
    <Box sx={{
      p: 1.5,
      borderRadius: 1.5,
      border: `1px solid ${colors[1]}`,
      background: colors[0]
    }}>
      <Typography sx={{ fontSize: '0.7rem', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </Typography>
      <Typography sx={{ mt: 0.45, fontSize: '1rem', fontWeight: 850, color: colors[2], lineHeight: 1.25 }} noWrap>
        {value}
      </Typography>
      <Typography sx={{ mt: 0.25, fontSize: '0.72rem', fontWeight: 650, color: '#64748b' }} noWrap>
        {helper}
      </Typography>
    </Box>
  )
}

function UserNameCell({ user }) {
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '-'
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box sx={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: '#eef2ff',
        color: '#4338ca',
        fontSize: '0.72rem',
        fontWeight: 850
      }}>
        {initials}
      </Box>
      <Typography sx={{ fontSize: '0.8rem', fontWeight: 750, color: '#1f2937' }}>
        {name}
      </Typography>
    </Box>
  )
}

function StatusPill({ active }) {
  return (
    <Box sx={{
      display: 'inline-flex',
      alignItems: 'center',
      px: 1,
      py: '4px',
      borderRadius: 99,
      bgcolor: active ? '#dcfce7' : '#fee2e2',
      color: active ? '#166534' : '#991b1b',
      fontSize: '0.7rem',
      fontWeight: 850
    }}>
      {active ? 'Active' : 'Inactive'}
    </Box>
  )
}

function SoftText({ value }) {
  return (
    <Typography sx={{ fontSize: '0.78rem', color: '#475569', fontWeight: 650 }}>
      {value || '-'}
    </Typography>
  )
}

export default GroupMaster
