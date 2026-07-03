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
  Typography
} from '@mui/material'
import { Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

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
    <Box>
      {/* SEARCH */}
      {!disableSearch && (
        <Box sx={{ mb: 1.25, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
          <TextField
            size="small"
            placeholder="Search..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            sx={{ width: 250 }}
          />

          <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', fontWeight: 700 }}>
            {filteredRows.length} records
          </Typography>
        </Box>
      )}

      {/* TABLE */}
      <Box sx={{ border: '1px solid var(--ao-border-soft)', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.paper' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map(col => (
                <TableCell key={col.field} align={col.align || 'left'}>
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

              {showStatus && <TableCell align="center">Status</TableCell>}
              {showActions && <TableCell align="center">Actions</TableCell>}
            </TableRow>
          </TableHead>

          <TableBody>
            {paginatedRows.map(row => (
              <TableRow key={row.id} hover>
                {columns.map(col => (
                  <TableCell key={col.field}>
                    {col.render ? col.render(row) : row[col.field]}
                  </TableCell>
                ))}

                {/* STATUS */}
                {showStatus && (
                  <TableCell align="center">
                    <Switch
                      size="small"
                      checked={!!row.active}
                      onChange={() => onStatusToggle?.(row)}
                    />
                  </TableCell>
                )}

                {/* ACTIONS */}
                {showActions && (
                  <TableCell align="center">
                    {onEdit && (
                      <IconButton size="small" onClick={() => onEdit(row)}>
                        <Pencil size={15} />
                      </IconButton>
                    )}
                    {onDelete && (
                      <IconButton size="small" onClick={() => onDelete(row)}>
                        <Trash2 size={15} />
                      </IconButton>
                    )}
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
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, val) => setPage(val)}
            size="small"
          />
        </Box>
      )}
    </Box>
  )
}

export default DataTable
