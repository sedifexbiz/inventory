import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const toast = vi.hoisted(() => ({
  publish: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('./ToastProvider', () => ({
  useToast: () => toast,
}))

import { AppErrorBoundary } from './AppErrorBoundary'

describe('AppErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    toast.publish.mockClear()
    toast.dismiss.mockClear()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy?.mockRestore()
  })

  it('renders a fallback UI, surfaces the error, and leaves surrounding UI intact', async () => {
    function ProblemChild() {
      throw new Error('Kaboom!')
    }

    render(
      <div>
        <span>App chrome</span>
        <AppErrorBoundary>
          <ProblemChild />
        </AppErrorBoundary>
      </div>,
    )

    expect(await screen.findByRole('heading', { name: /something went wrong/i })).toBeInTheDocument()
    expect(screen.getByText('App chrome')).toBeInTheDocument()
    expect(screen.getByTestId('app-error-boundary-details')).toHaveTextContent('Kaboom!')
    expect(toast.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'error',
        message: expect.stringContaining('Kaboom!'),
      }),
    )
  })
})
