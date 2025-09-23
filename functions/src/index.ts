import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

export const commitSale = functions.https.onCall(async (data, context) => {
  const { storeId, branchId, items, totals, cashierId, saleId } = data || {}
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required')
  const claims = context.auth.token as any
  if (!claims?.stores?.includes?.(storeId)) throw new functions.https.HttpsError('permission-denied', 'No store access')

  const saleRef = db.collection('sales').doc(saleId)
  const saleItemsRef = db.collection('saleItems')

  await db.runTransaction(async (tx) => {
    tx.set(saleRef, {
      storeId, branchId, cashierId,
      total: totals?.total ?? 0,
      taxTotal: totals?.taxTotal ?? 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    })

    for (const it of (items || [])) {
      const itemId = db.collection('_').doc().id
      tx.set(saleItemsRef.doc(itemId), {
        storeId, saleId, productId: it.productId, qty: it.qty, price: it.price, taxRate: it.taxRate
      })

      const pRef = db.collection('products').doc(it.productId)
      const pSnap = await tx.get(pRef)
      if (!pSnap.exists || pSnap.get('storeId') !== storeId) {
        throw new functions.https.HttpsError('failed-precondition', 'Bad product')
      }
      const curr = pSnap.get('stockCount') || 0
      const next = curr - Math.abs(it.qty || 0)
      tx.update(pRef, { stockCount: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() })

      const ledgerId = db.collection('_').doc().id
      tx.set(db.collection('ledger').doc(ledgerId), {
        storeId, branchId, productId: it.productId, qtyChange: -Math.abs(it.qty || 0),
        type: 'sale', refId: saleId, createdAt: admin.firestore.FieldValue.serverTimestamp()
      })
    }
  })

  return { ok: true, saleId }
})
