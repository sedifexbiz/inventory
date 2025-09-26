import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  limit,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { Timestamp } from 'firebase/firestore'
import { Link } from 'react-router-dom'
import { db } from '../firebase'
import { useActiveStore } from '../hooks/useActiveStore'
import './Customers.css'
import { AccessDenied } from '../components/AccessDenied'
import { canAccessFeature } from '../utils/permissions'
import {
  CUSTOMER_CACHE_LIMIT,
  SALES_CACHE_LIMIT,
  loadCachedCustomers,
  loadCachedSales,
  saveCachedCustomers,
  saveCachedSales,
} from '../utils/offlineCache'

type Customer = {
  id: string
  name: string
  phone?: string
  email?: string
  notes?: string
  tags?: string[]
  createdAt?: Timestamp | null
  updatedAt?: Timestamp | null
}

type SaleHistoryEntry = {
  id: string
  total: number
  createdAt: Date | null
  paymentMethod?: string | null
  items: { name?: string | null; qty?: number | null }[]
}

type CustomerStats = {
  visits: number
  totalSpend: number
  lastVisit: Date | null
}

const RECENT_VISIT_DAYS = 90
const HIGH_VALUE_THRESHOLD = 1000

function normalizeTags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
        .map(tag => tag.replace(/^#/, ''))
    )
  )
}

function formatDate(date: Date | null): string {
  if (!date) return '—'
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let row: string[] = []
  let insideQuotes = false

  const pushValue = () => {
    row.push(current)
    current = ''
  }

  const pushRow = () => {
    if (!row.length) return
    rows.push(row.map(cell => cell.trim()))
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (insideQuotes && text[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        insideQuotes = !insideQuotes
      }
    } else if (char === ',' && !insideQuotes) {
      pushValue()
    } else if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      pushValue()
      if (row.some(cell => cell.trim().length > 0)) {
        pushRow()
      } else {
        row = []
      }
    } else {
      current += char
    }
  }

  if (current.length > 0 || row.length > 0) {
    pushValue()
    if (row.some(cell => cell.trim().length > 0)) {
      pushRow()
    }
  }

  return rows
}

function buildCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export default function Customers() {
  const { storeId: STORE_ID, role, isLoading: storeLoading, error: storeError } = useActiveStore()

  const [customers, setCustomers] = useState<Customer[]>([])
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const messageTimeoutRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(null)
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null)
  const [customerStats, setCustomerStats] = useState<Record<string, CustomerStats>>({})
  const [salesHistory, setSalesHistory] = useState<Record<string, SaleHistoryEntry[]>>({})
  const [searchTerm, setSearchTerm] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [quickFilter, setQuickFilter] = useState<'all' | 'recent' | 'noPurchases' | 'highValue' | 'untagged'>('all')
  const hasAccess = canAccessFeature(role, 'customers')

  useEffect(() => {
    return () => {
      if (messageTimeoutRef.current) {
        window.clearTimeout(messageTimeoutRef.current)
        messageTimeoutRef.current = null
      }
    }
  }, [])

  function showSuccess(message: string) {
    setSuccess(message)
    if (messageTimeoutRef.current) {
      window.clearTimeout(messageTimeoutRef.current)
    }
    messageTimeoutRef.current = window.setTimeout(() => {
      setSuccess(null)
      messageTimeoutRef.current = null
    }, 4000)
  }

  useEffect(() => {
    if (!STORE_ID || !hasAccess) return
    let cancelled = false

    loadCachedCustomers<Customer>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          setCustomers(
            [...cached].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
          )
        }
      })
      .catch(error => {
        console.warn('[customers] Failed to load cached customers', error)
      })

    const q = query(
      collection(db, 'customers'),
      where('storeId', '==', STORE_ID),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(CUSTOMER_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snap => {
      const rows = snap.docs.map(docSnap => {
        const data = docSnap.data() as Omit<Customer, 'id'>
        return {
          id: docSnap.id,
          ...data,
        }
      })
      saveCachedCustomers(STORE_ID, rows).catch(error => {
        console.warn('[customers] Failed to cache customers', error)
      })
      const sortedRows = [...rows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
      setCustomers(sortedRows)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [STORE_ID, hasAccess])

  function normalizeSaleDate(value: unknown): Date | null {
    if (!value) return null
    if (value instanceof Date) return value
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value)
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? null : new Date(parsed)
    }
    if (typeof value === 'object') {
      const anyValue = value as { toDate?: () => Date; seconds?: number; nanoseconds?: number }
      if (typeof anyValue.toDate === 'function') {
        try {
          return anyValue.toDate()
        } catch (error) {
          console.warn('[customers] Failed to convert timestamp via toDate', error)
        }
      }
      if (typeof anyValue.seconds === 'number') {
        const millis = anyValue.seconds * 1000 + Math.round((anyValue.nanoseconds ?? 0) / 1_000_000)
        return Number.isFinite(millis) ? new Date(millis) : null
      }
    }
    return null
  }

  function applySalesData(records: Array<{ id: string } & Record<string, any>>) {
    const statsMap: Record<string, CustomerStats> = {}
    const historyMap: Record<string, SaleHistoryEntry[]> = {}

    records.forEach(record => {
      const data = record || {}
      const customerId = data?.customer?.id
      if (!customerId) return

      const createdAt = normalizeSaleDate(data?.createdAt)
      const total = Number(data?.total ?? 0) || 0
      const paymentMethod = data?.payment?.method ?? null
      const items = Array.isArray(data?.items) ? data.items : []

      if (!statsMap[customerId]) {
        statsMap[customerId] = { visits: 0, totalSpend: 0, lastVisit: null }
      }
      const stats = statsMap[customerId]
      stats.visits += 1
      stats.totalSpend += total
      if (!stats.lastVisit || (createdAt && stats.lastVisit < createdAt)) {
        stats.lastVisit = createdAt ?? stats.lastVisit
      }

      const entry: SaleHistoryEntry = {
        id: record.id,
        total,
        createdAt,
        paymentMethod,
        items: items.map(item => ({
          name: item?.name ?? null,
          qty: item?.qty ?? null,
        })),
      }

      historyMap[customerId] = [...(historyMap[customerId] ?? []), entry]
    })

    Object.keys(historyMap).forEach(customerId => {
      historyMap[customerId] = historyMap[customerId].sort((a, b) => {
        const aTime = a.createdAt?.getTime?.() ?? 0
        const bTime = b.createdAt?.getTime?.() ?? 0
        return bTime - aTime
      })
    })

    setCustomerStats(statsMap)
    setSalesHistory(historyMap)
  }

  useEffect(() => {
    if (!STORE_ID || !hasAccess) return
    let cancelled = false

    loadCachedSales<{ id: string } & Record<string, any>>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          applySalesData(cached)
        }
      })
      .catch(error => {
        console.warn('[customers] Failed to load cached sales', error)
      })

    const q = query(
      collection(db, 'sales'),
      where('storeId', '==', STORE_ID),
      orderBy('createdAt', 'desc'),
      limit(SALES_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snapshot => {
      const rows = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...(docSnap.data() as any) }))
      applySalesData(rows)
      saveCachedSales(STORE_ID, rows).catch(error => {
        console.warn('[customers] Failed to cache sales', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [STORE_ID, hasAccess])

  useEffect(() => {
    if (!selectedCustomerId) return
    const exists = customers.some(customer => customer.id === selectedCustomerId)
    if (!exists) {
      setSelectedCustomerId(null)
    }
  }, [customers, selectedCustomerId])

  useEffect(() => {
    if (!editingCustomerId) return
    const exists = customers.some(customer => customer.id === editingCustomerId)
    if (!exists) {
      setEditingCustomerId(null)
    }
  }, [customers, editingCustomerId])

  const currencyFormatter = useMemo(
    () =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'GHS',
        minimumFractionDigits: 2,
      }),
    []
  )

  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    customers.forEach(customer => {
      if (Array.isArray(customer.tags)) {
        customer.tags.forEach(tag => tagSet.add(tag))
      }
    })
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b))
  }, [customers])

  const filteredCustomers = useMemo(() => {
    const search = searchTerm.trim().toLowerCase()
    return customers.filter(customer => {
      const matchesSearch = search
        ? [customer.name, customer.email, customer.phone, customer.notes]
            .filter(Boolean)
            .some(value => value!.toLowerCase().includes(search))
        : true

      const matchesTag = tagFilter ? customer.tags?.includes(tagFilter) : true
      const stats = customerStats[customer.id]

      let matchesQuick = true
      switch (quickFilter) {
        case 'recent': {
          if (!stats?.lastVisit) {
            matchesQuick = false
            break
          }
          const diffMs = Date.now() - stats.lastVisit.getTime()
          const diffDays = diffMs / (1000 * 60 * 60 * 24)
          matchesQuick = diffDays <= RECENT_VISIT_DAYS
          break
        }
        case 'noPurchases':
          matchesQuick = (stats?.visits ?? 0) === 0
          break
        case 'highValue':
          matchesQuick = (stats?.totalSpend ?? 0) >= HIGH_VALUE_THRESHOLD
          break
        case 'untagged':
          matchesQuick = !(customer.tags?.length)
          break
        default:
          matchesQuick = true
      }

      return matchesSearch && matchesTag && matchesQuick
    })
  }, [customers, searchTerm, tagFilter, quickFilter, customerStats])

  const selectedCustomer = selectedCustomerId
    ? customers.find(customer => customer.id === selectedCustomerId) ?? null
    : null

  const selectedCustomerHistory = selectedCustomerId
    ? salesHistory[selectedCustomerId] ?? []
    : []

  const selectedCustomerStats = selectedCustomerId
    ? customerStats[selectedCustomerId] ?? { visits: 0, totalSpend: 0, lastVisit: null }
    : { visits: 0, totalSpend: 0, lastVisit: null }

  function resetForm() {
    setName('')
    setPhone('')
    setEmail('')
    setNotes('')
    setTagsInput('')
    setEditingCustomerId(null)
    setError(null)
  }

  async function addCustomer(event: React.FormEvent) {
    event.preventDefault()
    if (!STORE_ID) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Customer name is required to save a record.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const parsedTags = normalizeTags(tagsInput)
      if (editingCustomerId) {
        const updatePayload: Record<string, unknown> = {
          name: trimmedName,
          updatedAt: serverTimestamp(),
        }
        updatePayload.phone = phone.trim() ? phone.trim() : null
        updatePayload.email = email.trim() ? email.trim() : null
        updatePayload.notes = notes.trim() ? notes.trim() : null
        updatePayload.tags = parsedTags
        await updateDoc(doc(db, 'customers', editingCustomerId), updatePayload)
        setSelectedCustomerId(editingCustomerId)
        showSuccess('Customer updated successfully.')
      } else {
        await addDoc(collection(db, 'customers'), {
          storeId: STORE_ID,
          name: trimmedName,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(parsedTags.length ? { tags: parsedTags } : {}),
          createdAt: serverTimestamp(),
        })
        showSuccess('Customer saved successfully.')
      }
      resetForm()
    } catch (err) {
      console.error('[customers] Unable to save customer', err)
      setError('We could not save this customer. Please try again.')
      setSuccess(null)
    } finally {
      setBusy(false)
    }
  }

  async function removeCustomer(id: string) {
    if (!id) return
    const confirmation = window.confirm('Remove this customer?')
    if (!confirmation) return
    setBusy(true)
    try {
      await deleteDoc(doc(db, 'customers', id))
      showSuccess('Customer removed.')
      if (selectedCustomerId === id) {
        setSelectedCustomerId(null)
      }
      if (editingCustomerId === id) {
        resetForm()
      }
    } catch (err) {
      console.error('[customers] Unable to delete customer', err)
      setError('Unable to delete this customer right now.')
      setSuccess(null)
    } finally {
      setBusy(false)
    }
  }

  async function handleCsvImport(event: React.ChangeEvent<HTMLInputElement>) {
    if (!STORE_ID) return
    const file = event.target.files?.[0]
    if (!file) return
    setIsImporting(true)
    setError(null)
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (!rows.length) {
        throw new Error('No rows detected in the file.')
      }

      const [header, ...dataRows] = rows
      const headers = header.map(cell => cell.toLowerCase())
      const nameIndex = headers.indexOf('name')
      if (nameIndex < 0) {
        throw new Error('A "name" column is required to import customers.')
      }

      const phoneIndex = headers.indexOf('phone')
      const emailIndex = headers.indexOf('email')
      const notesIndex = headers.indexOf('notes')
      const tagsIndex = headers.indexOf('tags')

      const existingByEmail = new Map<string, string>()
      const existingByPhone = new Map<string, string>()
      customers.forEach(customer => {
        if (customer.email) {
          existingByEmail.set(customer.email.toLowerCase(), customer.id)
        }
        if (customer.phone) {
          existingByPhone.set(customer.phone.replace(/\D/g, ''), customer.id)
        }
      })

      let newCount = 0
      let updatedCount = 0

      for (const row of dataRows) {
        if (!row.length) continue
        const rawName = row[nameIndex]?.trim()
        if (!rawName) continue
        const rawPhone = phoneIndex >= 0 ? row[phoneIndex]?.trim() ?? '' : ''
        const rawEmail = emailIndex >= 0 ? row[emailIndex]?.trim() ?? '' : ''
        const rawNotes = notesIndex >= 0 ? row[notesIndex]?.trim() ?? '' : ''
        const rawTags = tagsIndex >= 0 ? row[tagsIndex] ?? '' : ''
        const parsedTags = tagsIndex >= 0 ? normalizeTags(rawTags) : undefined

        const normalizedPhone = rawPhone.replace(/\D/g, '')
        const emailKey = rawEmail.toLowerCase()
        const existingId = emailKey
          ? existingByEmail.get(emailKey)
          : normalizedPhone
          ? existingByPhone.get(normalizedPhone)
          : undefined

        if (existingId) {
          const payload: Record<string, unknown> = {
            name: rawName,
            updatedAt: serverTimestamp(),
          }
          if (phoneIndex >= 0) {
            payload.phone = rawPhone ? rawPhone : null
          }
          if (emailIndex >= 0) {
            payload.email = rawEmail ? rawEmail : null
          }
          if (notesIndex >= 0) {
            payload.notes = rawNotes ? rawNotes : null
          }
          if (parsedTags) {
            payload.tags = parsedTags
          }
          await updateDoc(doc(db, 'customers', existingId), payload)
          updatedCount += 1
        } else {
          const payload: Record<string, unknown> = {
            storeId: STORE_ID,
            name: rawName,
            createdAt: serverTimestamp(),
          }
          if (rawPhone) {
            payload.phone = rawPhone
          }
          if (rawEmail) {
            payload.email = rawEmail
          }
          if (rawNotes) {
            payload.notes = rawNotes
          }
          if (parsedTags && parsedTags.length) {
            payload.tags = parsedTags
          }
          await addDoc(collection(db, 'customers'), payload)
          newCount += 1
        }
      }

      if (!newCount && !updatedCount) {
        throw new Error('No valid customer rows were found in this file.')
      }

      showSuccess(`Imported ${newCount + updatedCount} customers (${newCount} new, ${updatedCount} updated).`)
    } catch (err) {
      console.error('[customers] Unable to import CSV', err)
      const message = err instanceof Error ? err.message : 'We were unable to import this file.'
      setError(message)
      setSuccess(null)
    } finally {
      setIsImporting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  function exportToCsv() {
    const headers = ['Name', 'Phone', 'Email', 'Notes', 'Tags', 'Visits', 'Last visit', 'Total spend']
    const lines = customers.map(customer => {
      const stats = customerStats[customer.id]
      const visitCount = stats?.visits ?? 0
      const lastVisit = stats?.lastVisit ? stats.lastVisit.toISOString() : ''
      const totalSpend = stats?.totalSpend ?? 0
      const tags = (customer.tags ?? []).join(', ')
      const cells = [
        customer.name ?? '',
        customer.phone ?? '',
        customer.email ?? '',
        customer.notes ?? '',
        tags,
        String(visitCount),
        lastVisit,
        totalSpend.toFixed(2),
      ]
      return cells.map(buildCsvValue).join(',')
    })

    const csvContent = [headers.map(buildCsvValue).join(','), ...lines].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    link.download = `customers-${timestamp}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }

  function beginEdit(customer: Customer) {
    setEditingCustomerId(customer.id)
    setName(customer.name)
    setPhone(customer.phone ?? '')
    setEmail(customer.email ?? '')
    setNotes(customer.notes ?? '')
    setTagsInput((customer.tags ?? []).join(', '))
  }

  function beginView(customer: Customer) {
    setSelectedCustomerId(customer.id)
  }

  const isFormDisabled = busy || isImporting

  const totalShown = filteredCustomers.length

  const quickFilters: { id: typeof quickFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'recent', label: 'Visited recently' },
    { id: 'noPurchases', label: 'No purchases yet' },
    { id: 'highValue', label: 'High spenders' },
    { id: 'untagged', label: 'Untagged' },
  ]

  if (!storeLoading && !hasAccess) {
    return <AccessDenied feature="customers" role={role ?? null} />
  }

  if (storeLoading) {
    return <div>Loading…</div>
  }

  return (
    <div className="page customers-page">
      <header className="page__header">
        <div>
          <h2 className="page__title">Customers</h2>
          <p className="page__subtitle">
            Keep a tidy record of your regulars and speed up checkout on the sales floor.
          </p>
        </div>
        <span className="customers-page__badge" aria-live="polite">
          {customers.length} saved • {totalShown} shown
        </span>
      </header>

      <div className="customers-page__grid">
        <section className="card" aria-label="Add a customer">
          <div className="customers-page__section-header">
            <h3 className="card__title">{editingCustomerId ? 'Update customer' : 'New customer'}</h3>
            <p className="card__subtitle">
              {editingCustomerId
                ? 'Edit the selected profile to keep records accurate.'
                : 'Capture contact details so you can reuse them during checkout.'}
            </p>
          </div>

          <form className="customers-page__form" onSubmit={addCustomer}>
            <div className="field">
              <label className="field__label" htmlFor="customer-name">Full name</label>
              <input
                id="customer-name"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="e.g. Ama Mensah"
                disabled={isFormDisabled}
                required
              />
            </div>

            <div className="customers-page__form-row">
              <div className="field">
                <label className="field__label" htmlFor="customer-phone">Phone</label>
                <input
                  id="customer-phone"
                  value={phone}
                  onChange={event => setPhone(event.target.value)}
                  placeholder="024 000 0000"
                  disabled={isFormDisabled}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="customer-email">Email</label>
                <input
                  id="customer-email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  placeholder="ama@example.com"
                  disabled={isFormDisabled}
                  type="email"
                />
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="customer-notes">Notes</label>
              <textarea
                id="customer-notes"
                value={notes}
                onChange={event => setNotes(event.target.value)}
                placeholder="Birthday reminders, delivery addresses, favourite products…"
                rows={3}
                disabled={isFormDisabled}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="customer-tags">Segmentation tags</label>
              <input
                id="customer-tags"
                value={tagsInput}
                onChange={event => setTagsInput(event.target.value)}
                placeholder="e.g. VIP, Wholesale, Birthday Club"
                disabled={isFormDisabled}
              />
              <p className="field__hint">Separate multiple tags with commas to power quick filters and campaigns.</p>
            </div>

            {error && <p className="customers-page__message customers-page__message--error">{error}</p>}
            {success && !error && (
              <p className="customers-page__message customers-page__message--success" role="status">{success}</p>
            )}
            {storeError && (
              <p className="customers-page__message customers-page__message--error" role="alert">{storeError}</p>
            )}

            <div className="customers-page__form-actions">
              <button type="submit" className="button button--primary" disabled={isFormDisabled}>
                {editingCustomerId ? 'Save changes' : 'Save customer'}
              </button>
              {editingCustomerId && (
                <button
                  type="button"
                  className="button button--outline"
                  onClick={resetForm}
                  disabled={isFormDisabled}
                >
                  Cancel edit
                </button>
              )}
            </div>

            <p className="field__hint">
              Customers saved here appear in the checkout flow. Visit the <Link to="/sell">Sell page</Link> to try it out.
            </p>
          </form>
        </section>

        <section className="card" aria-label="Saved customers">
          <div className="customers-page__section-header">
            <h3 className="card__title">Customer list</h3>
            <p className="card__subtitle">
              Stay organised and keep sales staff informed with up-to-date contact information.
            </p>
          </div>

          <div className="customers-page__toolbar">
            <div className="field customers-page__search-field">
              <label className="field__label" htmlFor="customer-search">Search</label>
              <input
                id="customer-search"
                placeholder="Search by name, phone, email, or notes"
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
              />
            </div>
            <div className="customers-page__tool-buttons">
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={exportToCsv}
                disabled={!customers.length}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="button button--outline button--small"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
              >
                {isImporting ? 'Importing…' : 'Import CSV'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={handleCsvImport}
              />
            </div>
          </div>

          <div className="customers-page__filters" role="group" aria-label="Quick filters">
            <span className="customers-page__filters-label">Quick filters:</span>
            <div className="customers-page__quick-filters">
              {quickFilters.map(filter => (
                <button
                  key={filter.id}
                  type="button"
                  className={`button button--ghost button--small${quickFilter === filter.id ? ' customers-page__quick-filter--active' : ''}`}
                  onClick={() => setQuickFilter(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {allTags.length > 0 && (
            <div className="customers-page__tag-filters" role="group" aria-label="Tag filters">
              <span className="customers-page__filters-label">Tags:</span>
              <div className="customers-page__tag-chip-group">
                <button
                  type="button"
                  className={`button button--ghost button--small${tagFilter === null ? ' customers-page__quick-filter--active' : ''}`}
                  onClick={() => setTagFilter(null)}
                >
                  All tags
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className={`button button--ghost button--small${tagFilter === tag ? ' customers-page__quick-filter--active' : ''}`}
                    onClick={() => setTagFilter(tag)}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          {filteredCustomers.length ? (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Tags</th>
                    <th scope="col">Visits</th>
                    <th scope="col">Last visit</th>
                    <th scope="col">Total spend</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map(customer => {
                    const contactBits = [customer.phone, customer.email].filter(Boolean).join(' • ')
                    const stats = customerStats[customer.id]
                    const visitCount = stats?.visits ?? 0
                    const lastVisit = stats?.lastVisit ?? null
                    const totalSpend = stats?.totalSpend ?? 0
                    const isSelected = selectedCustomerId === customer.id
                    return (
                      <tr
                        key={customer.id}
                        className={`customers-page__row${isSelected ? ' customers-page__row--selected' : ''}`}
                        onClick={() => beginView(customer)}
                      >
                        <td>{customer.name}</td>
                        <td>{contactBits || '—'}</td>
                        <td>
                          {customer.tags?.length ? (
                            <div className="customers-page__tag-list" aria-label={`Tags for ${customer.name}`}>
                              {customer.tags.map(tag => (
                                <span key={tag} className="customers-page__tag-chip">#{tag}</span>
                              ))}
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{visitCount}</td>
                        <td>{lastVisit ? lastVisit.toLocaleDateString() : '—'}</td>
                        <td>{visitCount ? currencyFormatter.format(totalSpend) : '—'}</td>
                        <td className="customers-page__table-actions">
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            onClick={event => {
                              event.stopPropagation()
                              beginView(customer)
                            }}
                          >
                            View
                          </button>
                          <button
                            type="button"
                            className="button button--outline button--small"
                            onClick={event => {
                              event.stopPropagation()
                              beginEdit(customer)
                            }}
                            disabled={isFormDisabled && editingCustomerId !== customer.id}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="button button--danger button--small"
                            onClick={event => {
                              event.stopPropagation()
                              removeCustomer(customer.id)
                            }}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <h3 className="empty-state__title">No customers match the current filters</h3>
              <p>Adjust your search or quick filters, or add customers using the form.</p>
            </div>
          )}
        </section>

        <section className="card customers-page__details" aria-label="Customer details">
          {selectedCustomer ? (
            <div className="customers-page__details-content">
              <div className="customers-page__section-header">
                <h3 className="card__title">{selectedCustomer.name}</h3>
                <p className="card__subtitle">Deep dive into visits, spend, and notes.</p>
              </div>
              <dl className="customers-page__detail-list">
                <div>
                  <dt>Contact</dt>
                  <dd>
                    {selectedCustomer.phone ? <div>{selectedCustomer.phone}</div> : null}
                    {selectedCustomer.email ? <div>{selectedCustomer.email}</div> : null}
                    {!selectedCustomer.phone && !selectedCustomer.email ? '—' : null}
                  </dd>
                </div>
                <div>
                  <dt>Notes</dt>
                  <dd>{selectedCustomer.notes ? selectedCustomer.notes : '—'}</dd>
                </div>
                <div>
                  <dt>Segmentation tags</dt>
                  <dd>
                    {selectedCustomer.tags?.length ? (
                      <div className="customers-page__tag-list">
                        {selectedCustomer.tags.map(tag => (
                          <span key={tag} className="customers-page__tag-chip">#{tag}</span>
                        ))}
                      </div>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Total visits</dt>
                  <dd>{selectedCustomerStats.visits}</dd>
                </div>
                <div>
                  <dt>Total spend</dt>
                  <dd>
                    {selectedCustomerStats.visits
                      ? currencyFormatter.format(selectedCustomerStats.totalSpend)
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Last visit</dt>
                  <dd>{formatDate(selectedCustomerStats.lastVisit)}</dd>
                </div>
              </dl>

              <div className="customers-page__history">
                <h4>Recent transactions</h4>
                {selectedCustomerHistory.length ? (
                  <ul>
                    {selectedCustomerHistory.slice(0, 10).map(entry => (
                      <li key={entry.id}>
                        <div className="customers-page__history-row">
                          <span className="customers-page__history-primary">
                            {entry.createdAt ? entry.createdAt.toLocaleString() : 'Unknown date'}
                          </span>
                          <span className="customers-page__history-total">{currencyFormatter.format(entry.total)}</span>
                        </div>
                        <div className="customers-page__history-meta">
                          {entry.paymentMethod ? `Paid via ${entry.paymentMethod}` : 'Payment method not recorded'}
                        </div>
                        {entry.items?.length ? (
                          <div className="customers-page__history-items">
                            {entry.items.slice(0, 3).map((item, index) => (
                              <span key={`${entry.id}-${item?.name ?? index}`}>
                                {item?.qty ?? 0} × {item?.name ?? 'Item'}
                              </span>
                            ))}
                            {entry.items.length > 3 && <span>…</span>}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No sales recorded for this customer yet.</p>
                )}
              </div>

              <div className="customers-page__details-actions">
                <button
                  type="button"
                  className="button button--outline button--small"
                  onClick={() => beginEdit(selectedCustomer)}
                >
                  Edit details
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => setSelectedCustomerId(null)}
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div className="customers-page__details-empty">
              <h3>Select a customer to view CRM insights</h3>
              <p>
                Pick someone from the list to see their visit history, spending patterns, and notes. Use tags to
                segment audiences before launching campaigns.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
