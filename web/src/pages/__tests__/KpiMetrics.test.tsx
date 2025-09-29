import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

import GoalPlannerPage from '../KpiMetrics'
import Shell from '../../layout/Shell'

const mockUseAuthUser = vi.fn(() => ({ uid: 'user-1', email: 'manager@example.com' }))
vi.mock('../../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

const mockUseActiveStoreContext = vi.fn(() => ({ storeId: 'store-1', isLoading: false, error: null }))
vi.mock('../../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}))

const mockPublish = vi.fn()
vi.mock('../../components/ToastProvider', () => ({
  useToast: () => ({ publish: mockPublish }),
}))

vi.mock('../../firebase', () => ({
  db: {},
  auth: {},
}))

vi.mock('firebase/auth', () => ({
  signOut: vi.fn(),
}))

vi.mock('../../hooks/useConnectivityStatus', () => ({
  useConnectivityStatus: () => ({
    isOnline: true,
    isReachable: true,
    isChecking: false,
    lastHeartbeatAt: null,
    heartbeatError: null,
    queue: { status: 'idle', pending: 0, lastError: null, updatedAt: null },
  }),
}))

const docMock = vi.fn((_, collection: string, id: string) => ({ type: 'doc', path: `${collection}/${id}` }))
const setDocMock = vi.fn(async () => {})
const updateDocMock = vi.fn(async () => {})

let snapshotData: any = null
const onSnapshotMock = vi.fn((ref: { path: string }, onNext: (snapshot: any) => void) => {
  queueMicrotask(() => {
    onNext({
      data: () => snapshotData,
    })
  })
  return () => {}
})

vi.mock('firebase/firestore', () => ({
  doc: (...args: Parameters<typeof docMock>) => docMock(...args),
  setDoc: (...args: Parameters<typeof setDocMock>) => setDocMock(...args),
  updateDoc: (...args: Parameters<typeof updateDocMock>) => updateDocMock(...args),
  onSnapshot: (...args: Parameters<typeof onSnapshotMock>) => onSnapshotMock(...args),
}))

const renderPlanner = () => {
  render(
    <MemoryRouter initialEntries={['/goals']}>
      <Routes>
        <Route path="/goals" element={<Shell><GoalPlannerPage /></Shell>} />
      </Routes>
    </MemoryRouter>,
  )
}

function formatIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function formatIsoMonth(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function formatIsoWeek(date: Date) {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = utcDate.getUTCDay() || 7
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${utcDate.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

describe('Goal planner page', () => {
  const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
  let dayKey = ''
  let weekKey = ''
  let monthKey = ''

  beforeEach(() => {
    uuidSpy.mockReset()
    uuidSpy.mockReturnValue('goal-new-id')

    mockUseAuthUser.mockReturnValue({ uid: 'user-1', email: 'manager@example.com' })
    mockUseActiveStoreContext.mockReturnValue({ storeId: 'store-1', isLoading: false, error: null })
    mockPublish.mockReset()

    docMock.mockClear()
    setDocMock.mockClear()
    updateDocMock.mockClear()
    onSnapshotMock.mockClear()

    const now = new Date()
    dayKey = formatIsoDate(now)
    weekKey = formatIsoWeek(now)
    monthKey = formatIsoMonth(now)

    snapshotData = {
      daily: {
        [dayKey]: [
          {
            id: 'goal-1',
            title: 'Call supplier',
            completed: false,
            createdAt: '2024-05-14T18:00:00.000Z',
          },
        ],
      },
      weekly: {
        [weekKey]: [
          {
            id: 'goal-2',
            title: 'Plan launch event',
            completed: true,
            createdAt: '2024-05-10T12:00:00.000Z',
          },
        ],
      },
      monthly: {
        [monthKey]: [
          {
            id: 'goal-3',
            title: 'Improve NPS score',
            completed: false,
            createdAt: '2024-05-02T08:00:00.000Z',
          },
        ],
      },
    }
  })

  afterAll(() => {
    uuidSpy.mockRestore()
  })

  it('renders daily, weekly, and monthly goal sections', async () => {
    renderPlanner()
    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled())

    expect(await screen.findByRole('heading', { level: 3, name: /daily goals/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: /weekly goals/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: /monthly goals/i })).toBeInTheDocument()
  })

  it('adds a new daily goal to Firestore with merge', async () => {
    snapshotData.daily[dayKey] = []

    renderPlanner()
    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled())

    const titleInput = await screen.findByLabelText(/daily goal title/i)
    const notesInput = screen.getAllByLabelText(/notes \(optional\)/i)[0]
    await userEvent.type(titleInput, 'Launch checkout prompt')
    await userEvent.type(notesInput, 'Highlight bundles at POS')

    await userEvent.click(screen.getByRole('button', { name: /add daily goal/i }))

    await waitFor(() => expect(setDocMock).toHaveBeenCalledTimes(1))
    const [, payload, options] = setDocMock.mock.calls[0]

    expect(payload.daily[dayKey][0]).toMatchObject({
      id: 'goal-new-id',
      title: 'Launch checkout prompt',
      notes: 'Highlight bundles at POS',
      completed: false,
    })
    expect(options).toEqual({ merge: true })
  })

  it('toggles completion and deletes a goal via Firestore updates', async () => {
    renderPlanner()
    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled())

    const checkbox = await screen.findByRole('checkbox', { name: /call supplier/i })
    await userEvent.click(checkbox)

    await waitFor(() => expect(updateDocMock).toHaveBeenCalledTimes(1))
    const [, togglePayload, toggleOptions] = updateDocMock.mock.calls[0]

    expect(togglePayload.daily[dayKey][0].completed).toBe(true)
    expect(toggleOptions).toEqual({ merge: true })

    updateDocMock.mockClear()

    const deleteButton = screen.getByRole('button', { name: /delete call supplier/i })
    await userEvent.click(deleteButton)

    await waitFor(() => expect(updateDocMock).toHaveBeenCalledTimes(1))
    const [, deletePayload, deleteOptions] = updateDocMock.mock.calls[0]

    expect(deletePayload.daily[dayKey]).toEqual([])
    expect(deleteOptions).toEqual({ merge: true })
  })
})
