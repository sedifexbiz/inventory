import React, { useCallback, useEffect, useState } from 'react'
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  where,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { db } from '../firebase'
import { useAuthUser } from '../hooks/useAuthUser'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import './Sell.css'
import { Link } from 'react-router-dom'
import BarcodeScanner, { ScanResult } from '../components/BarcodeScanner'
import {
  CUSTOMER_CACHE_LIMIT,
  PRODUCT_CACHE_LIMIT,
  loadCachedCustomers,
  loadCachedProducts,
  saveCachedCustomers,
  saveCachedProducts,
} from '../utils/offlineCache'
import { buildSimplePdf } from '../utils/pdf'

type Product = {
  id: string
  name: string
  price: number | null
  sku?: string | null
  stockCount?: number
  createdAt?: unknown
  updatedAt?: unknown
}
type CartLine = { productId: string; name: string; price: number; qty: number }
type Customer = {
  id: string
  name: string
  displayName?: string
  phone?: string
  email?: string
  notes?: string
  createdAt?: unknown
  updatedAt?: unknown
}
type ReceiptData = {
  saleId: string
  createdAt: Date
  items: CartLine[]
  subtotal: number
  payment: {
    method: string
    amountPaid: number
    changeDue: number
  }
  customer?: {
    name: string
    phone?: string
    email?: string
  }
}

type ReceiptSharePayload = {
  message: string
  emailHref: string
  smsHref: string
  whatsappHref: string
  pdfBlob: Blob
  pdfUrl: string
  pdfFileName: string
}

function getCustomerPrimaryName(customer: Pick<Customer, 'displayName' | 'name'>): string {
  const displayName = customer.displayName?.trim()
  if (displayName) {
    return displayName
  }
  const legacyName = customer.name?.trim()
  if (legacyName) {
    return legacyName
  }
  return ''
}

function getCustomerFallbackContact(customer: Pick<Customer, 'email' | 'phone'>): string {
  const email = customer.email?.trim()
  if (email) {
    return email
  }
  const phone = customer.phone?.trim()
  if (phone) {
    return phone
  }
  return ''
}

function getCustomerSortKey(
  customer: Pick<Customer, 'displayName' | 'name' | 'email' | 'phone'>,
): string {
  const primary = getCustomerPrimaryName(customer)
  if (primary) {
    return primary
  }
  return getCustomerFallbackContact(customer)
}

function getCustomerDisplayName(
  customer: Pick<Customer, 'displayName' | 'name' | 'email' | 'phone'>,
): string {
  const primary = getCustomerPrimaryName(customer)
  if (primary) {
    return primary
  }
  const fallback = getCustomerFallbackContact(customer)
  if (fallback) {
    return fallback
  }
  return '—'
}

function getCustomerNameForData(
  customer: Pick<Customer, 'displayName' | 'name' | 'email' | 'phone'>,
): string {
  const primary = getCustomerPrimaryName(customer)
  if (primary) {
    return primary
  }
  return getCustomerFallbackContact(customer)
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

function sanitizePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  return null
}

export default function Sell() {
  const user = useAuthUser()
  const { storeId: activeStoreId } = useActiveStoreContext()

  const [products, setProducts] = useState<Product[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [queryText, setQueryText] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'mobile' | 'card'>('cash')
  const [amountTendered, setAmountTendered] = useState('')
  const [saleError, setSaleError] = useState<string | null>(null)
  const [saleSuccess, setSaleSuccess] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<{
    tone: 'success' | 'error'
    message: string
  } | null>(null)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [receiptSharePayload, setReceiptSharePayload] = useState<ReceiptSharePayload | null>(null)
  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0)
  const selectedCustomer = customers.find(c => c.id === selectedCustomerId)
  const selectedCustomerDisplayName = selectedCustomer
    ? getCustomerDisplayName(selectedCustomer)
    : ''
  const selectedCustomerDataName = selectedCustomer
    ? getCustomerNameForData(selectedCustomer)
    : ''
  const amountPaid = paymentMethod === 'cash' ? Number(amountTendered || 0) : subtotal
  const changeDue = Math.max(0, amountPaid - subtotal)
  const isCashShort = paymentMethod === 'cash' && amountPaid < subtotal && subtotal > 0

  useEffect(() => {
    let cancelled = false

    if (!activeStoreId) {
      setProducts([])
      return () => {
        cancelled = true
      }
    }

    loadCachedProducts<Product>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          const sanitized = cached.map(item => ({
            ...(item as Product),
            price: sanitizePrice((item as Product).price),
          }))
          setProducts(
            sanitized.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
          )
        }
      })
      .catch(error => {
        console.warn('[sell] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', activeStoreId),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(PRODUCT_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Record<string, unknown>),
      }))
      const sanitizedRows = rows.map(row => ({
        ...(row as Product),
        price: sanitizePrice((row as Product).price),
      }))
      saveCachedProducts(sanitizedRows, { storeId: activeStoreId }).catch(error => {
        console.warn('[sell] Failed to cache products', error)
      })
      const sortedRows = [...sanitizedRows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
      setProducts(sortedRows)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId])

  useEffect(() => {
    let cancelled = false

    if (!activeStoreId) {
      setCustomers([])
      return () => {
        cancelled = true
      }
    }

    loadCachedCustomers<Customer>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          setCustomers(
            [...cached].sort((a, b) =>
              getCustomerSortKey(a).localeCompare(getCustomerSortKey(b), undefined, {
                sensitivity: 'base',
              }),
            ),
          )
        }
      })
      .catch(error => {
        console.warn('[sell] Failed to load cached customers', error)
      })

    const q = query(
      collection(db, 'customers'),
      where('storeId', '==', activeStoreId),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(CUSTOMER_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snap => {
      const rows = snap.docs.map(docSnap => ({ id: docSnap.id, ...(docSnap.data() as Customer) }))
      saveCachedCustomers(rows, { storeId: activeStoreId }).catch(error => {
        console.warn('[sell] Failed to cache customers', error)
      })
      const sortedRows = [...rows].sort((a, b) =>
        getCustomerSortKey(a).localeCompare(getCustomerSortKey(b), undefined, {
          sensitivity: 'base',
        }),
      )
      setCustomers(sortedRows)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId])

  useEffect(() => {
    if (!receipt) return
    const timeout = window.setTimeout(() => {
      window.print()
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [receipt])

  useEffect(() => {
    if (!receipt) {
      setReceiptSharePayload(prev => {
        if (prev?.pdfUrl) {
          URL.revokeObjectURL(prev.pdfUrl)
        }
        return null
      })
      return
    }

    const contactLine = user?.email ?? 'sales@sedifex.app'

    const lines: string[] = []
    lines.push('Sedifex POS')
    lines.push(contactLine)
    lines.push(receipt.createdAt.toLocaleString())

    if (receipt.customer) {
      lines.push('')
      lines.push('Customer:')
      lines.push(`  ${receipt.customer.name}`)
      if (receipt.customer.phone) {
        lines.push(`  ${receipt.customer.phone}`)
      }
      if (receipt.customer.email) {
        lines.push(`  ${receipt.customer.email}`)
      }
    }

    lines.push('')
    lines.push('Items:')
    receipt.items.forEach(line => {
      lines.push(`  • ${line.qty} × ${line.name} — GHS ${(line.qty * line.price).toFixed(2)}`)
    })

    lines.push('')
    lines.push(`Subtotal: GHS ${receipt.subtotal.toFixed(2)}`)
    lines.push(`Paid (${receipt.payment.method}): GHS ${receipt.payment.amountPaid.toFixed(2)}`)
    lines.push(`Change: GHS ${receipt.payment.changeDue.toFixed(2)}`)
    lines.push('')
    lines.push(`Sale #${receipt.saleId}`)
    lines.push('Thank you for shopping with us!')

    const message = lines.join('\n')
    const emailSubject = `Receipt for sale #${receipt.saleId}`

    const encodedSubject = encodeURIComponent(emailSubject)
    const encodedBody = encodeURIComponent(message)
    const emailHref = `mailto:${receipt.customer?.email ?? ''}?subject=${encodedSubject}&body=${encodedBody}`
    const smsHref = `sms:${receipt.customer?.phone ?? ''}?body=${encodedBody}`
    const whatsappHref = `https://wa.me/?text=${encodedBody}`

    const pdfLines = lines.slice(1)
    const pdfBytes = buildSimplePdf('Sedifex POS', pdfLines)
    const pdfBuffer = pdfBytes.slice().buffer
    const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' })
    const pdfUrl = URL.createObjectURL(pdfBlob)
    const pdfFileName = `receipt-${receipt.saleId}.pdf`

    setReceiptSharePayload(prev => {
      if (prev?.pdfUrl) {
        URL.revokeObjectURL(prev.pdfUrl)
      }
      return { message, emailHref, smsHref, whatsappHref, pdfBlob, pdfUrl, pdfFileName }
    })

    return () => {
      URL.revokeObjectURL(pdfUrl)
    }
  }, [receipt, user?.email])

  const handleDownloadPdf = useCallback(() => {
    setReceiptSharePayload(prev => {
      if (!prev) return prev

      const url = prev.pdfUrl || URL.createObjectURL(prev.pdfBlob)
      const link = document.createElement('a')
      link.href = url
      link.download = prev.pdfFileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      URL.revokeObjectURL(url)
      const refreshedUrl = URL.createObjectURL(prev.pdfBlob)
      return { ...prev, pdfUrl: refreshedUrl }
    })
  }, [])

  useEffect(() => {
    const url = receiptSharePayload?.pdfUrl
    return () => {
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
  }, [receiptSharePayload?.pdfUrl])

  useEffect(() => {
    if (paymentMethod !== 'cash') {
      setAmountTendered('')
    }
  }, [paymentMethod])


  const addToCart = useCallback((p: Product) => {
    if (typeof p.price !== 'number' || !Number.isFinite(p.price)) {
      return
    }
    setCart(cs => {
      const i = cs.findIndex(x => x.productId === p.id)
      if (i >= 0) {
        const copy = [...cs]
        copy[i] = { ...copy[i], qty: copy[i].qty + 1 }
        return copy
      }
      return [...cs, { productId: p.id, name: p.name, price: p.price, qty: 1 }]
    })
  }, [])

  const handleScannerError = useCallback((message: string) => {
    setScannerStatus({ tone: 'error', message })
  }, [])

  const handleScanResult = useCallback(
    (result: ScanResult) => {
      const normalized = result.code.trim()
      if (!normalized) return
      const match = products.find(product => {
        if (!product.sku) return false
        return product.sku.trim().toLowerCase() === normalized.toLowerCase()
      })
      if (!match) {
        setScannerStatus({
          tone: 'error',
          message: `We couldn't find a product for code ${normalized}.`,
        })
        return
      }
      if (typeof match.price !== 'number' || !Number.isFinite(match.price)) {
        setScannerStatus({
          tone: 'error',
          message: `${match.name} needs a price before it can be sold.`,
        })
        return
      }

      addToCart(match)
      const friendlySource =
        result.source === 'manual'
          ? 'manual entry'
          : result.source === 'camera'
            ? 'the camera'
            : 'the scanner'
      setScannerStatus({
        tone: 'success',
        message: `Added ${match.name} via ${friendlySource}.`,
      })
    },
    [addToCart, products],
  )
  function setQty(id: string, qty: number) {
    setCart(cs => cs.map(l => l.productId === id ? { ...l, qty: Math.max(0, qty) } : l).filter(l => l.qty > 0))
  }
  async function recordSale() {
    if (cart.length === 0) return
    if (!activeStoreId) {
      setSaleError('Select a workspace before recording a sale.')
      return
    }
    if (!user) {
      setSaleError('You must be signed in to record a sale.')
      return
    }
    if (isCashShort) {
      setSaleError('Cash received is less than the total due.')
      return
    }
    setSaleError(null)
    setSaleSuccess(null)
    setReceipt(null)
    setIsRecording(true)
    const saleId = doc(collection(db, 'sales')).id
    const saleRef = doc(db, 'sales', saleId)
    const saleItemsCollection = collection(db, 'saleItems')
    const stockCollection = collection(db, 'stock')
    const ledgerCollection = collection(db, 'ledger')

    const receiptItems = cart.map(line => ({ ...line }))
    const saleCustomer = selectedCustomer
      ? {
          id: selectedCustomer.id,
          name: selectedCustomerDataName || selectedCustomer.id,
          ...(selectedCustomer.phone ? { phone: selectedCustomer.phone } : {}),
          ...(selectedCustomer.email ? { email: selectedCustomer.email } : {}),
        }
      : null

    try {
      await runTransaction(db, async transaction => {
        const existingSale = await transaction.get(saleRef)
        if (typeof existingSale.exists === 'function' ? existingSale.exists() : existingSale.exists) {
          throw new Error('This sale has already been recorded.')
        }

        const timestamp = serverTimestamp()
        const normalizedItems = cart.map(line => {
          const productId = typeof line.productId === 'string' ? line.productId.trim() : ''
          if (!productId) {
            throw new Error('Each cart line must reference a valid product before recording the sale.')
          }

          const qty = Number(line.qty)
          if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error('Update item quantities before recording the sale.')
          }

          const price = Number(line.price)
          if (!Number.isFinite(price) || price < 0) {
            throw new Error('Each item needs a valid price before selling.')
          }

          return {
            productId,
            name: line.name,
            price,
            qty,
            taxRate: 0,
          }
        })

        const productEntries = await Promise.all(
          normalizedItems.map(async item => {
            const productRef = doc(db, 'products', item.productId)
            const productSnapshot = await transaction.get(productRef)
            return { item, productRef, productSnapshot }
          }),
        )

        const saleData = {
          branchId: activeStoreId,
          storeId: activeStoreId,
          cashierId: user.uid,
          total: subtotal,
          taxTotal: 0,
          payment: {
            method: paymentMethod,
            amountPaid,
            changeDue,
          },
          customer: saleCustomer,
          items: normalizedItems,
          createdBy: user.uid,
          createdAt: timestamp,
          updatedAt: timestamp,
        }

        const saleItemWrites: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = []
        const stockWrites: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = []
        const productUpdates: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = []
        const ledgerWrites: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[] = []

        for (const { item, productRef, productSnapshot } of productEntries) {
          const productExists = productSnapshot && (typeof productSnapshot.exists === 'function'
            ? productSnapshot.exists()
            : productSnapshot.exists)
          if (!productExists) {
            throw new Error(`${item.name || 'Product'} is unavailable. Refresh your catalog and try again.`)
          }

          const currentStockRaw = typeof productSnapshot.get === 'function'
            ? productSnapshot.get('stockCount')
            : (productSnapshot.data?.stockCount ?? productSnapshot.stockCount)
          const currentStock = Number(currentStockRaw ?? 0) || 0
          const qtyChange = Math.abs(item.qty)
          const nextStock = currentStock - qtyChange

          const saleItemRef = doc(saleItemsCollection)
          saleItemWrites.push({
            ref: saleItemRef,
            data: {
              saleId,
              productId: item.productId,
              qty: item.qty,
              price: item.price,
              taxRate: item.taxRate,
              storeId: activeStoreId,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          })

          const stockRef = doc(stockCollection)
          stockWrites.push({
            ref: stockRef,
            data: {
              productId: item.productId,
              qtyChange: -qtyChange,
              reason: 'sale',
              refId: saleId,
              storeId: activeStoreId,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          })

          productUpdates.push({
            ref: productRef,
            data: {
              stockCount: nextStock,
              updatedAt: timestamp,
            },
          })

          const ledgerRef = doc(ledgerCollection)
          ledgerWrites.push({
            ref: ledgerRef,
            data: {
              productId: item.productId,
              qtyChange: -qtyChange,
              type: 'sale',
              refId: saleId,
              storeId: activeStoreId,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          })
        }

        transaction.set(saleRef, saleData)
        for (const { ref, data } of saleItemWrites) {
          transaction.set(ref, data)
        }
        for (const { ref, data } of stockWrites) {
          transaction.set(ref, data)
        }
        for (const { ref, data } of ledgerWrites) {
          transaction.set(ref, data)
        }
        for (const { ref, data } of productUpdates) {
          transaction.update(ref, data)
        }
      })

      setReceipt({
        saleId,
        createdAt: new Date(),
        items: receiptItems,
        subtotal,
        payment: {
          method: paymentMethod,
          amountPaid,
          changeDue,
        },
        customer: saleCustomer || undefined,
      })
      setCart([])
      setSelectedCustomerId('')
      setAmountTendered('')
      setSaleSuccess(`Sale recorded #${saleId}. Receipt sent to printer.`)
    } catch (err) {
      console.error('[sell] Unable to record sale', err)
      const message = err instanceof Error ? err.message : null
      const fallback = isOfflineError(err)
        ? 'We were unable to record this sale while offline. Please try again once you have a connection.'
        : 'We were unable to record this sale. Please try again.'
      setSaleError(message && message.trim().length > 0 ? message : fallback)
    } finally {
      setIsRecording(false)
    }
  }



  const filtered = products.filter(p => p.name.toLowerCase().includes(queryText.toLowerCase()))

  return (
    <div className="page sell-page">
      <header className="page__header">
        <div>
          <h2 className="page__title">Sell</h2>
          <p className="page__subtitle">Build a cart from your product list and record the sale in seconds.</p>
        </div>
        <div className="sell-page__total" aria-live="polite">
          <span className="sell-page__total-label">Subtotal</span>
          <span className="sell-page__total-value">GHS {subtotal.toFixed(2)}</span>
        </div>
      </header>

      <section className="card">
        <div className="field">
          <label className="field__label" htmlFor="sell-search">Find a product</label>
          <input
            id="sell-search"
            placeholder="Search by name"
            value={queryText}
            onChange={e => setQueryText(e.target.value)}
          />
          <p className="field__hint">
            Tip: search or scan a barcode to add products to the cart instantly.
          </p>
        </div>
        <BarcodeScanner
          className="sell-page__scanner"
          enableCameraFallback
          onScan={handleScanResult}
          onError={handleScannerError}
          manualEntryLabel="Scan or type a barcode"
        />
        {scannerStatus && (
          <div
            className={`sell-page__scanner-status sell-page__scanner-status--${scannerStatus.tone}`}
            role="status"
            aria-live="polite"
          >
            {scannerStatus.message}
          </div>
        )}
      </section>

      <div className="sell-page__grid">
        <section className="card sell-page__catalog" aria-label="Product list">
          <div className="sell-page__section-header">
            <h3 className="card__title">Products</h3>
            <p className="card__subtitle">{filtered.length} items available to sell.</p>
          </div>
          <div className="sell-page__catalog-list">
            {filtered.length ? (
              filtered.map(p => {
                const hasPrice = typeof p.price === 'number' && Number.isFinite(p.price)
                const priceText = hasPrice
                  ? `GHS ${p.price.toFixed(2)}`
                  : 'Price unavailable'
                const actionLabel = hasPrice ? 'Add' : 'Set price to sell'
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="sell-page__product"
                    onClick={() => addToCart(p)}
                    disabled={!hasPrice}
                    title={hasPrice ? undefined : 'Update the price before selling this product.'}
                  >
                    <div>
                      <span className="sell-page__product-name">{p.name}</span>
                      <span className="sell-page__product-meta">{priceText} • Stock {p.stockCount ?? 0}</span>
                    </div>
                    <span className="sell-page__product-action">{actionLabel}</span>
                  </button>
                )
              })
            ) : (
              <div className="empty-state">
                <h3 className="empty-state__title">No products found</h3>
                <p>Try a different search term or add new inventory from the products page.</p>
              </div>
            )}
          </div>
        </section>

        <section className="card sell-page__cart" aria-label="Cart">
          <div className="sell-page__section-header">
            <h3 className="card__title">Cart</h3>
            <p className="card__subtitle">Adjust quantities before recording the sale.</p>
          </div>

          {cart.length ? (
            <>
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col" className="sell-page__numeric">Qty</th>
                      <th scope="col" className="sell-page__numeric">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map(line => (
                      <tr key={line.productId}>
                        <td>{line.name}</td>
                        <td className="sell-page__numeric">
                          <input
                            className="input--inline input--align-right"
                            type="number"
                            min={0}
                            value={line.qty}
                            onChange={e => setQty(line.productId, Number(e.target.value))}
                          />
                        </td>
                        <td className="sell-page__numeric">GHS {(line.price * line.qty).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="sell-page__summary">
                <span>Total</span>
                <strong>GHS {subtotal.toFixed(2)}</strong>
              </div>

              <div className="sell-page__form-grid">
                <div className="sell-page__field-group">
                  <label className="field__label" htmlFor="sell-customer">Customer</label>
                  <select
                    id="sell-customer"
                    value={selectedCustomerId}
                    onChange={event => setSelectedCustomerId(event.target.value)}
                    className="sell-page__select"
                  >
                    <option value="">Walk-in customer</option>
                    {customers.map(customer => (
                      <option key={customer.id} value={customer.id}>
                        {getCustomerDisplayName(customer)}
                      </option>
                    ))}
                  </select>
              <p className="field__hint">
                Need to add someone new? Manage records on the{' '}
                <Link to="/customers" className="sell-page__customers-link">Customers page</Link>.
              </p>
              {selectedCustomer && (
                <div className="sell-page__loyalty" role="status" aria-live="polite">
                  <strong className="sell-page__loyalty-title">Keep {selectedCustomerDisplayName} coming back</strong>
                  <p className="sell-page__loyalty-text">
                    Enroll them in your loyalty program or apply any available rewards before completing checkout.
                  </p>
                  <div className="sell-page__loyalty-actions">
                    <Link to="/customers" className="button button--ghost button--small">
                      Enroll customer
                    </Link>
                    <Link to="/customers" className="button button--ghost button--small">
                      Apply rewards
                    </Link>
                  </div>
                </div>
              )}
            </div>

                <div className="sell-page__field-group">
                  <label className="field__label" htmlFor="sell-payment-method">Payment method</label>
                  <select
                    id="sell-payment-method"
                    value={paymentMethod}
                    onChange={event => setPaymentMethod(event.target.value as 'cash' | 'mobile' | 'card')}
                    className="sell-page__select"
                  >
                    <option value="cash">Cash</option>
                    <option value="mobile">Mobile money</option>
                    <option value="card">Card</option>
                  </select>
                </div>

                {paymentMethod === 'cash' && (
                  <div className="sell-page__field-group">
                    <label className="field__label" htmlFor="sell-amount-tendered">Cash received</label>
                    <input
                      id="sell-amount-tendered"
                      type="number"
                      min="0"
                      step="0.01"
                      value={amountTendered}
                      onChange={event => setAmountTendered(event.target.value)}
                      className="sell-page__input"
                    />
                  </div>
                )}
              </div>

              <div className="sell-page__payment-summary" aria-live="polite">
                <div>
                  <span className="sell-page__summary-label">Amount due</span>
                  <strong>GHS {subtotal.toFixed(2)}</strong>
                </div>
                <div>
                  <span className="sell-page__summary-label">Paid</span>
                  <strong>GHS {amountPaid.toFixed(2)}</strong>
                </div>
                <div className={`sell-page__change${isCashShort ? ' is-short' : ''}`}>
                  <span className="sell-page__summary-label">{isCashShort ? 'Short' : 'Change due'}</span>
                  <strong>GHS {changeDue.toFixed(2)}</strong>
                </div>
              </div>

              {saleError && <p className="sell-page__message sell-page__message--error">{saleError}</p>}
              {saleSuccess && (
                <div className="sell-page__message sell-page__message--success">
                  <span>{saleSuccess}</span>
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => window.print()}
                  >
                    Print again
                  </button>
                </div>
              )}

              {saleSuccess && receiptSharePayload && (
                <section className="sell-page__engagement" aria-live="polite">
                  <h4 className="sell-page__engagement-title">Share the receipt</h4>
                  <p className="sell-page__engagement-text">
                    Email, text, or WhatsApp the receipt so your customer has a digital copy right away.
                  </p>
                  <div className="sell-page__engagement-actions">
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={handleDownloadPdf}
                    >
                      Download PDF
                    </button>
                    <a
                      className="button button--ghost button--small"
                      href={receiptSharePayload.whatsappHref}
                    >
                      WhatsApp receipt
                    </a>
                    <a
                      className="button button--ghost button--small"
                      href={receiptSharePayload.emailHref}
                    >
                      Email receipt
                    </a>
                    <a
                      className="button button--ghost button--small"
                      href={receiptSharePayload.smsHref}
                    >
                      Text receipt
                    </a>
                  </div>
                  <details className="sell-page__engagement-details">
                    <summary>Preview message</summary>
                    <pre className="sell-page__engagement-preview">{receiptSharePayload.message}</pre>
                  </details>
                </section>
              )}

              <button
                type="button"
                className="button button--primary button--block"
                onClick={recordSale}
                disabled={cart.length === 0 || isRecording}
              >
                {isRecording ? 'Saving…' : 'Record sale'}
              </button>
            </>
          ) : (
            <div className="empty-state">
              <h3 className="empty-state__title">Cart is empty</h3>
              <p>Select products from the list to start a new sale.</p>
            </div>
          )}
        </section>
      </div>

      <div className={`receipt-print${receipt ? ' is-ready' : ''}`} aria-hidden={receipt ? 'false' : 'true'}>
        {receipt && (
          <div className="receipt-print__inner">
            <h2 className="receipt-print__title">Sedifex POS</h2>
            <p className="receipt-print__meta">
              {user?.email ?? 'sales@sedifex.app'}
              <br />
              {receipt.createdAt.toLocaleString()}
            </p>

            {receipt.customer && (
              <div className="receipt-print__section">
                <strong>Customer:</strong>
                <div>{receipt.customer.name}</div>
                {receipt.customer.phone && <div>{receipt.customer.phone}</div>}
                {receipt.customer.email && <div>{receipt.customer.email}</div>}
              </div>
            )}

            <table className="receipt-print__table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {receipt.items.map(line => (
                  <tr key={line.productId}>
                    <td>{line.name}</td>
                    <td>{line.qty}</td>
                    <td>GHS {(line.qty * line.price).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="receipt-print__summary">
              <div>
                <span>Subtotal</span>
                <strong>GHS {receipt.subtotal.toFixed(2)}</strong>
              </div>
              <div>
                <span>Paid ({receipt.payment.method})</span>
                <strong>GHS {receipt.payment.amountPaid.toFixed(2)}</strong>
              </div>
              <div>
                <span>Change</span>
                <strong>GHS {receipt.payment.changeDue.toFixed(2)}</strong>
              </div>
            </div>

            <p className="receipt-print__footer">Sale #{receipt.saleId} — Thank you for shopping with us!</p>
          </div>
        )}
      </div>
    </div>
  )
}
