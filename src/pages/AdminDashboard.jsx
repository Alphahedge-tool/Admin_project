import { Typography } from '@mui/material'

function AdminDashboard() {
  return (
    <>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Admin Dashboard
      </Typography>

      <Typography color="text.secondary">
        This will show overall AUM, users, portfolios, and system health.
      </Typography>
    </>
  )
}

export default AdminDashboard
