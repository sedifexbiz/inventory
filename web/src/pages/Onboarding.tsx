import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthUser } from '../hooks/useAuthUser'
import { getOnboardingStatus, setOnboardingStatus, type OnboardingStatus } from '../utils/onboarding'
import './Onboarding.css'

export default function Onboarding() {
  const user = useAuthUser()
  const navigate = useNavigate()
  const [status, setStatus] = useState<OnboardingStatus | null>(() => getOnboardingStatus(user?.uid ?? null))

  useEffect(() => {
    setStatus(getOnboardingStatus(user?.uid ?? null))
  }, [user?.uid])

  const hasCompleted = status === 'completed'

  function handleComplete() {
    if (!user) {
      return
    }

    setOnboardingStatus(user.uid, 'completed')
    setStatus('completed')
    navigate('/', { replace: true })
  }

  return (
    <div className="page onboarding-page" role="region" aria-labelledby="onboarding-title">
      <header className="page__header onboarding-page__header">
        <div>
          <h1 className="page__title" id="onboarding-title">
            Welcome to Sedifex
          </h1>
          <p className="page__subtitle">
            Let&apos;s get your workspace ready before you invite the rest of your team.
          </p>
        </div>
        {hasCompleted && (
          <span className="onboarding-page__status" role="status" aria-live="polite">
            Onboarding complete
          </span>
        )}
      </header>

      <section className="card onboarding-card" aria-labelledby="onboarding-step-1">
        <header className="onboarding-card__header">
          <span className="onboarding-card__step">Step 1</span>
          <h2 className="onboarding-card__title" id="onboarding-step-1">
            Confirm your owner account
          </h2>
        </header>
        <p>
          You&apos;re signed in as the workspace owner. We recommend keeping this login private and using it only for
          high-impact controls like payouts, data exports, and team access. Add a recovery email in case you ever
          need to reset your password.
        </p>
        <ul className="onboarding-card__list">
          <li>Keep your owner credentials secure.</li>
          <li>Turn on multi-factor authentication for extra protection.</li>
          <li>Plan which teammates need day-to-day access to Sedifex.</li>
        </ul>
      </section>

      <section className="card onboarding-card" aria-labelledby="onboarding-step-2">
        <header className="onboarding-card__header">
          <span className="onboarding-card__step">Step 2</span>
          <h2 className="onboarding-card__title" id="onboarding-step-2">
            Invite your team and assign roles
          </h2>
        </header>
        <p>
          Use the team access workspace to create login credentials for every teammate who needs Sedifex. Assign
          each person a role so they only see the tools they need.
        </p>
        <ul className="onboarding-card__list">
          <li>Managers can run inventory and day-close workflows.</li>
          <li>Cashiers can sell, receive stock, and view customer history.</li>
          <li>Owners always retain full admin and billing access.</li>
        </ul>
        <p className="onboarding-card__cta">
          Need to update access later? Your Sedifex account manager can help tailor roles for your team.
        </p>
      </section>

      <section className="card onboarding-card" aria-labelledby="onboarding-step-3">
        <header className="onboarding-card__header">
          <span className="onboarding-card__step">Step 3</span>
          <h2 className="onboarding-card__title" id="onboarding-step-3">
            Finish setup
          </h2>
        </header>
        <p>
          Once you&apos;ve added your teammates, you&apos;re ready to jump into the dashboard. You can always revisit
          staff access later to make changes.
        </p>
        <button
          type="button"
          className="secondary-button onboarding-card__cta"
          onClick={handleComplete}
        >
          {hasCompleted ? 'Return to dashboard' : 'I’ve added my team'}
        </button>
      </section>
    </div>
  )
}
