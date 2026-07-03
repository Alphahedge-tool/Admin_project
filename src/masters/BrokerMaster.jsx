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

function BrokerMaster() {
  /* ================= STATE ================= */
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(true)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleteRow, setDeleteRow] = useState(null)

  const [brokerName, setBrokerName] = useState('')
  const [error, setError] = useState('')

  /* ================= LOAD ================= */
  const loadBrokers = async () => {
    setLoading(true)
    try {
      const res = await apiGet('/masters/brokers/list.php')
      setBrokers(res.data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBrokers()
  }, [])

  /* ================= TABLE ================= */
  const columns = [
    { field: 'name', label: 'Broker Name', sortable: true }
  ]

  /* ================= SAVE ================= */
  const handleSave = async () => {
    if (!brokerName.trim()) {
      setError('Broker name is required')
      return
    }

    try {
      if (editing) {
        await apiPost('/masters/brokers/update.php', {
          id: editing.id,
          name: brokerName
        })
      } else {
        await apiPost('/masters/brokers/create.php', {
          name: brokerName
        })
      }

      setOpen(false)
      setEditing(null)
      setBrokerName('')
      setError('')
      loadBrokers()
    } catch (err) {
      setError(err.message || 'Failed to save broker')
    }
  }

  /* ================= EDIT ================= */
  const handleEdit = (row) => {
    setEditing(row)
    setBrokerName(row.name)
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
          Broker Master
        </Typography>
        <Button variant="contained" onClick={() => setOpen(true)}>
          ADD BROKER
        </Button>
      </Box>

      {/* TABLE */}
      <Paper sx={{ flex: 1, p: 2 }}>
        <DataTable
          columns={columns}
          rows={brokers}
          showStatus={false}
          showActions
          onEdit={handleEdit}
          onDelete={handleDelete}
          pageSize={5}
        />


      </Paper>

      {/* ADD / EDIT */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{editing ? 'Edit Broker' : 'Add Broker'}</DialogTitle>

        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <TextField
            fullWidth
            label="Broker Name"
            placeholder="Enter broker name"
            value={brokerName}
            margin="normal"
            onChange={(e) => setBrokerName(e.target.value)}
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
        <DialogTitle>Delete Broker</DialogTitle>
        <DialogContent>
          Are you sure you want to delete <b>{deleteRow?.name}</b>?
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteRow(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={async () => {
              await apiPost('/masters/brokers/delete.php', { id: deleteRow.id })
              setDeleteRow(null)
              loadBrokers()
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default BrokerMaster
