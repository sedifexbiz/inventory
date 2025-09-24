import React from 'react'

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{fontFamily:'Inter, system-ui, Arial'}}>
      <header style={{position:'sticky', top:0, background:'#fff', borderBottom:'1px solid #eee'}}>
        <div style={{maxWidth:1000, margin:'0 auto', padding:'12px 16px', display:'flex', alignItems:'center', gap:16}}>
          <div style={{fontSize:24, fontWeight:800, color:'#4338CA'}}>Sedifex</div>
          <nav style={{display:'flex', gap:12}}>
            <a href="#/"          >Dashboard</a>
            <a href="#/products"  >Products</a>
            <a href="#/sell"      >Sell</a>
            <a href="#/receive"   >Receive</a>
            <a href="#/close-day" >Close Day</a>
            <a href="#/settings"  >Settings</a>
          </nav>
        </div>
      </header>
      <main style={{maxWidth:1000, margin:'0 auto', padding:'16px'}}>{children}</main>
    </div>
  )
}
