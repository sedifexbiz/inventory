import { createContext, useContext } from 'react'
import type { User } from 'firebase/auth'

export const AuthUserContext = createContext<User | null>(null)

export function useAuthUser() {
  return useContext(AuthUserContext)
}
