import React, { useMemo, useState } from 'react'

import { useGoalPlanner, type GoalItem } from '../hooks/useGoalPlanner'

type PlannerFrequency = 'daily' | 'weekly' | 'monthly'

function getProgressSummary(goals: GoalItem[]) {
  const total = goals.length
  const completed = goals.filter(goal => goal.completed).length
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)
  return { total, completed, percent }
}

type FormState = { title: string; notes: string }

function useGoalFormState(initial: FormState = { title: '', notes: '' }) {
  const [formState, setFormState] = useState(initial)

  const updateField = (field: keyof FormState, value: string) => {
    setFormState(current => ({ ...current, [field]: value }))
  }

  const reset = () => setFormState(initial)

  return { formState, updateField, reset }
}

export default function GoalPlannerPage() {
  const {
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
  } = useGoalPlanner()

  const dailyGoals = plan.daily[selectedDay] ?? []
  const weeklyGoals = plan.weekly[selectedWeek] ?? []
  const monthlyGoals = plan.monthly[selectedMonth] ?? []

  const dailyProgress = useMemo(() => getProgressSummary(dailyGoals), [dailyGoals])
  const weeklyProgress = useMemo(() => getProgressSummary(weeklyGoals), [weeklyGoals])
  const monthlyProgress = useMemo(() => getProgressSummary(monthlyGoals), [monthlyGoals])

  const dailyForm = useGoalFormState()
  const weeklyForm = useGoalFormState()
  const monthlyForm = useGoalFormState()

  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({})

  const handleGoalSubmit = async (
    frequency: PlannerFrequency,
    key: string,
    title: string,
    notes: string,
    reset: () => void,
  ) => {
    try {
      await addGoal(frequency, key, title, notes)
      reset()
    } catch (error) {
      console.error('[goal-planner] failed to add goal', error)
    }
  }

  const handleToggle = (frequency: PlannerFrequency, key: string, id: string) => {
    toggleGoal(frequency, key, id).catch(error => {
      console.error('[goal-planner] toggle failed', error)
    })
  }

  const handleDelete = (frequency: PlannerFrequency, key: string, id: string) => {
    deleteGoal(frequency, key, id).catch(error => {
      console.error('[goal-planner] delete failed', error)
    })
  }

  const handleNotesBlur = (
    frequency: PlannerFrequency,
    key: string,
    goal: GoalItem,
    value: string,
  ) => {
    if (goal.notes === value.trim()) {
      return
    }

    updateGoalNotes(frequency, key, goal.id, value).catch(error => {
      console.error('[goal-planner] notes update failed', error)
    })
  }

  const renderGoalList = (
    frequency: PlannerFrequency,
    key: string,
    goals: GoalItem[],
  ) => {
    if (goals.length === 0) {
      return (
        <p style={{ margin: '12px 0 0', color: '#64748B', fontSize: 14 }}>
          No goals yet. Add one to start planning.
        </p>
      )
    }

    return (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
        {goals.map(goal => {
          const draftKey = `${frequency}:${goal.id}`
          const draftValue = notesDraft[draftKey] ?? goal.notes ?? ''
          return (
            <li
              key={goal.id}
              style={{
                display: 'grid',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid #E2E8F0',
                background: '#FFFFFF',
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={goal.completed}
                  onChange={() => handleToggle(frequency, key, goal.id)}
                  style={{ width: 18, height: 18 }}
                />
                <span style={{ color: goal.completed ? '#16A34A' : '#0F172A' }}>{goal.title}</span>
              </label>
              <textarea
                aria-label={`${goal.title} notes`}
                value={draftValue}
                onChange={event =>
                  setNotesDraft(current => ({ ...current, [draftKey]: event.target.value }))
                }
                onBlur={event => handleNotesBlur(frequency, key, goal, event.target.value)}
                placeholder="Add notes or context (optional)"
                style={{
                  borderRadius: 8,
                  border: '1px solid #CBD5F5',
                  padding: '8px 10px',
                  fontSize: 13,
                  minHeight: 60,
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94A3B8' }}>
                  {goal.completed ? 'Completed' : 'In progress'}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(frequency, key, goal.id)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: '#DC2626',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                  aria-label={`Delete ${goal.title}`}
                >
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <h2 style={{ color: '#4338CA', marginBottom: 8 }}>Goal planner</h2>
        <p style={{ color: '#475569', margin: 0 }}>
          Track the outcomes you care about every day, week, and month. Create goals, capture context,
          and check off progress as your team moves forward.
        </p>
      </header>

      {isLoading && (
        <p role="status" style={{ color: '#475569', fontSize: 14, marginBottom: 16 }}>
          Loading goals…
        </p>
      )}

      <section
        aria-labelledby="daily-goals-heading"
        style={{
          display: 'grid',
          gap: 16,
          background: '#F8FAFC',
          borderRadius: 20,
          border: '1px solid #E2E8F0',
          padding: '20px 22px',
          marginBottom: 24,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'space-between' }}>
          <div>
            <h3 id="daily-goals-heading" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>
              Daily goals
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: '#64748B' }}>
              Choose a day to review and add focused tasks for your team.
            </p>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' }}>
            <span>Day</span>
            <input
              type="date"
              value={selectedDay}
              onChange={event => setSelectedDay(event.target.value)}
              style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '6px 10px', fontSize: 13 }}
            />
          </label>
        </div>

        <form
          onSubmit={event => {
            event.preventDefault()
            void handleGoalSubmit(
              'daily',
              selectedDay,
              dailyForm.formState.title,
              dailyForm.formState.notes,
              dailyForm.reset,
            )
          }}
          style={{ display: 'grid', gap: 12 }}
        >
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#0F172A' }}>
              <span>Daily goal title</span>
              <input
                value={dailyForm.formState.title}
                onChange={event => dailyForm.updateField('title', event.target.value)}
                placeholder="Increase upsells"
                style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '8px 10px', fontSize: 13 }}
                required
              />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#0F172A' }}>
              <span>Notes (optional)</span>
              <input
                value={dailyForm.formState.notes}
                onChange={event => dailyForm.updateField('notes', event.target.value)}
                placeholder="Share reminders or context"
                style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '8px 10px', fontSize: 13 }}
              />
            </label>
          </div>
          <button
            type="submit"
            style={{
              justifySelf: 'flex-start',
              borderRadius: 999,
              background: '#4338CA',
              color: '#FFFFFF',
              fontWeight: 600,
              fontSize: 13,
              padding: '10px 18px',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Add daily goal
          </button>
        </form>

        <p style={{ margin: 0, fontSize: 13, color: '#0F172A', fontWeight: 600 }}>
          Completed {dailyProgress.completed} of {dailyProgress.total} goals ({dailyProgress.percent}%)
        </p>

        {renderGoalList('daily', selectedDay, dailyGoals)}
      </section>

      <section
        aria-labelledby="weekly-goals-heading"
        style={{
          display: 'grid',
          gap: 16,
          background: '#F8FAFC',
          borderRadius: 20,
          border: '1px solid #E2E8F0',
          padding: '20px 22px',
          marginBottom: 24,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'space-between' }}>
          <div>
            <h3 id="weekly-goals-heading" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>
              Weekly goals
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: '#64748B' }}>
              Pick a week to track bigger objectives and share updates with your team.
            </p>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' }}>
            <span>Week</span>
            <input
              type="week"
              value={selectedWeek}
              onChange={event => setSelectedWeek(event.target.value)}
              style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '6px 10px', fontSize: 13 }}
            />
          </label>
        </div>

        <form
          onSubmit={event => {
            event.preventDefault()
            void handleGoalSubmit(
              'weekly',
              selectedWeek,
              weeklyForm.formState.title,
              weeklyForm.formState.notes,
              weeklyForm.reset,
            )
          }}
          style={{ display: 'grid', gap: 12 }}
        >
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#0F172A' }}>
              <span>Weekly goal title</span>
              <input
                value={weeklyForm.formState.title}
                onChange={event => weeklyForm.updateField('title', event.target.value)}
                placeholder="Launch new promotion"
                style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '8px 10px', fontSize: 13 }}
                required
              />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#0F172A' }}>
              <span>Notes (optional)</span>
              <input
                value={weeklyForm.formState.notes}
                onChange={event => weeklyForm.updateField('notes', event.target.value)}
                placeholder="Add milestones or blockers"
                style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '8px 10px', fontSize: 13 }}
              />
            </label>
          </div>
          <button
            type="submit"
            style={{
              justifySelf: 'flex-start',
              borderRadius: 999,
              background: '#4338CA',
              color: '#FFFFFF',
              fontWeight: 600,
              fontSize: 13,
              padding: '10px 18px',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Add weekly goal
          </button>
        </form>

        <p style={{ margin: 0, fontSize: 13, color: '#0F172A', fontWeight: 600 }}>
          Completed {weeklyProgress.completed} of {weeklyProgress.total} goals ({weeklyProgress.percent}%)
        </p>

        {renderGoalList('weekly', selectedWeek, weeklyGoals)}
      </section>

      <section
        aria-labelledby="monthly-goals-heading"
        style={{
          display: 'grid',
          gap: 16,
          background: '#F8FAFC',
          borderRadius: 20,
          border: '1px solid #E2E8F0',
          padding: '20px 22px',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'space-between' }}>
          <div>
            <h3 id="monthly-goals-heading" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>
              Monthly goals
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: '#64748B' }}>
              Focus on strategic efforts and measure progress across the month.
            </p>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' }}>
            <span>Month</span>
            <input
              type="month"
              value={selectedMonth}
              onChange={event => setSelectedMonth(event.target.value)}
              style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '6px 10px', fontSize: 13 }}
            />
          </label>
        </div>

        <form
          onSubmit={event => {
            event.preventDefault()
            void handleGoalSubmit(
              'monthly',
              selectedMonth,
              monthlyForm.formState.title,
              monthlyForm.formState.notes,
              monthlyForm.reset,
            )
          }}
          style={{ display: 'grid', gap: 12 }}
        >
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#0F172A' }}>
              <span>Monthly goal title</span>
              <input
                value={monthlyForm.formState.title}
                onChange={event => monthlyForm.updateField('title', event.target.value)}
                placeholder="Improve repeat purchases"
                style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '8px 10px', fontSize: 13 }}
                required
              />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#0F172A' }}>
              <span>Notes (optional)</span>
              <input
                value={monthlyForm.formState.notes}
                onChange={event => monthlyForm.updateField('notes', event.target.value)}
                placeholder="Document learnings or metrics"
                style={{ borderRadius: 8, border: '1px solid #CBD5F5', padding: '8px 10px', fontSize: 13 }}
              />
            </label>
          </div>
          <button
            type="submit"
            style={{
              justifySelf: 'flex-start',
              borderRadius: 999,
              background: '#4338CA',
              color: '#FFFFFF',
              fontWeight: 600,
              fontSize: 13,
              padding: '10px 18px',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Add monthly goal
          </button>
        </form>

        <p style={{ margin: 0, fontSize: 13, color: '#0F172A', fontWeight: 600 }}>
          Completed {monthlyProgress.completed} of {monthlyProgress.total} goals ({monthlyProgress.percent}%)
        </p>

        {renderGoalList('monthly', selectedMonth, monthlyGoals)}
      </section>
    </div>
  )
}
