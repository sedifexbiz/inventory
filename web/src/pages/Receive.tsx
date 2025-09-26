import React, { useEffect, useMemo, useRef, useState } from 'react'
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../firebase'
import { useActiveStore } from '../hooks/useActiveStore'
import './Receive.css'
import { queueCallableRequest } from '../utils/offlineQueue'
import { AccessDenied } from '../components/AccessDenied'
import { canAccessFeature } from '../utils/permissions'
import { loadCachedProducts, saveCachedProducts, PRODUCT_CACHE_LIMIT } from '../utils/offlineCache'

type Product = {
  id: string
  name: string
  stockCount?: number
  storeId: string
  createdAt?: unknown
  updatedAt?: unknown
}

function isOfflineError(error: unknown) {
  if (!navigator.onLine) return true
  if (error instanceof FirebaseError) {
    return error.code === 'unavailable' || error.code === 'internal'
  }
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase()
    return message.includes('network') || message.includes('fetch')
  }
  return false
}

export default function Receive() {
  const { storeId: STORE_ID, role, isLoading: storeLoading, error: storeError } = useActiveStore()

  const [products, setProducts] = useState<Product[]>([])
  const [selected, setSelected] = useState<string>('')
  const [qty, setQty] = useState<string>('')
  const [supplier, setSupplier] = useState('')
  const [reference, setReference] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const statusTimeoutRef = useRef<number | null>(null)
  const receiveStock = useMemo(() => httpsCallable(functions, 'receiveStock'), [])
  const hasAccess = canAccessFeature(role, 'receive')

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
    if (!STORE_ID || !hasAccess) return

    let cancelled = false

    loadCachedProducts<Product>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          setProducts(
            [...cached].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
          )
        }
      })
      .catch(error => {
        console.warn('[receive] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', STORE_ID),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(PRODUCT_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
      saveCachedProducts(STORE_ID, rows).catch(error => {
        console.warn('[receive] Failed to cache products', error)
      })
      const sortedRows = [...rows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
      setProducts(sortedRows)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [STORE_ID, hasAccess])

  async function receive() {
    if (!STORE_ID) {
      showStatus('error', 'Store access is not ready. Please refresh and try again.')
      return
    }
    if (!selected || qty === '') return
    const p = products.find(x=>x.id===selected); if (!p) return
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
      storeId: STORE_ID,
      productId: selected,
      qty: amount,
      supplier: supplierName,
      reference: referenceNumber,
      unitCost: parsedCost,
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
        const queued = await queueCallableRequest('receiveStock', payload, 'receipt')
        if (queued) {
          setQty('')
          setSupplier('')
          setReference('')
          setUnitCost('')
          showStatus('success', 'Offline — receipt saved and will sync when you reconnect.')
          return
        }
      }
      showStatus('error', 'Unable to record stock receipt. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!storeLoading && !hasAccess) {
    return <AccessDenied feature="receive" role={role ?? null} />
  }

  if (storeLoading) return <div>Loading…</div>
  if (!STORE_ID) return <div>We were unable to determine your store access. Please sign out and back in.</div>

  return (
    <div className="page receive-page">
      <header className="page__header">
        <div>
          <h2 className="page__title">Receive stock</h2>
          <p className="page__subtitle">Log deliveries against your Firestore inventory so shelves stay replenished.</p>
        </div>
      </header>

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
          {storeError && (
            <p className="receive-page__message receive-page__message--error" role="alert">{storeError}</p>
          )}
        </div>
      </section>
    </div>
  )
}
