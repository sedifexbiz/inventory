import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthUser } from '../hooks/useAuthUser'
import { useActiveStore } from '../hooks/useActiveStore'
import { getOnboardingStatus, setOnboardingStatus, type OnboardingStatus } from '../utils/onboarding'
import './Onboarding.css'

const STAFF_ACCESS_PATH = '/settings?panel=staff'

export default function Onboarding() {
  const user = useAuthUser()
  const navigate = useNavigate()
  const { isLoading: storeLoading, error: storeError, storeId } = useActiveStore()
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

  if (storeLoading) {
    return (
      <div className="page" role="status" aria-live="polite">
        <header className="page__header">
          <h1 className="page__title">Preparing your workspace…</h1>
          <p className="page__subtitle">We&apos;re getting your store workspace ready.</p>
        </header>
      </div>
    )
  }

  if (storeError) {
    return (
      <div className="page" role="alert">
        <header className="page__header">
          <h1 className="page__title">We couldn&apos;t load your store details</h1>
          <p className="page__subtitle">{storeError}</p>
        </header>
      </div>
    )
  }

  return (
    <div className="page onboarding-page" role="region" aria-labelledby="onboarding-title">
      <header className="page__header onboarding-page__header">
        <div>
          <h1 className="page__title" id="onboarding-title">
            Welcome to Sedifex
          </h1>
          <p className="page__subtitle">
            Let&apos;s secure your store{storeId ? ` (${storeId})` : ''} before you invite the rest of your team.
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
          You&apos;re signed in as the store owner. We recommend keeping this login private and using it only for
          high-impact settings like payouts, data exports, and staff access. Add a recovery email in case you ever
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
          Use the staff access workspace to create login credentials for every teammate who needs Sedifex. Assign
          each person a role so they only see the tools they need.
        </p>
        <ul className="onboarding-card__list">
          <li>Managers can run inventory and day-close workflows.</li>
          <li>Cashiers can sell, receive stock, and view customer history.</li>
          <li>Owners always retain full settings and billing access.</li>
        </ul>
        <Link className="primary-button onboarding-card__cta" to={STAFF_ACCESS_PATH}>
          Open staff access settings
        </Link>
      </section>

      <section className="card onboarding-card" aria-labelledby="onboarding-step-3">
        <header className="onboarding-card__header">
          <span className="onboarding-card__step">Step 3</span>
          <h2 className="onboarding-card__title" id="onboarding-step-3">
            Finish setup
          </h2>
        </header>
        <p>
          Once you&apos;ve added your teammates, you&apos;re ready to jump into the dashboard. You can always return to
          staff access from Settings to make changes later.
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
