import React, { useEffect, useMemo, useState } from 'react'
import { collection, query, where, orderBy, onSnapshot, doc, writeBatch, addDoc, serverTimestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'

type Product = { id: string; name: string; price: number; stockCount?: number; storeId: string }
type CartLine = { productId: string; name: string; price: number; qty: number }

export default function Sell() {
  const user = auth.currentUser
  const STORE_ID = useMemo(() => user?.uid || null, [user?.uid])

  const [products, setProducts] = useState<Product[]>([])
  const [queryText, setQueryText] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0)

  useEffect(() => {
    if (!STORE_ID) return
    const q = query(collection(db,'products'), where('storeId','==',STORE_ID), orderBy('name'))
    return onSnapshot(q, snap => {
      setProducts(snap.docs.map(d => ({ id:d.id, ...(d.data() as any) })))
    })
  }, [STORE_ID])

  function addToCart(p: Product) {
    setCart(cs => {
      const i = cs.findIndex(x => x.productId === p.id)
      if (i >= 0) {
        const copy = [...cs]; copy[i] = { ...copy[i], qty: copy[i].qty + 1 }; return copy
      }
      return [...cs, { productId: p.id, name: p.name, price: p.price, qty: 1 }]
    })
  }
  function setQty(id: string, qty: number) {
    setCart(cs => cs.map(l => l.productId === id ? { ...l, qty: Math.max(0, qty) } : l).filter(l => l.qty > 0))
  }
  async function recordSale() {
    if (!STORE_ID || cart.length === 0) return
    // 1) write a sale with items array
    const saleRef = await addDoc(collection(db, 'sales'), {
      storeId: STORE_ID,
      createdAt: serverTimestamp(),
      items: cart,
      total: subtotal
    })
    // 2) decrement stock with a batch
    const batch = writeBatch(db)
    cart.forEach(line => {
      const pRef = doc(db,'products', line.productId)
      const p = products.find(x=>x.id===line.productId)
      const next = Math.max(0, (p?.stockCount || 0) - line.qty)
      batch.update(pRef, { stockCount: next })
    })
    await batch.commit()
    setCart([])
    alert(`Sale recorded #${saleRef.id}`)
  }

  if (!STORE_ID) return <div>Loading…</div>

  const filtered = products.filter(p => p.name.toLowerCase().includes(queryText.toLowerCase()))

  return (
    <div>
      <h2 style={{color:'#4338CA'}}>Sell</h2>

      <input
        placeholder="Search product…"
        value={queryText}
        onChange={e=>setQueryText(e.target.value)}
        style={{width:'100%', padding:10, margin:'8px 0'}}
      />

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
        <div>
          <h3>Products</h3>
          <div style={{maxHeight:320, overflow:'auto', border:'1px solid #eee', borderRadius:8}}>
            {filtered.map(p=>(
              <div key={p.id} style={{display:'flex', justifyContent:'space-between', padding:'8px 12px', borderBottom:'1px solid #f3f3f3'}}>
                <div>
                  <div>{p.name}</div>
                  <small>GHS {p.price.toFixed(2)} • Stock {p.stockCount ?? 0}</small>
                </div>
                <button onClick={()=>addToCart(p)}>Add</button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3>Cart</h3>
          <table style={{width:'100%', borderCollapse:'collapse'}}>
            <thead><tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Price</th></tr></thead>
            <tbody>
              {cart.map(l=>(
                <tr key={l.productId} style={{borderTop:'1px solid #eee'}}>
                  <td>{l.name}</td>
                  <td align="right">
                    <input type="number" min={0} value={l.qty}
                           onChange={e=>setQty(l.productId, Number(e.target.value))}
                           style={{width:70, textAlign:'right'}} />
                  </td>
                  <td align="right">GHS {(l.price*l.qty).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{display:'flex', justifyContent:'space-between', marginTop:12, fontWeight:700}}>
            <div>Total</div>
            <div>GHS {subtotal.toFixed(2)}</div>
          </div>

          <button onClick={recordSale}
                  style={{marginTop:12, background:'#4338CA', color:'#fff', border:0, borderRadius:8, padding:'10px 14px'}}
                  disabled={cart.length===0}>
            Record Sale
          </button>
        </div>
      </div>
    </div>
  )
}
