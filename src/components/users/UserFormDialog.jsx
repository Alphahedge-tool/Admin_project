import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Typography
} from '@mui/material'
import { useState, useEffect } from 'react'

function UserFormDialog({ open, onClose, onSave, initialData }) {
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    username: '',
    mf: false,
    equity: false,
    fno: false
  })

  const [error, setError] = useState('')

  useEffect(() => {
    if (initialData) {
      setForm(initialData)
    } else {
      setForm({
        first_name: '',
        last_name: '',
        username: '',
        mf: false,
        equity: false,
        fno: false
      })
    }
    setError('')
  }, [initialData, open])

  const handleSave = () => {
    if (!form.first_name || !form.last_name || !form.username) {
      setError('All fields are required')
      return
    }

    if (!form.mf && !form.equity && !form.fno) {
      setError('Select at least one segment')
      return
    }

    onSave(form)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {initialData ? 'Edit User' : 'Add User'}
      </DialogTitle>

      <DialogContent sx={{ pt: 2 }}>
        <TextField
          label="First Name"
          fullWidth
          margin="dense"
          value={form.first_name}
          onChange={(e) => setForm({ ...form, first_name: e.target.value })}
        />

        <TextField
          label="Last Name"
          fullWidth
          margin="dense"
          value={form.last_name}
          onChange={(e) => setForm({ ...form, last_name: e.target.value })}
        />

        <TextField
          label="Login Username"
          fullWidth
          margin="dense"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
        />

        <Typography sx={{ mt: 2, fontSize: '0.85rem', fontWeight: 600 }}>
          Segments
        </Typography>

        <FormGroup row>
          <FormControlLabel
            control={
              <Checkbox
                checked={form.mf}
                onChange={(e) => setForm({ ...form, mf: e.target.checked })}
              />
            }
            label="Mutual Funds"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={form.equity}
                onChange={(e) => setForm({ ...form, equity: e.target.checked })}
              />
            }
            label="Equities"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={form.fno}
                onChange={(e) => setForm({ ...form, fno: e.target.checked })}
              />
            }
            label="F&O"
          />
        </FormGroup>

        {error && (
          <Typography sx={{ color: '#dc2626', fontSize: '0.8rem', mt: 1 }}>
            {error}
          </Typography>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default UserFormDialog
