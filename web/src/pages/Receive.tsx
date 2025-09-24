import React, { useEffect, useMemo, useState } from 'react'
import { collection, query, where, orderBy, onSnapshot, doc, updateDoc } from 'firebase/firestore'
import { db, auth } from '../firebase'

type Product = { id: string; name: string; stockCount?: number; storeId: string }

export default function Receive() {
  const user = auth.currentUser
  const STORE_ID = useMemo(() => user?.uid || null, [user?.uid])

  const [products, setProducts] = useState<Product[]>([])
  const [selected, setSelected] = useState<string>('')
  const [qty, setQty] = useState<string>('')

  useEffect(() => {
    if (!STORE_ID) return
    const q = query(collection(db,'products'), where('storeId','==',STORE_ID), orderBy('name'))
    return onSnapshot(q, snap => setProducts(snap.docs.map(d=>({id:d.id, ...(d.data() as any)}))))
  }, [STORE_ID])

  async function receive() {
    if (!selected || qty === '') return
    const p = products.find(x=>x.id===selected); if (!p) return
    await updateDoc(doc(db,'products', selected), { stockCount: (p.stockCount || 0) + Number(qty) })
    setQty('')
  }

  if (!STORE_ID) return <div>Loading…</div>

  return (
    <div>
      <h2 style={{color:'#4338CA'}}>Receive Stock</h2>
      <div style={{display:'flex', gap:8}}>
        <select value={selected} onChange={e=>setSelected(e.target.value)} style={{padding:8}}>
          <option value="">Select product…</option>
          {products.map(p=><option key={p.id} value={p.id}>{p.name} (Stock {p.stockCount ?? 0})</option>)}
        </select>
        <input type="number" min={1} placeholder="Qty" value={qty} onChange={e=>setQty(e.target.value)} style={{padding:8, width:120}} />
        <button onClick={receive} style={{padding:'8px 12px', background:'#4338CA', color:'#fff', border:0, borderRadius:8}}>Add Stock</button>
      </div>
    </div>
  )
}
