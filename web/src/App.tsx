import React, { useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth'
import { auth } from './firebase'
import './pwa'

export default function App() {
  const [user, setUser] = useState<any>(null)
  const [mode, setMode] = useState<'login'|'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => onAuthStateChanged(auth, setUser), [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus(mode === 'login' ? 'Signing in…' : 'Creating account…')
    try {
      if (mode === 'login') {
        await signInWithEmailAndPassword(auth, email, password)
      } else {
        await createUserWithEmailAndPassword(auth, email, password)
      }
      setStatus('Success')
    } catch (err: any) {
      setStatus(err.message || 'Error')
    }
  }

  if (!user) {
    return (
      <div style={{maxWidth:480, margin:'40px auto', fontFamily:'Inter, system-ui, Arial'}}>
        <h1 style={{color:'#4338CA'}}>Sedifex</h1>
        <p>Sell faster. Count smarter.</p>

        <div style={{marginTop:16}}>
          <button
            onClick={() => setMode('login')}
            style={{marginRight:8, padding:'6px 10px', borderRadius:8, border: mode==='login'?'2px solid #4338CA':'1px solid #ddd', background:'#fff'}}
          >Login</button>
          <button
            onClick={() => setMode('signup')}
            style={{padding:'6px 10px', borderRadius:8, border: mode==='signup'?'2px solid #4338CA':'1px solid #ddd', background:'#fff'}}
          >Sign up</button>
        </div>

        <form onSubmit={handleSubmit} style={{marginTop:16}}>
          <label>Email</label>
          <input value={email} onChange={e=>setEmail(e.target.value)} type="email" required
                 style={{display:'block', width:'100%', padding:12, marginTop:8}} />
          <label style={{marginTop:12, display:'block'}}>Password</label>
          <input value={password} onChange={e=>setPassword(e.target.value)} type="password" required
                 style={{display:'block', width:'100%', padding:12, marginTop:8}} />
          <button type="submit"
                  style={{marginTop:12, padding:'10px 16px', background:'#4338CA', color:'#fff', borderRadius:8, border:0}}>
            {mode==='login' ? 'Login' : 'Create account'}
          </button>
        </form>

        <p style={{marginTop:12, color:'#555'}}>{status}</p>
      </div>
    )
  }

  return (
    <div style={{maxWidth:720, margin:'40px auto', fontFamily:'Inter, system-ui, Arial'}}>
      <h1 style={{color:'#4338CA'}}>Sedifex</h1>
      <p>Logged in as <strong>{user.email}</strong></p>
      <button onClick={() => signOut(auth)}
              style={{marginTop:12, padding:'8px 12px', borderRadius:8, border:'1px solid #ddd'}}>Sign out</button>
      <p style={{marginTop:24}}>Next: Products & Sell screen.</p>
    </div>
  )
}
