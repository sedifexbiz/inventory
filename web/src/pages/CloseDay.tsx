import React, { useEffect, useMemo, useState } from 'react'
import { collection, query, where, orderBy, onSnapshot, Timestamp, addDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuthUser } from '../hooks/useAuthUser'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import { DEFAULT_CURRENCY_SYMBOL, formatCurrency } from '@shared/currency'

const DENOMINATIONS = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1] as const

type CashCountState = Record<string, string>

function createInitialCashCountState(): CashCountState {
  return DENOMINATIONS.reduce<CashCountState>((acc, denom) => {
    acc[String(denom)] = ''
    return acc
  }, {})
}

function parseCurrency(input: string): number {
  if (!input) return 0
  const normalized = input.replace(/[^0-9.-]/g, '')
  const value = Number.parseFloat(normalized)
  return Number.isFinite(value) ? value : 0
}

function parseQuantity(input: string): number {
  if (!input) return 0
  const normalized = input.replace(/[^0-9]/g, '')
  const value = Number.parseInt(normalized, 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export default function CloseDay() {
  const user = useAuthUser()
  const { storeId: activeStoreId, storeChangeToken } = useActiveStoreContext()

  const [total, setTotal] = useState(0)
  const [cashCounts, setCashCounts] = useState<CashCountState>(() => createInitialCashCountState())
  const [looseCash, setLooseCash] = useState('')
  const [cardAndDigital, setCardAndDigital] = useState('')
  const [cashRemoved, setCashRemoved] = useState('')
  const [cashAdded, setCashAdded] = useState('')
  const [notes, setNotes] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    setTotal(0)
    if (!activeStoreId) {
      setTotal(0)
      return () => {
        /* noop */
      }
    }

    const q = query(
      collection(db, 'sales'),
      where('storeId', '==', activeStoreId),
      where('createdAt', '>=', Timestamp.fromDate(start)),
      orderBy('createdAt', 'desc')
    )
    return onSnapshot(q, snap => {
      let sum = 0
      snap.forEach(d => sum += (d.data().total || 0))
      setTotal(sum)
    })
  }, [activeStoreId, storeChangeToken])

  useEffect(() => {
    setCashCounts(createInitialCashCountState())
    setLooseCash('')
    setCardAndDigital('')
    setCashRemoved('')
    setCashAdded('')
    setNotes('')
    setSubmitError(null)
    setSubmitSuccess(false)
    setIsSubmitting(false)
  }, [storeChangeToken])

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `@page { size: A5 portrait; margin: 0.5in; }
      @media print {
        body {
          margin: 0;
        }
        .no-print {
          display: none !important;
        }
        .print-summary {
          box-sizing: border-box;
          width: 100% !important;
          max-width: none !important;
          padding: 0 !important;
          margin: 0 !important;
        }
        .print-summary h2 {
          margin-bottom: 8px !important;
          font-size: 20px !important;
        }
        .print-summary__section {
          margin-top: 12px !important;
          padding-top: 8px !important;
          page-break-inside: avoid;
        }
        .print-summary__total {
          font-size: 24px !important;
          margin-bottom: 12px !important;
        }
      }`
    document.head.appendChild(style)
    return () => {
      document.head.removeChild(style)
    }
  }, [])

  const looseCashTotal = useMemo(() => parseCurrency(looseCash), [looseCash])

  const countedCash = useMemo(() => {
    return DENOMINATIONS.reduce((sum, denom) => {
      const count = parseQuantity(cashCounts[String(denom)])
      return sum + denom * count
    }, 0) + looseCashTotal
  }, [cashCounts, looseCashTotal])

  const cardTotal = useMemo(() => parseCurrency(cardAndDigital), [cardAndDigital])
  const removedTotal = useMemo(() => parseCurrency(cashRemoved), [cashRemoved])
  const addedTotal = useMemo(() => parseCurrency(cashAdded), [cashAdded])

  const expectedCash = useMemo(() => {
    const computed = total - cardTotal - removedTotal + addedTotal
    return Number.isFinite(computed) ? computed : 0
  }, [addedTotal, cardTotal, removedTotal, total])

  const variance = useMemo(() => countedCash - expectedCash, [countedCash, expectedCash])

  const handleCountChange = (denom: number, value: string) => {
    setCashCounts(prev => ({ ...prev, [String(denom)]: value }))
  }

  const handlePrint = () => {
    window.print()
  }

  const handleExportCSV = () => {
    const now = new Date()
    const fileTimestamp = now.toISOString().split('T')[0]
    const formatAmount = (value: number) => value.toFixed(2)
    const csvEscape = (value: string | number) => {
      const stringValue = String(value ?? '')
      if (/[",\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`
      }
      return stringValue
    }

    const rows: Array<Array<string | number>> = []
    rows.push(['Close Day Summary'])
    rows.push(['Date/Time', now.toLocaleString()])
    rows.push(['Store ID', activeStoreId ?? 'N/A'])
    rows.push([])

    rows.push(['Sales Summary'])
    rows.push(['Metric', `Amount (${DEFAULT_CURRENCY_SYMBOL})`])
    rows.push(['Sales total', formatAmount(total)])
    rows.push(['Expected cash', formatAmount(expectedCash)])
    rows.push(['Counted cash', formatAmount(countedCash)])
    rows.push(['Variance', formatAmount(variance)])
    rows.push([])

    rows.push(['Tender Breakdown'])
    rows.push(['Tender type', `Amount (${DEFAULT_CURRENCY_SYMBOL})`])
    rows.push(['Card & digital payments', formatAmount(cardTotal)])
    rows.push(['Cash removed (drops, payouts)', formatAmount(removedTotal)])
    rows.push(['Cash added (float top-ups)', formatAmount(addedTotal)])
    rows.push(['Loose cash / coins', formatAmount(looseCashTotal)])
    rows.push([])

    rows.push(['Cash Denominations'])
    rows.push([
      `Denomination (${DEFAULT_CURRENCY_SYMBOL})`,
      'Quantity',
      `Subtotal (${DEFAULT_CURRENCY_SYMBOL})`,
    ])
    DENOMINATIONS.forEach(denom => {
      const key = String(denom)
      const quantity = parseQuantity(cashCounts[key])
      const subtotal = denom * quantity
      rows.push([denom.toFixed(denom % 1 === 0 ? 0 : 2), quantity, subtotal.toFixed(2)])
    })
    rows.push(['Loose cash / coins', '', formatAmount(looseCashTotal)])
    rows.push([])

    rows.push(['Notes'])
    rows.push([notes.trim() || ''])

    const csvContent = rows
      .map(row => row.map(csvEscape).join(','))
      .join('\r\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `close-day-${fileTimestamp}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async event => {
    event.preventDefault()
    setSubmitError(null)
    setSubmitSuccess(false)
    setIsSubmitting(true)

    try {
      if (!activeStoreId) {
        throw new Error('Select a workspace before recording a close-out.')
      }
      const start = new Date(); start.setHours(0, 0, 0, 0)
      const closePayload = {
        businessDay: Timestamp.fromDate(start),
        salesTotal: total,
        expectedCash,
        countedCash,
        variance,
        looseCash: looseCashTotal,
        cardAndDigital: cardTotal,
        cashRemoved: removedTotal,
        cashAdded: addedTotal,
        denominations: DENOMINATIONS.map(denom => {
          const quantity = parseQuantity(cashCounts[String(denom)])
          return {
            denomination: denom,
            quantity,
            subtotal: denom * quantity,
          }
        }),
        notes: notes.trim() || null,
        closedBy: user
          ? {
              uid: user.uid,
              displayName: user.displayName || null,
              email: user.email || null,
              phoneNumber: user.phoneNumber || null,
              photoURL: user.photoURL || null,
            }
          : null,
        closedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        storeId: activeStoreId,
      }

      await addDoc(collection(db, 'closeouts'), closePayload)
      setSubmitSuccess(true)
      setCashCounts(createInitialCashCountState())
      setLooseCash('')
      setCardAndDigital('')
      setCashRemoved('')
      setCashAdded('')
      setNotes('')
    } catch (error) {
      console.error('[close-day] Failed to record closeout', error)
      setSubmitError('We were unable to save the close day record. Please retry.')
    } finally {
      setIsSubmitting(false)
    }
  }



  const workspaceEmptyState = (
    <div className="empty-state">
      <h3 className="empty-state__title">Select a workspace…</h3>
      <p>Choose a workspace from the switcher above to continue.</p>
    </div>
  )

  if (!activeStoreId) {
    return (
      <div className="print-summary" style={{ maxWidth: 760 }}>
        <h2 style={{ color: '#4338CA' }}>Close Day</h2>
        {workspaceEmptyState}
      </div>
    )
  }

  return (
    <div className="print-summary" style={{ maxWidth: 760 }}>
      <h2 style={{ color: '#4338CA' }}>Close Day</h2>

      <form className="print-summary__form" onSubmit={handleSubmit}>
        <section className="print-summary__section" style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Sales Summary</h3>
          <p style={{ marginBottom: 8 }}>Today’s sales total</p>
          <div className="print-summary__total" style={{ fontSize: 32, fontWeight: 800, marginBottom: 16 }}>{formatCurrency(total)}</div>
          <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Card &amp; digital payments</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={cardAndDigital}
                onChange={event => setCardAndDigital(event.target.value)}
                placeholder="0.00"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Cash removed (drops, payouts)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={cashRemoved}
                onChange={event => setCashRemoved(event.target.value)}
                placeholder="0.00"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Cash added (float top-ups)</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={cashAdded}
                onChange={event => setCashAdded(event.target.value)}
                placeholder="0.00"
              />
            </label>
          </div>
        </section>

        <section style={{ marginTop: 32 }}>
          <h3 style={{ marginBottom: 12 }}>Cash Count</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #d1d5db', padding: '6px 4px' }}>Denomination</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #d1d5db', padding: '6px 4px' }}>Quantity</th>
                  <th style={{ textAlign: 'right', borderBottom: '1px solid #d1d5db', padding: '6px 4px' }}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {DENOMINATIONS.map(denom => {
                  const key = String(denom)
                  const quantity = parseQuantity(cashCounts[key])
                  const subtotal = denom * quantity
                  return (
                    <tr key={key}>
                      <td style={{ padding: '6px 4px' }}>
                        {formatCurrency(denom, {
                          minimumFractionDigits: denom % 1 === 0 ? 0 : 2,
                          maximumFractionDigits: denom % 1 === 0 ? 0 : 2,
                        })}
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="1"
                          value={cashCounts[key]}
                          onChange={event => handleCountChange(denom, event.target.value)}
                          style={{ width: '100%' }}
                        />
                      </td>
                      <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatCurrency(subtotal)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ padding: '6px 4px' }}>Loose cash / coins</td>
                  <td style={{ padding: '6px 4px' }} colSpan={2}>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={looseCash}
                      onChange={event => setLooseCash(event.target.value)}
                      style={{ width: '100%' }}
                      placeholder="0.00"
                    />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section style={{ marginTop: 32 }}>
          <h3 style={{ marginBottom: 8 }}>Variance</h3>
          <div style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Expected cash</span>
              <strong>{formatCurrency(expectedCash)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Counted cash</span>
              <strong>{formatCurrency(countedCash)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Variance</span>
              <strong style={{ color: Math.abs(variance) > 0.009 ? '#b91c1c' : '#047857' }}>
                {formatCurrency(variance)}
              </strong>
            </div>
          </div>
        </section>

        <section style={{ marginTop: 32 }}>
          <h3 style={{ marginBottom: 8 }}>Notes</h3>
          <textarea
            value={notes}
            onChange={event => setNotes(event.target.value)}
            rows={4}
            style={{ width: '100%', resize: 'vertical' }}
            placeholder="Include context for discrepancies or reminders for the next shift."
          />
        </section>

        {submitError && (
          <p style={{ color: '#b91c1c', marginTop: 16 }}>{submitError}</p>
        )}
        {submitSuccess && (
          <p style={{ color: '#047857', marginTop: 16 }}>Close day record saved successfully.</p>
        )}

        <div className="no-print" style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button type="button" onClick={handleExportCSV} style={{ padding: '10px 16px' }}>
            Export CSV
          </button>
          <button type="button" onClick={handlePrint} style={{ padding: '10px 16px' }}>
            Print summary
          </button>
          <button
            type="submit"
            style={{ padding: '10px 16px', background: '#4338CA', color: 'white', border: 'none' }}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Saving…' : 'Save close day record'}
          </button>
        </div>
      </form>
    </div>
  )
}
