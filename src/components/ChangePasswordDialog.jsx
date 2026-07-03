import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Typography,
  Box
} from '@mui/material'
import { useState, useEffect } from 'react'
import { apiPost } from '../config/api'

function ChangePasswordDialog({ open, onClose }) {
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setOldPwd('')
      setNewPwd('')
      setError('')
      setLoading(false)
    }
  }, [open])

  const handleSubmit = async () => {
    setError('')

    if (!oldPwd || !newPwd) {
      setError('Both old and new password are required')
      return
    }

    setLoading(true)

    try {
      const res = await apiPost('/auth/change-password.php', {
        old_password: oldPwd,
        new_password: newPwd
      })

      if (!res || res.success !== true) {
        setError(res?.message || 'Unable to change password')
        setLoading(false)
        return
      }

      // Success
      onClose()
    } catch (err) {
      setError('Unable to reach server. Please try again.')
    }

    setLoading(false)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle sx={{ fontWeight: 600 }}>
        Change Password
      </DialogTitle>

      <DialogContent sx={{ pt: 2 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            type="password"
            label="Old Password"
            fullWidth
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
          />

          <TextField
            type="password"
            label="New Password"
            fullWidth
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
          />

          {error && (
            <Typography
              sx={{
                fontSize: '0.8rem',
                color: '#dc2626'
              }}
            >
              {error}
            </Typography>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          type="button"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"          // 🔥 REQUIRED
          variant="contained"
          onClick={handleSubmit}
          disabled={loading}
        >
          Update
        </Button>

      </DialogActions>
    </Dialog>
  )
}

export default ChangePasswordDialog
