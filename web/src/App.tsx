import React, { useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPhoneNumber } from 'firebase/auth'
import { auth, setupRecaptcha } from './firebase'
import './pwa'

export default function App() {
  const [user, setUser] = useState<any>(null)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [confirmation, setConfirmation] = useState<any>(null)
  const [status, setStatus] = useState<string>('')

  useEffect(() => {
    return onAuthStateChanged(auth, setUser)
  }, [])

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    setStatus('Sending code...')
    const verifier = setupRecaptcha('recaptcha-container')
    const conf = await signInWithPhoneNumber(auth, phone, verifier)
    setConfirmation(conf)
    setStatus('Code sent.')
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault()
    setStatus('Verifying...')
    await confirmation.confirm(code)
    setStatus('Logged in.')
  }

  if (!user) {
    return (
      <div style={{maxWidth:480, margin:'40px auto', fontFamily:'Inter, system-ui, Arial'}}>
        <h1 style={{color:'#4338CA'}}>Sedifex</h1>
        <p>Sell faster. Count smarter.</p>

        <form onSubmit={sendCode} style={{marginTop:24}}>
          <label>Phone (E.164 e.g. +233...)</label>
          <input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+233..." style={{display:'block', width:'100%', padding:12, marginTop:8}} />
          <button type="submit" style={{marginTop:12, padding:'10px 16px', background:'#4338CA', color:'#fff', borderRadius:8, border:0}}>Send Code</button>
        </form>

        {confirmation && (
          <form onSubmit={verifyCode} style={{marginTop:16}}>
            <label>Enter code</label>
            <input value={code} onChange={e=>setCode(e.target.value)} style={{display:'block', width:'100%', padding:12, marginTop:8}} />
            <button type="submit" style={{marginTop:12, padding:'10px 16px', background:'#4338CA', color:'#fff', borderRadius:8, border:0}}>Verify</button>
          </form>
        )}

        <p style={{marginTop:12}}>{status}</p>
      </div>
    )
  }

  return (
    <div style={{maxWidth:720, margin:'40px auto', fontFamily:'Inter, system-ui, Arial'}}>
      <h1 style={{color:'#4338CA'}}>Sedifex</h1>
      <p>Logged in as <strong>{user.phoneNumber || user.email}</strong></p>
      <ul style={{marginTop:24, lineHeight:1.8}}>
        <li>Installable PWA (Manifest + Service Worker)</li>
        <li>Firebase Auth (Phone)</li>
        <li>Ready to add Firestore collections (products, sales, etc.)</li>
      </ul>
      <p style={{marginTop:24}}>Start building your <strong>Sell</strong>, <strong>Products</strong>, and <strong>Close-of-day</strong> screens here.</p>
    </div>
  )
}
