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
  Alert
} from '@mui/material'
import DataTable from '../components/common/DataTable'
import { apiGet, apiPost } from '../config/api'

function GroupMaster() {
  /* ================= STATE ================= */
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleteRow, setDeleteRow] = useState(null)

  const [groupName, setGroupName] = useState('')
  const [error, setError] = useState('')

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

  /* ================= TABLE ================= */
  const columns = [
    { field: 'name', label: 'Group Name', sortable: true }
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
    </Box>
  )
}

export default GroupMaster
