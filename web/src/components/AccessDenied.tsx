import React from 'react'
import type { StoreRole } from '../hooks/useActiveStore'
import type { AppFeature } from '../utils/permissions'
import { formatRoleLabel, getFeatureLabel } from '../utils/permissions'

interface AccessDeniedProps {
  feature: AppFeature
  role: StoreRole | null
}

export function AccessDenied({ feature, role }: AccessDeniedProps) {
  const featureLabel = getFeatureLabel(feature)
  const roleLabel = formatRoleLabel(role)
  const subtitleId = 'access-denied-subtitle'

  return (
    <div className="page" role="region" aria-labelledby="access-denied-title" aria-describedby={subtitleId}>
      <header className="page__header">
        <div>
          <h1 className="page__title" id="access-denied-title">
            Access restricted
          </h1>
          <p className="page__subtitle" id={subtitleId}>
            The {featureLabel} workspace isn’t available for {roleLabel}. If you need this access, contact a store owner to
            adjust your permissions.
          </p>
        </div>
      </header>

      <section className="card" role="status" aria-live="polite">
        <p style={{ margin: 0, color: '#475569' }}>
          Try switching to another store or reaching out to an owner who can upgrade your permissions.
        </p>
      </section>
    </div>
  )
}
