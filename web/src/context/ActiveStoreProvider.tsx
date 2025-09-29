import { createContext, ReactNode, useContext } from 'react'
import { useActiveStore } from '../hooks/useActiveStore'

const ActiveStoreContext = createContext<ReturnType<typeof useActiveStore> | undefined>(undefined)

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
