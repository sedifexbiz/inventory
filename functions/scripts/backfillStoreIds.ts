import * as admin from 'firebase-admin'

const TARGET_STORE_ID = (process.argv[2] ?? '').trim()

if (!TARGET_STORE_ID) {
  console.error('Usage: npm run backfill-store <storeId>')
  process.exit(1)
}

if (!admin.apps.length) {
  admin.initializeApp()
}

const db = admin.firestore()

async function commitBatch(batch: admin.firestore.WriteBatch, writes: number) {
  if (writes === 0) {
    return 0
  }
  await batch.commit()
  return 0
}

function resolveStoreId(doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>) {
  const data = doc.data() || {}
  const storeId = typeof data.storeId === 'string' ? data.storeId.trim() : ''
  if (storeId) return storeId
  const branchId = typeof data.branchId === 'string' ? data.branchId.trim() : ''
  if (branchId) return branchId
  return TARGET_STORE_ID
}

async function backfillCollection(
  collectionName: string,
  resolver: (
    doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>,
    existingStore: string,
  ) => { storeId: string; updates?: Record<string, unknown> } | null,
) {
  const snapshot = await db.collection(collectionName).get()
  let batch = db.batch()
  let writes = 0
  let processed = 0

  for (const doc of snapshot.docs) {
    processed += 1
    const existingStore = resolveStoreId(doc)
    const result = resolver(doc, existingStore)
    if (!result) continue
    batch.update(doc.ref, result.updates ? { storeId: result.storeId, ...result.updates } : { storeId: result.storeId })
    writes += 1
    if (writes >= 400) {
      writes = await commitBatch(batch, writes)
      batch = db.batch()
    }
  }

  await commitBatch(batch, writes)
  console.log(`Backfilled ${processed} documents in ${collectionName}`)
}

async function run() {
  const saleStoreMap = new Map<string, string>()

  await backfillCollection('products', (_doc, storeId) => {
    return { storeId }
  })

  await backfillCollection('customers', (_doc, storeId) => {
    return { storeId }
  })

  await backfillCollection('sales', (doc, existingStore) => {
    saleStoreMap.set(doc.id, existingStore)
    return { storeId: existingStore, updates: { branchId: existingStore } }
  })

  await backfillCollection('saleItems', (doc, existingStore) => {
    const parentSaleId = typeof doc.get('saleId') === 'string' ? (doc.get('saleId') as string) : ''
    const resolved = saleStoreMap.get(parentSaleId) ?? existingStore
    return { storeId: resolved }
  })

  await backfillCollection('ledger', (doc, existingStore) => {
    const refId = typeof doc.get('refId') === 'string' ? (doc.get('refId') as string) : ''
    const resolved = saleStoreMap.get(refId) ?? existingStore
    return { storeId: resolved }
  })

  console.log('Backfill complete.')
}

run().catch(error => {
  console.error('Backfill failed', error)
  process.exit(1)
})
