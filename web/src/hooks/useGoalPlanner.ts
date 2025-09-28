import { useCallback, useEffect, useMemo, useState } from 'react'
import { doc, onSnapshot, setDoc, updateDoc, type DocumentReference } from 'firebase/firestore'

import { db } from '../firebase'
import { useAuthUser } from './useAuthUser'
import { useActiveStore } from './useActiveStore'
import { useToast } from '../components/ToastProvider'

type PlannerFrequency = 'daily' | 'weekly' | 'monthly'

export type GoalItem = {
  id: string
  title: string
  notes?: string
  completed: boolean
  createdAt: string
}

type GoalCollection = Record<string, GoalItem[]>

export type GoalPlanDocument = {
  daily?: GoalCollection
  weekly?: GoalCollection
  monthly?: GoalCollection
}

function ensureId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `goal-${Date.now()}-${Math.floor(Math.random() * 1000)}`
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

function emptyPlan(): Required<GoalPlanDocument> {
  return { daily: {}, weekly: {}, monthly: {} }
}

export type UseGoalPlannerResult = {
  documentRef: DocumentReference | null
  plan: Required<GoalPlanDocument>
  isLoading: boolean
  selectedDay: string
  setSelectedDay: (value: string) => void
  selectedWeek: string
  setSelectedWeek: (value: string) => void
  selectedMonth: string
  setSelectedMonth: (value: string) => void
  addGoal: (frequency: PlannerFrequency, key: string, title: string, notes?: string) => Promise<void>
  toggleGoal: (frequency: PlannerFrequency, key: string, id: string) => Promise<void>
  updateGoalNotes: (frequency: PlannerFrequency, key: string, id: string, notes: string) => Promise<void>
  deleteGoal: (frequency: PlannerFrequency, key: string, id: string) => Promise<void>
}

export function useGoalPlanner(): UseGoalPlannerResult {
  const { publish } = useToast()
  const { storeId } = useActiveStore()
  const authUser = useAuthUser()

  const initialToday = useMemo(() => new Date(), [])
  const [selectedDay, setSelectedDay] = useState(() => formatIsoDate(initialToday))
  const [selectedWeek, setSelectedWeek] = useState(() => formatIsoWeek(initialToday))
  const [selectedMonth, setSelectedMonth] = useState(() => formatIsoMonth(initialToday))

  const ownerId = storeId ?? authUser?.uid ?? null

  const [plan, setPlan] = useState<Required<GoalPlanDocument>>(emptyPlan)
  const [isLoading, setIsLoading] = useState(() => ownerId !== null)

  const documentRef = useMemo(() => {
    if (!ownerId) {
      return null
    }

    return doc(db, 'storeGoalPlans', ownerId)
  }, [ownerId])

  useEffect(() => {
    if (!documentRef) {
      setPlan(emptyPlan())
      setIsLoading(false)
      return undefined
    }

    setIsLoading(true)

    const unsubscribe = onSnapshot(
      documentRef,
      snapshot => {
        const data = snapshot.data() as GoalPlanDocument | undefined
        setPlan({
          daily: data?.daily ?? {},
          weekly: data?.weekly ?? {},
          monthly: data?.monthly ?? {},
        })
        setIsLoading(false)
      },
      error => {
        publish({ tone: 'error', message: 'Unable to load goals right now.' })
        console.error('[goal-planner] snapshot error', error)
        setPlan(emptyPlan())
        setIsLoading(false)
      },
    )

    return unsubscribe
  }, [documentRef, publish])

  const withMerge = useCallback(
    async (
      writer: typeof setDoc | typeof updateDoc,
      data: Partial<GoalPlanDocument>,
    ) => {
      if (!documentRef) {
        publish({ tone: 'error', message: 'Select a workspace to update goals.' })
        return
      }

      try {
        await (writer as typeof setDoc)(documentRef, data, { merge: true })
      } catch (error) {
        publish({ tone: 'error', message: 'We could not update your goals. Please try again.' })
        throw error
      }
    },
    [documentRef, publish],
  )

  const addGoal = useCallback(
    async (frequency: PlannerFrequency, key: string, title: string, notes?: string) => {
      const trimmedTitle = title.trim()
      if (!trimmedTitle) {
        publish({ tone: 'error', message: 'Add a goal title before saving.' })
        return
      }

      const current = plan[frequency][key] ?? []
      const entry: GoalItem = {
        id: ensureId(),
        title: trimmedTitle,
        notes: notes?.trim() ? notes.trim() : undefined,
        completed: false,
        createdAt: new Date().toISOString(),
      }

      await withMerge(setDoc, {
        [frequency]: {
          ...plan[frequency],
          [key]: [...current, entry],
        },
      })

      publish({ tone: 'success', message: 'Goal added.' })
    },
    [plan, publish, withMerge],
  )

  const toggleGoal = useCallback(
    async (frequency: PlannerFrequency, key: string, id: string) => {
      const current = plan[frequency][key] ?? []
      const next = current.map(goal =>
        goal.id === id ? { ...goal, completed: !goal.completed } : goal,
      )

      await withMerge(updateDoc, {
        [frequency]: {
          ...plan[frequency],
          [key]: next,
        },
      })
    },
    [plan, withMerge],
  )

  const updateGoalNotes = useCallback(
    async (frequency: PlannerFrequency, key: string, id: string, notes: string) => {
      const current = plan[frequency][key] ?? []
      const trimmed = notes.trim()
      const next = current.map(goal =>
        goal.id === id ? { ...goal, notes: trimmed || undefined } : goal,
      )

      await withMerge(updateDoc, {
        [frequency]: {
          ...plan[frequency],
          [key]: next,
        },
      })

      publish({ tone: 'success', message: 'Notes updated.' })
    },
    [plan, publish, withMerge],
  )

  const deleteGoal = useCallback(
    async (frequency: PlannerFrequency, key: string, id: string) => {
      const current = plan[frequency][key] ?? []
      const next = current.filter(goal => goal.id !== id)

      await withMerge(updateDoc, {
        [frequency]: {
          ...plan[frequency],
          [key]: next,
        },
      })

      publish({ tone: 'success', message: 'Goal removed.' })
    },
    [plan, publish, withMerge],
  )

  return {
    documentRef,
    plan,
    isLoading,
    selectedDay,
    setSelectedDay,
    selectedWeek,
    setSelectedWeek,
    selectedMonth,
    setSelectedMonth,
    addGoal,
    toggleGoal,
    updateGoalNotes,
    deleteGoal,
  }
}
