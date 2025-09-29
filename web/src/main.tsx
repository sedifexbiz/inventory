import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import SheetAccessGuard from './SheetAccessGuard'
import Shell from './layout/Shell'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import Sell from './pages/Sell'
import Receive from './pages/Receive'
import CloseDay from './pages/CloseDay'
import Customers from './pages/Customers'
import Onboarding from './pages/Onboarding'
import GoalPlannerPage from './pages/KpiMetrics'
import AccountOverview from './pages/AccountOverview'
import { ToastProvider } from './components/ToastProvider'
import { ActiveStoreProvider } from './context/ActiveStoreProvider'

const router = createHashRouter([
  {
    path: '/',
    element: (
      <SheetAccessGuard>
        <App />
      </SheetAccessGuard>
    ),
    children: [
      { index: true, element: <Shell><Dashboard /></Shell> },
      { path: 'goals',     element: <Shell><GoalPlannerPage /></Shell> },
      { path: 'products',  element: <Shell><Products /></Shell> },
      { path: 'sell',      element: <Shell><Sell /></Shell> },
      { path: 'receive',   element: <Shell><Receive /></Shell> },
      { path: 'customers', element: <Shell><Customers /></Shell> },
      { path: 'close-day', element: <Shell><CloseDay /></Shell> },
      { path: 'onboarding', element: <Shell><Onboarding /></Shell> },
      { path: 'account',   element: <Shell><AccountOverview /></Shell> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <ActiveStoreProvider>
        <RouterProvider router={router} />
      </ActiveStoreProvider>
    </ToastProvider>
  </React.StrictMode>,
)
