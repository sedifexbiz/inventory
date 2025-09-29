// web/src/pages/Gate.tsx
import type { ReactNode } from 'react'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import { useMemberships } from '../hooks/useMemberships'

function toErrorMessage(error: unknown) {
  if (!error) return 'Something went wrong. Please try again.'
  if (error instanceof Error) return error.message || 'Something went wrong. Please try again.'
  try {
    return JSON.stringify(error)
  } catch (serializationError) {
    return String(error)
  }
}

export default function Gate({ children }: { children?: ReactNode }) {
  const { storeId, isLoading: storeLoading } = useActiveStoreContext()
  const membershipsStoreId = storeLoading ? undefined : storeId ?? null
  const { loading, error } = useMemberships(membershipsStoreId)

  if (storeLoading || loading) {
    return <div className="p-6">Loading…</div>
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">We couldn't load your workspace</h1>
        <p className="text-sm text-red-600">{toErrorMessage(error)}</p>
      </div>
    )
  }

  return <>{children}</>
}
