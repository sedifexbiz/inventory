import React, { useEffect, useMemo, useState } from 'react'
import {
  collection, addDoc, onSnapshot, query, where, orderBy,
  doc, updateDoc, deleteDoc
} from 'firebase/firestore'
import { db, auth } from '../firebase'

type Product = {
  id?: string
  storeId: string
  name: string
  price: number
  stockCount?: number
  barcode?: string
  minStock?: number
  updatedAt?: number
}

export default function Products() {
  const user = auth.currentUser
  const STORE_ID = useMemo(() => user?.uid || null, [user?.uid])

  const [items, setItems] = useState<Product[]>([])
  const [name, setName] = useState('')
  const [price, setPrice] = useState<string>('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState<string>('')
  const [editStock, setEditStock] = useState<string>('')

  useEffect(() => {
    if (!STORE_ID) return
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
  }, [STORE_ID])

  async function addProduct(e: React.FormEvent) {
    e.preventDefault()
    if (!STORE_ID || !name || price === '') return
    await addDoc(collection(db, 'products'), {
      storeId: STORE_ID,
      name,
      price: Number(price),
      stockCount: 0,
      updatedAt: Date.now()
    })
    setName(''); setPrice('')
  }

  function beginEdit(p: Product) {
    setEditing(p.id!)
    setEditName(p.name)
    setEditPrice(String(p.price))
    setEditStock(String(p.stockCount ?? 0))
  }

  async function saveEdit(id: string) {
    await updateDoc(doc(db, 'products', id), {
      name: editName,
      price: Number(editPrice),
      stockCount: Number(editStock),
      updatedAt: Date.now()
    })
    setEditing(null)
  }

  async function remove(id: string) {
    await deleteDoc(doc(db, 'products', id))
  }

  if (!STORE_ID) return <div>Loading…</div>

  return (
    <div>
      <h2 style={{color:'#4338CA'}}>Products</h2>

      <form onSubmit={addProduct} style={{display:'grid', gridTemplateColumns:'2fr 1fr auto', gap:8, marginTop:12}}>
        <input placeholder="Name" value={name} onChange={e=>setName(e.target.value)} />
        <input placeholder="Price (GHS)" type="number" min={0} step="0.01"
               value={price} onChange={e=>setPrice(e.target.value)} />
        <button type="submit" style={{background:'#4338CA', color:'#fff', border:0, borderRadius:8, padding:'8px 12px'}}>Add</button>
      </form>

      <table style={{width:'100%', marginTop:16, borderCollapse:'collapse'}}>
        <thead>
          <tr>
            <th align="left">Name</th>
            <th align="right">Price (GHS)</th>
            <th align="right">Stock</th>
            <th align="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map(p=>(
            <tr key={p.id} style={{borderTop:'1px solid #eee'}}>
              <td>
                {editing===p.id
                  ? <input value={editName} onChange={e=>setEditName(e.target.value)} />
                  : p.name}
              </td>
              <td align="right">
                {editing===p.id
                  ? <input style={{textAlign:'right'}} type="number" min={0} step="0.01"
                           value={editPrice} onChange={e=>setEditPrice(e.target.value)} />
                  : p.price?.toFixed(2)}
              </td>
              <td align="right">
                {editing===p.id
                  ? <input style={{textAlign:'right'}} type="number" min={0} step="1"
                           value={editStock} onChange={e=>setEditStock(e.target.value)} />
                  : (p.stockCount ?? 0)}
              </td>
              <td align="right" style={{whiteSpace:'nowrap'}}>
                {editing===p.id ? (
                  <>
                    <button onClick={()=>saveEdit(p.id!)} style={{marginRight:8}}>Save</button>
                    <button onClick={()=>setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={()=>beginEdit(p)} style={{marginRight:8}}>Edit</button>
                    <button onClick={()=>remove(p.id!)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
