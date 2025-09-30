import React, { useEffect, useMemo, useRef, useState } from 'react'
import { collection, query, orderBy, limit, onSnapshot, where } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../firebase'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import './Receive.css'
import { queueCallableRequest } from '../utils/offlineQueue'
import { loadCachedProducts, saveCachedProducts, PRODUCT_CACHE_LIMIT } from '../utils/offlineCache'
import { useToast } from '../components/ToastProvider'
import { FIREBASE_CALLABLES } from '@shared/firebaseCallables'

type Product = {
  id: string
  name: string
  stockCount?: number
  createdAt?: unknown
  updatedAt?: unknown
}

type PendingReceipt = {
  baseline: number
  increment: number
}

function isOfflineError(error: unknown) {
  if (!navigator.onLine) return true
  if (error instanceof FirebaseError) {
    const code = (error.code || '').toLowerCase()
    return (
      code === 'unavailable' ||
      code === 'internal' ||
      code.endsWith('/unavailable') ||
      code.endsWith('/internal')
    )
  }
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase()
    return message.includes('network') || message.includes('fetch')
  }
  return false
}

export default function Receive() {
  const { storeId: activeStoreId, storeChangeToken } = useActiveStoreContext()
  const [products, setProducts] = useState<Product[]>([])
  const [selected, setSelected] = useState<string>('')
  const [qty, setQty] = useState<string>('')
  const [supplier, setSupplier] = useState('')
  const [reference, setReference] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const statusTimeoutRef = useRef<number | null>(null)
  const [pendingReceipts, setPendingReceipts] = useState<Record<string, PendingReceipt>>({})
  const pendingReceiptsRef = useRef(pendingReceipts)
  const receiveStock = useMemo(
    () => httpsCallable(functions, FIREBASE_CALLABLES.RECEIVE_STOCK),
    [],
  )
  const { publish } = useToast()

  useEffect(() => {
    pendingReceiptsRef.current = pendingReceipts
  }, [pendingReceipts])
  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current) {
        window.clearTimeout(statusTimeoutRef.current)
        statusTimeoutRef.current = null
      }
    }
  }, [])

  function showStatus(tone: 'success' | 'error', message: string) {
    setStatus({ tone, message })
    if (statusTimeoutRef.current) {
      window.clearTimeout(statusTimeoutRef.current)
    }
    statusTimeoutRef.current = window.setTimeout(() => {
      setStatus(null)
      statusTimeoutRef.current = null
    }, 4000)
  }

  useEffect(() => {
    let cancelled = false

    setProducts([])

    if (!activeStoreId) {
      setProducts([])
      return () => {
        cancelled = true
      }
    }

    loadCachedProducts<Product>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          const pending = pendingReceiptsRef.current
          const withPending = cached.map(product => {
            const entry = pending[product.id]
            if (!entry) return product
            const baseStock = product.stockCount ?? 0
            return { ...product, stockCount: baseStock + entry.increment }
          })
          setProducts(
            [...withPending].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
            ),
          )
        }
      })
      .catch(error => {
        console.warn('[receive] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', activeStoreId),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(PRODUCT_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snap => {
      const pending = { ...pendingReceiptsRef.current }
      const rawRows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))

      const rowsWithPending = rawRows.map(row => {
        const actualStock = row.stockCount ?? 0
        const entry = pending[row.id]
        if (!entry) {
          return row
        }

        const appliedDelta = actualStock - entry.baseline
        if (appliedDelta >= entry.increment) {
          delete pending[row.id]
          return { ...row, stockCount: actualStock }
        }

        const remaining = entry.increment - Math.max(appliedDelta, 0)
        pending[row.id] = {
          baseline: actualStock,
          increment: remaining,
        }

        return { ...row, stockCount: actualStock + remaining }
      })

      pendingReceiptsRef.current = pending
      setPendingReceipts(pending)

      saveCachedProducts(rowsWithPending, { storeId: activeStoreId }).catch(error => {
        console.warn('[receive] Failed to cache products', error)
      })
      const sortedRows = [...rowsWithPending].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
      setProducts(sortedRows)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId, storeChangeToken])

  useEffect(() => {
    setSelected('')
    setQty('')
    setSupplier('')
    setReference('')
    setUnitCost('')
    setStatus(null)
    pendingReceiptsRef.current = {}
    setPendingReceipts({})
  }, [storeChangeToken])

  async function receive() {
    if (!selected || qty === '') return
    if (!activeStoreId) {
      showStatus('error', 'Select a workspace before receiving stock.')
      return
    }
    const p = products.find(x => x.id === selected)
    if (!p) return
    const amount = Number(qty)
    if (!Number.isFinite(amount) || amount <= 0) {
      showStatus('error', 'Enter a valid quantity greater than zero.')
      return
    }
    const supplierName = supplier.trim()
    if (!supplierName) {
      showStatus('error', 'Add the supplier who fulfilled this delivery.')
      return
    }
    const referenceNumber = reference.trim()
    if (!referenceNumber) {
      showStatus('error', 'Add the packing slip or purchase order reference number.')
      return
    }
    const costValue = unitCost.trim()
    const parsedCost = costValue ? Number(costValue) : null
    if (parsedCost !== null && (!Number.isFinite(parsedCost) || parsedCost < 0)) {
      showStatus('error', 'Enter a valid cost that is zero or greater.')
      return
    }
    setBusy(true)
    const payload = {
      productId: selected,
      qty: amount,
      supplier: supplierName,
      reference: referenceNumber,
      unitCost: parsedCost,
      storeId: activeStoreId,
    }

    try {
      await receiveStock(payload)
      setQty('')
      setSupplier('')
      setReference('')
      setUnitCost('')
      showStatus('success', 'Stock received successfully.')
    } catch (error) {
      console.error('[receive] Failed to update stock', error)
      if (isOfflineError(error)) {
        const queued = await queueCallableRequest(
          FIREBASE_CALLABLES.RECEIVE_STOCK,
          payload,
          'receipt',
        )
        if (queued) {
          setQty('')
          setSupplier('')
          setReference('')
          setUnitCost('')
          publish({ message: 'Queued receipt • will sync', tone: 'success' })
          const existing = pendingReceiptsRef.current[selected]
          const baseline = existing ? existing.baseline : (p.stockCount ?? 0)
          const totalIncrement = (existing?.increment ?? 0) + amount
          const nextPending = {
            ...pendingReceiptsRef.current,
            [selected]: {
              baseline,
              increment: totalIncrement,
            },
          }
          pendingReceiptsRef.current = nextPending
          setPendingReceipts(nextPending)

          const nextProducts = products.map(product => {
            if (product.id !== selected) return product
            return {
              ...product,
              stockCount: baseline + totalIncrement,
            }
          })
          setProducts(nextProducts)
          saveCachedProducts(nextProducts, { storeId: activeStoreId }).catch(cacheError => {
            console.warn('[receive] Failed to cache products after queueing receipt', cacheError)
          })
          showStatus('success', 'Offline receipt saved.')
          return
        }
      }
      showStatus('error', 'Unable to record stock receipt. Please try again.')
    } finally {
      setBusy(false)
    }
  }



  const workspaceEmptyState = (
    <div className="empty-state">
      <h3 className="empty-state__title">Select a workspace…</h3>
      <p>Choose a workspace from the switcher above to continue.</p>
    </div>
  )

  const pageHeader = (
    <header className="page__header">
      <div>
        <h2 className="page__title">Receive stock</h2>
        <p className="page__subtitle">Log deliveries against your Firestore inventory so shelves stay replenished.</p>
      </div>
    </header>
  )

  if (!activeStoreId) {
    return (
      <div className="page receive-page">
        {pageHeader}
        <section className="card receive-page__card">{workspaceEmptyState}</section>
      </div>
    )
  }

  return (
    <div className="page receive-page">
      {pageHeader}

      <section className="card receive-page__card">
        <div className="receive-page__form">
          <div className="field">
            <label className="field__label" htmlFor="receive-product">Product</label>
            <select
              id="receive-product"
              value={selected}
              onChange={e => setSelected(e.target.value)}
            >
              <option value="">Select product…</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} (Stock {p.stockCount ?? 0})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="receive-qty">Quantity received</label>
            <input
              id="receive-qty"
              type="number"
              min={1}
              placeholder="0"
              value={qty}
              onChange={e => setQty(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="receive-supplier">Supplier</label>
            <input
              id="receive-supplier"
              type="text"
              placeholder="Acme Distribution"
              value={supplier}
              onChange={e => setSupplier(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="receive-reference">Reference number</label>
            <input
              id="receive-reference"
              type="text"
              placeholder="PO-12345 or packing slip"
              value={reference}
              onChange={e => setReference(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="receive-cost">Unit cost (optional)</label>
            <input
              id="receive-cost"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={unitCost}
              onChange={e => setUnitCost(e.target.value)}
            />
          </div>
          <div className="receive-page__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={receive}
              disabled={!selected || !qty || !supplier.trim() || !reference.trim() || busy}
            >
              Add stock
            </button>
          </div>
          {status && (
            <p
              className={`receive-page__message receive-page__message--${status.tone}`}
              role={status.tone === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
