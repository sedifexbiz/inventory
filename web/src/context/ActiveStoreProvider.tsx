import { createContext, ReactNode, useContext } from 'react'

import { useActiveStore } from '../hooks/useActiveStore'

type ActiveStoreContextValue = ReturnType<typeof useActiveStore>

const ActiveStoreContext = createContext<ActiveStoreContextValue | undefined>(undefined)

interface ActiveStoreProviderProps {
  children: ReactNode
}

export function ActiveStoreProvider({ children }: ActiveStoreProviderProps) {
  const value = useActiveStore()

  return <ActiveStoreContext.Provider value={value}>{children}</ActiveStoreContext.Provider>
}

export function useActiveStoreContext() {
  const context = useContext(ActiveStoreContext)

  if (context === undefined) {
    throw new Error('useActiveStoreContext must be used within an ActiveStoreProvider')
  }

  return context
}
