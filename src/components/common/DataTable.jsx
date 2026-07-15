import {
  Box,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  TableSortLabel,
  IconButton,
  TextField,
  Switch,
  Pagination,
  Typography,
  InputAdornment,
  Tooltip
} from '@mui/material'
import { Pencil, Trash2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

// Shared cell padding so every column breathes the same, with a little extra
// room at the row's edges (Dhan-style gutters) instead of text hard against
// the border.
const bodyCellSx = {
  py: 1.5,
  '&:first-of-type': { pl: 2.5 },
  '&:last-of-type': { pr: 2.5 },
}
const headCellSx = {
  py: 1.5,
  position: 'sticky',
  top: 0,
  zIndex: 2,
  whiteSpace: 'nowrap',
  '&:first-of-type': { pl: 2.5 },
  '&:last-of-type': { pr: 2.5 },
}

function DataTable({
  columns = [],
  rows = [],
  pageSize = 5,

  /* STATUS */
  showStatus = false,
  onStatusToggle,

  /* ACTIONS */
  showActions = true,
  onEdit,
  onDelete,

  /* OPTIONAL */
  disableSearch = false,
  disablePagination = false
}) {
  const [orderBy, setOrderBy] = useState(null)
  const [order, setOrder] = useState('asc')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const handleSort = (field) => {
    if (orderBy === field) {
      setOrder(order === 'asc' ? 'desc' : 'asc')
    } else {
      setOrderBy(field)
      setOrder('asc')
    }
  }

  /* ================= FILTER ================= */
  const filteredRows = useMemo(() => {
    if (disableSearch || !search) return rows

    return rows.filter(row =>
      Object.values(row)
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase())
    )
  }, [rows, search, disableSearch])

  /* ================= SORT ================= */
  const sortedRows = useMemo(() => {
    if (!orderBy) return filteredRows

    return [...filteredRows].sort((a, b) => {
      const aVal = a[orderBy]
      const bVal = b[orderBy]

      if (aVal == null) return 1
      if (bVal == null) return -1

      return order === 'asc'
        ? aVal > bVal ? 1 : -1
        : aVal < bVal ? 1 : -1
    })
  }, [filteredRows, orderBy, order])

  /* ================= PAGINATION ================= */
  const totalPages = Math.ceil(sortedRows.length / pageSize)

  const paginatedRows = disablePagination
    ? sortedRows
    : sortedRows.slice((page - 1) * pageSize, page * pageSize)

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* SEARCH */}
      {!disableSearch && (
        <Box sx={{ flex: 'none', mb: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
          <TextField
            size="small"
            placeholder="Search..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start" sx={{ mr: 0.75 }}>
                  <Search size={14} color="var(--ao-caption)" />
                </InputAdornment>
              ),
            }}
            sx={{
              width: 240,
              '& .MuiOutlinedInput-root': { minHeight: 32, borderRadius: 1.5, bgcolor: 'var(--ao-surface)' },
              '& .MuiOutlinedInput-input': { py: 0.5, fontSize: '0.8125rem' },
            }}
          />

          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 0.5,
              px: 1.25,
              py: 0.5,
              borderRadius: 999,
              bgcolor: 'var(--ao-surface-2)',
              border: '1px solid var(--ao-border-soft)',
            }}
          >
            <Typography component="span" sx={{ fontSize: '0.8125rem', color: 'text.primary', fontWeight: 800 }}>
              {filteredRows.length}
            </Typography>
            <Typography component="span" sx={{ fontSize: '0.6875rem', color: 'text.secondary', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {filteredRows.length === 1 ? 'record' : 'records'}
            </Typography>
          </Box>
        </Box>
      )}

      {/* TABLE */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--ao-border-soft)', borderRadius: 1.5, bgcolor: 'background.paper' }}>
        <Table size="small" stickyHeader sx={{ '& tbody tr:last-of-type td': { borderBottom: 0 } }}>
          <TableHead>
            <TableRow>
              {columns.map(col => (
                <TableCell key={col.field} align={col.align || 'left'} sx={headCellSx}>
                  {col.sortable ? (
                    <TableSortLabel
                      active={orderBy === col.field}
                      direction={order}
                      onClick={() => handleSort(col.field)}
                    >
                      {col.label}
                    </TableSortLabel>
                  ) : (
                    col.label
                  )}
                </TableCell>
              ))}

              {showStatus && <TableCell align="center" sx={headCellSx}>Status</TableCell>}
              {showActions && <TableCell align="center" sx={headCellSx}>Actions</TableCell>}
            </TableRow>
          </TableHead>

          <TableBody>
            {paginatedRows.map(row => (
              <TableRow key={row.id} hover>
                {columns.map(col => (
                  <TableCell key={col.field} align={col.align || 'left'} sx={bodyCellSx}>
                    {col.render ? col.render(row) : row[col.field]}
                  </TableCell>
                ))}

                {/* STATUS */}
                {showStatus && (
                  <TableCell align="center" sx={bodyCellSx}>
                    <Switch
                      size="small"
                      checked={!!row.active}
                      onChange={() => onStatusToggle?.(row)}
                    />
                  </TableCell>
                )}

                {/* ACTIONS */}
                {showActions && (
                  <TableCell align="center" sx={bodyCellSx}>
                    <Box sx={{ display: 'inline-flex', gap: 0.25 }}>
                      {onEdit && (
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            onClick={() => onEdit(row)}
                            sx={{ '&:hover': { color: 'primary.main', bgcolor: 'var(--ao-blue-bg)' } }}
                          >
                            <Pencil size={15} />
                          </IconButton>
                        </Tooltip>
                      )}
                      {onDelete && (
                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            onClick={() => onDelete(row)}
                            sx={{ '&:hover': { color: 'error.main', bgcolor: 'var(--ao-red-bg)' } }}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  </TableCell>
                )}
              </TableRow>
            ))}

            {paginatedRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={
                    columns.length +
                    (showStatus ? 1 : 0) +
                    (showActions ? 1 : 0)
                  }
                  align="center"
                  sx={{ py: 6, color: 'text.secondary', fontWeight: 600 }}
                >
                  No records found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Box>

      {/* PAGINATION */}
      {!disablePagination && totalPages > 1 && (
        <Box sx={{ flex: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1.5, px: 0.5 }}>
          <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', fontWeight: 600 }}>
            Page {page} of {totalPages}
          </Typography>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, val) => setPage(val)}
            size="small"
            shape="rounded"
            sx={{
              '& .MuiPaginationItem-root': {
                fontWeight: 700,
                borderRadius: 1.5,
              },
              '& .Mui-selected': {
                bgcolor: 'var(--ao-blue) !important',
                color: '#fff',
              },
            }}
          />
        </Box>
      )}
    </Box>
  )
}

export default DataTable
