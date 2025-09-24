import React, { useEffect, useMemo, useState } from 'react'
import { collection, query, where, orderBy, onSnapshot, Timestamp } from 'firebase/firestore'
import { db, auth } from '../firebase'

type Sale = { total: number; createdAt?: any; storeId: string }

export default function CloseDay() {
  const user = auth.currentUser
  const STORE_ID = useMemo(() => user?.uid || null, [user?.uid])

  const [total, setTotal] = useState(0)

  useEffect(() => {
    if (!STORE_ID) return
    const start = new Date(); start.setHours(0,0,0,0)
    const q = query(
      collection(db,'sales'),
      where('storeId','==',STORE_ID),
      where('createdAt','>=', Timestamp.fromDate(start)),
      orderBy('createdAt','desc')
    )
    return onSnapshot(q, snap => {
      let sum = 0
      snap.forEach(d => sum += (d.data().total || 0))
      setTotal(sum)
    })
  }, [STORE_ID])

  if (!STORE_ID) return <div>Loading…</div>

  return (
    <div>
      <h2 style={{color:'#4338CA'}}>Close Day</h2>
      <p>Today’s sales total</p>
      <div style={{fontSize:32, fontWeight:800}}>GHS {total.toFixed(2)}</div>
      <p style={{marginTop:12}}>Next: cash count & variance sheet.</p>
    </div>
  )
}
