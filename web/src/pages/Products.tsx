import React, { useEffect, useState } from 'react'
import { collection, addDoc, onSnapshot, query, where, orderBy } from 'firebase/firestore'
import { db } from '../firebase'

type Product = {
  id?: string
  storeId: string
  name: string
  price: number
  barcode?: string
  minStock?: number
  updatedAt?: number
}

const STORE_ID = 'demo-store' // temporary; we’ll replace with real store selection later

export default function Products() {
  const [items, setItems] = useState<Product[]>([])
  const [name, setName] = useState('')
  const [price, setPrice] = useState<number | ''>('')

  useEffect(() => {
    const q = query(
      collection(db, 'products'),
      where('storeId', '==', STORE_ID),
      orderBy('name')
    )
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as Product) }))
      setItems(rows)
    })
    return () => unsub()
  }, [])

  async function addProduct(e: React.FormEvent) {
    e.preventDefault()
    if (!name || price === '') return
    await addDoc(collection(db, 'products'), {
      storeId: STORE_ID,
      name,
      price: Number(price),
      updatedAt: Date.now()
    })
    setName('')
    setPrice('')
  }

  return (
    <div style={{maxWidth:720, margin:'24px auto', fontFamily:'Inter, system-ui, Arial'}}>
      <h2 style={{color:'#4338CA'}}>Products</h2>
      <form onSubmit={addProduct} style={{display:'grid', gridTemplateColumns:'2fr 1fr auto', gap:8, marginTop:12}}>
        <input placeholder="Name" value={name} onChange={e=>setName(e.target.value)} />
        <input placeholder="Price (GHS)" type="number" min={0} step="0.01"
               value={price} onChange={e=>setPrice(e.target.value === '' ? '' : Number(e.target.value))} />
        <button type="submit" style={{background:'#4338CA', color:'#fff', border:0, borderRadius:8, padding:'8px 12px'}}>Add</button>
      </form>

      <table style={{width:'100%', marginTop:16, borderCollapse:'collapse'}}>
        <thead><tr><th align="left">Name</th><th align="right">Price (GHS)</th></tr></thead>
        <tbody>
          {items.map(p=>(
            <tr key={p.id} style={{borderTop:'1px solid #eee'}}>
              <td>{p.name}</td>
              <td align="right">{p.price?.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
