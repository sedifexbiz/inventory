import React, { useEffect, useMemo, useState } from 'react'
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { db } from '../firebase'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import { useAuthUser } from '../hooks/useAuthUser'
import { useMemberships, type Membership } from '../hooks/useMemberships'
import { manageStaffAccount, revokeStaffAccess, updateStoreProfile } from '../controllers/storeController'
import { useToast } from '../components/ToastProvider'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type StoreProfile = {
  name: string | null
  displayName: string | null
  email: string | null
  phone: string | null
  status: string | null
  company: string | null
  contractStatus: string | null
  contractStart: string | null
  contractEnd: string | null
  paymentStatus: string | null
  amountPaid: string | null
  timezone: string | null
  currency: string | null
  billingPlan: string | null
  paymentProvider: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
}

type RosterMember = {
  id: string
  email: string | null
  role: Membership['role']
  invitedBy: string | null
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  lastSeenAt: Timestamp | null
}

function toNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === 'object' && value !== null && typeof (value as Timestamp).toDate === 'function'
}

function toDisplayDate(value: unknown): string | null {
  if (isTimestamp(value)) {
    try {
      return value.toDate().toLocaleDateString()
    } catch (error) {
      console.warn('Unable to format Firestore Timestamp', error)
      return null
    }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }

  return null
}

function toAmountString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }

  return null
}

function mapStoreSnapshot(snapshot: DocumentSnapshot<DocumentData> | null): StoreProfile | null {
  if (!snapshot) return null
  const data = snapshot.data()

  return {
    name: toNullableString(data.name),
    displayName: toNullableString(data.displayName),
    email: toNullableString(data.email),
    phone: toNullableString(data.phone),
    status: toNullableString(data.status),
    company: toNullableString(data.company ?? data.displayName ?? data.name),
    contractStatus: toNullableString(data.contractStatus ?? data.status),
    contractStart: toDisplayDate(data.contractStart),
    contractEnd: toDisplayDate(data.contractEnd),
    paymentStatus: toNullableString(data.paymentStatus),
    amountPaid: toAmountString(data.amountPaid),
    timezone: toNullableString(data.timezone),
    currency: toNullableString(data.currency),
    billingPlan: toNullableString(data.billingPlan),
    paymentProvider: toNullableString(data.paymentProvider),
    addressLine1: toNullableString(data.addressLine1),
    addressLine2: toNullableString(data.addressLine2),
    city: toNullableString(data.city),
    region: toNullableString(data.region),
    postalCode: toNullableString(data.postalCode),
    country: toNullableString(data.country),
    createdAt: isTimestamp(data.createdAt) ? data.createdAt : null,
    updatedAt: isTimestamp(data.updatedAt) ? data.updatedAt : null,
  }
}

function mapRosterSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): RosterMember {
  const data = snapshot.data()
  const role = data.role === 'owner' ? 'owner' : 'staff'

  return {
    id: snapshot.id,
    email: toNullableString(data.email),
    role,
    invitedBy: toNullableString(data.invitedBy),
    createdAt: isTimestamp(data.createdAt) ? data.createdAt : null,
    updatedAt: isTimestamp(data.updatedAt) ? data.updatedAt : null,
    lastSeenAt: isTimestamp(data.lastSeenAt) ? data.lastSeenAt : null,
  }
}

function formatValue(value: string | null | undefined) {
  return value ?? '—'
}

function formatTimestamp(timestamp: Timestamp | null) {
  if (!timestamp) return '—'
  try {
    return timestamp.toDate().toLocaleString()
  } catch (error) {
    console.warn('Unable to render timestamp', error)
    return '—'
  }
}

export default function AccountOverview() {
  const {
    storeId,
    isLoading: storeLoading,
    error: storeError,
    storeChangeToken,
    setActiveStoreId,
  } = useActiveStoreContext()
  const authUser = useAuthUser()
  const uid = authUser?.uid ?? null
  const membershipsStoreId = storeLoading ? undefined : storeId ?? null
  const {
    memberships,
    loading: membershipsLoading,
    error: membershipsError,
  } = useMemberships(membershipsStoreId)
  const { publish } = useToast()

  const [profile, setProfile] = useState<StoreProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [profileTimezone, setProfileTimezone] = useState('')
  const [profileCurrency, setProfileCurrency] = useState('')
  const [profileFormError, setProfileFormError] = useState<string | null>(null)
  const [profileSubmitting, setProfileSubmitting] = useState(false)

  const [roster, setRoster] = useState<RosterMember[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [rosterVersion, setRosterVersion] = useState(0)
  const [revokingMemberId, setRevokingMemberId] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Membership['role']>('staff')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const activeMembership = useMemo(() => {
    if (!storeId) return null
    return memberships.find(m => m.storeId === storeId) ?? null
  }, [memberships, storeId])

  const isOwner = activeMembership?.role === 'owner'

  useEffect(() => {
    if (storeId || storeLoading || !uid) {
      return
    }

    let cancelled = false

    ;(async () => {
      try {
        const memberSnapshot = await getDoc(doc(db, 'teamMembers', uid))
        if (cancelled) return

        if (!memberSnapshot.exists()) {
          return
        }

        const data = memberSnapshot.data() as { storeId?: unknown } | undefined
        const documentStoreId =
          typeof data?.storeId === 'string' && data.storeId.trim().length > 0
            ? data.storeId.trim()
            : null

        if (!documentStoreId) {
          return
        }

        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem('activeStoreId', documentStoreId)
          } catch (storageError) {
            console.warn('Unable to persist active store selection', storageError)
          }
        }

        setActiveStoreId(documentStoreId)
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load workspace access for member', error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [storeId, storeLoading, uid, setActiveStoreId])

  useEffect(() => {
    if (!storeId) {
      setProfile(null)
      setProfileError(null)
      setProfileName('')
      setProfileTimezone('')
      setProfileCurrency('')
      return
    }

    let cancelled = false

    setProfileLoading(true)
    setProfileError(null)

    const ref = doc(db, 'stores', storeId)
    getDoc(ref)
      .then(snapshot => {
        if (cancelled) return

        if (snapshot.exists()) {
          const mapped = mapStoreSnapshot(snapshot)
          setProfile(mapped)
          setProfileError(null)
        } else {
          setProfile(null)
          setProfileError('We could not find this workspace profile.')
        }
      })
      .catch(error => {
        if (cancelled) return
        console.error('Failed to load store profile', error)
        setProfile(null)
        setProfileError('We could not load the workspace profile.')
        publish({ message: 'Unable to load store details.', tone: 'error' })
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [storeId, publish, storeChangeToken])

  useEffect(() => {
    if (!profile) {
      setProfileName('')
      setProfileTimezone('')
      setProfileCurrency('')
      return
    }

    setProfileName(profile.displayName ?? profile.name ?? '')
    setProfileTimezone(profile.timezone ?? '')
    setProfileCurrency(profile.currency ?? '')
  }, [profile])

  useEffect(() => {
    if (!storeId) {
      setRoster([])
      setRosterError(null)
      return
    }

    let cancelled = false

    setRosterLoading(true)
    setRosterError(null)

    const membersRef = collection(db, 'teamMembers')
    const rosterQuery = query(membersRef, where('storeId', '==', storeId))
    getDocs(rosterQuery)
      .then(snapshot => {
        if (cancelled) return
        const members = snapshot.docs.map(mapRosterSnapshot)
        setRoster(members)
        setRosterError(null)
      })
      .catch(error => {
        if (cancelled) return
        console.error('Failed to load roster', error)
        setRoster([])
        setRosterError('We could not load the team roster.')
        publish({ message: 'Unable to load team members.', tone: 'error' })
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [storeId, rosterVersion, publish, storeChangeToken])

  useEffect(() => {
    setProfile(null)
    setProfileError(null)
    setRoster([])
    setRosterError(null)
    setEmail('')
    setRole('staff')
    setPassword('')
    setFormError(null)
    setSubmitting(false)
    setRosterVersion(0)
    setProfileName('')
    setProfileTimezone('')
    setProfileCurrency('')
    setProfileFormError(null)
    setProfileSubmitting(false)
  }, [storeChangeToken])

  function validateForm() {
    if (!storeId) {
      return 'A storeId is required to manage staff.'
    }

    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) {
      return 'Enter the teammate’s email address.'
    }

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return 'Enter a valid email address.'
    }

    const normalizedRole = role?.trim()
    if (!normalizedRole) {
      return 'Select a role for this teammate.'
    }

    if (normalizedRole !== 'owner' && normalizedRole !== 'staff') {
      return 'Choose either owner or staff for the role.'
    }

    return null
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const error = validateForm()
    if (error) {
      setFormError(error)
      publish({ message: error, tone: 'error' })
      return
    }

    if (!storeId) return

    const payload = {
      storeId,
      email: email.trim().toLowerCase(),
      role,
      password: password.trim() || undefined,
    }

    setSubmitting(true)
    setFormError(null)
    try {
      await manageStaffAccount(payload)
      publish({ message: 'Team member updated.', tone: 'success' })
      setEmail('')
      setRole('staff')
      setPassword('')
      setRosterVersion(version => version + 1)
    } catch (error) {
      console.error('Failed to manage staff account', error)
      const message = error instanceof Error ? error.message : 'We could not submit the request.'
      setFormError(message)
      publish({ message, tone: 'error' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleProfileSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (profileSubmitting) return

    if (!storeId) {
      const message = 'A storeId is required to update the workspace profile.'
      setProfileFormError(message)
      publish({ message, tone: 'error' })
      return
    }

    const trimmedName = profileName.trim()
    if (!trimmedName) {
      const message = 'Enter a workspace name.'
      setProfileFormError(message)
      publish({ message, tone: 'error' })
      return
    }

    const trimmedTimezone = profileTimezone.trim()
    if (!trimmedTimezone) {
      const message = 'Enter a valid timezone.'
      setProfileFormError(message)
      publish({ message, tone: 'error' })
      return
    }

    const trimmedCurrency = profileCurrency.trim()
    if (!trimmedCurrency) {
      const message = 'Enter a currency code.'
      setProfileFormError(message)
      publish({ message, tone: 'error' })
      return
    }

    setProfileSubmitting(true)
    setProfileFormError(null)

    try {
      await updateStoreProfile({
        storeId,
        name: trimmedName,
        timezone: trimmedTimezone,
        currency: trimmedCurrency,
      })

      setProfile(current =>
        current
          ? {
              ...current,
              name: trimmedName,
              displayName: trimmedName,
              timezone: trimmedTimezone,
              currency: trimmedCurrency,
            }
          : current,
      )

      publish({ message: 'Workspace profile updated.', tone: 'success' })
    } catch (error) {
      console.error('Failed to update store profile', error)
      const message =
        error instanceof Error ? error.message : 'We could not update the workspace profile.'
      setProfileFormError(message)
      publish({ message, tone: 'error' })
    } finally {
      setProfileSubmitting(false)
    }
  }

  async function handleRevoke(member: RosterMember) {
    if (!isOwner || !storeId) return

    const label = member.email ? ` ${member.email}` : ''
    const confirmationMessage = `Revoke access for${label || ' this team member'}?`
    const confirmed = typeof window !== 'undefined' ? window.confirm(confirmationMessage) : true
    if (!confirmed) return

    setRevokingMemberId(member.id)
    try {
      await revokeStaffAccess({ storeId, uid: member.id })
      publish({ message: 'Team member access revoked.', tone: 'success' })
      setRosterVersion(version => version + 1)
    } catch (error) {
      console.error('Failed to revoke staff access', error)
      const message =
        error instanceof Error ? error.message : 'We could not revoke this team member’s access.'
      publish({ message, tone: 'error' })
    } finally {
      setRevokingMemberId(null)
    }
  }

  if (storeError) {
    return <div role="alert">{storeError}</div>
  }

  if (!storeId) {
    if (storeLoading) {
      return (
        <div className="account-overview" role="status">
          <h1>Account overview</h1>
          <p>Loading account details…</p>
        </div>
      )
    }

    return (
      <div className="account-overview" role="status">
        <h1>Account overview</h1>
        <p>Select a workspace…</p>
      </div>
    )
  }

  const isBusy = storeLoading || membershipsLoading || profileLoading || rosterLoading

  return (
    <div className="account-overview">
      <h1>Account overview</h1>

      {(membershipsError || profileError || rosterError) && (
        <div className="account-overview__error" role="alert">
          {membershipsError && <p>We could not load your memberships.</p>}
          {profileError && <p>{profileError}</p>}
          {rosterError && <p>{rosterError}</p>}
        </div>
      )}

      {isBusy && (
        <p role="status" aria-live="polite">
          Loading account details…
        </p>
      )}

      {profile && (
        <section aria-labelledby="account-overview-profile">
          <h2 id="account-overview-profile">Store profile</h2>
          {isOwner ? (
            <>
              <form
                onSubmit={handleProfileSubmit}
                className="account-overview__form"
                data-testid="store-profile-form"
              >
                <fieldset disabled={profileSubmitting}>
                  <legend className="sr-only">Update workspace profile</legend>
                  <div className="account-overview__form-grid">
                    <label>
                      <span>Workspace name</span>
                      <input
                        type="text"
                        value={profileName}
                        onChange={event => setProfileName(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Timezone</span>
                      <input
                        type="text"
                        value={profileTimezone}
                        onChange={event => setProfileTimezone(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Currency</span>
                      <input
                        type="text"
                        value={profileCurrency}
                        onChange={event => setProfileCurrency(event.target.value)}
                        maxLength={6}
                      />
                    </label>
                    <button type="submit" className="button button--primary">
                      {profileSubmitting ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                  {profileFormError && (
                    <p className="account-overview__form-error" role="alert">
                      {profileFormError}
                    </p>
                  )}
                </fieldset>
              </form>
              <dl className="account-overview__grid">
                <div>
                  <dt>Email</dt>
                  <dd>{formatValue(profile.email)}</dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd>{formatValue(profile.phone)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{formatValue(profile.status)}</dd>
                </div>
                <div>
                  <dt>Timezone</dt>
                  <dd>{formatValue(profile.timezone)}</dd>
                </div>
                <div>
                  <dt>Currency</dt>
                  <dd>{formatValue(profile.currency)}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd>
                    {[profile.addressLine1, profile.addressLine2, profile.city, profile.region, profile.postalCode, profile.country]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatTimestamp(profile.createdAt)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatTimestamp(profile.updatedAt)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <dl className="account-overview__grid" data-testid="store-profile-readonly">
              <div>
                <dt>Workspace name</dt>
                <dd>{formatValue(profile.displayName ?? profile.name)}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{formatValue(profile.email)}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{formatValue(profile.phone)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{formatValue(profile.status)}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{formatValue(profile.timezone)}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{formatValue(profile.currency)}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>
                  {[profile.addressLine1, profile.addressLine2, profile.city, profile.region, profile.postalCode, profile.country]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatTimestamp(profile.createdAt)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatTimestamp(profile.updatedAt)}</dd>
              </div>
            </dl>
          )}
        </section>
      )}

      <section aria-labelledby="account-overview-contract">
        <h2 id="account-overview-contract">Contract &amp; billing</h2>
        <dl className="account-overview__grid">
          <div>
            <dt>Store ID</dt>
            <dd>{formatValue(storeId ?? null)}</dd>
          </div>
          <div>
            <dt>Contract status</dt>
            <dd>{formatValue(profile?.contractStatus ?? profile?.status ?? null)}</dd>
          </div>
          <div>
            <dt>Company</dt>
            <dd>{formatValue(profile?.company ?? null)}</dd>
          </div>
          <div>
            <dt>Contract start</dt>
            <dd>{formatValue(profile?.contractStart ?? null)}</dd>
          </div>
          <div>
            <dt>Contract end</dt>
            <dd>{formatValue(profile?.contractEnd ?? null)}</dd>
          </div>
          <div>
            <dt>Payment status</dt>
            <dd>{formatValue(profile?.paymentStatus ?? null)}</dd>
          </div>
          <div>
            <dt>Amount paid</dt>
            <dd>{formatValue(profile?.amountPaid ?? null)}</dd>
          </div>
          <div>
            <dt>Billing plan</dt>
            <dd>{formatValue(profile?.billingPlan ?? null)}</dd>
          </div>
          <div>
            <dt>Payment provider</dt>
            <dd>{formatValue(profile?.paymentProvider ?? null)}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="account-overview-roster">
        <h2 id="account-overview-roster">Team roster</h2>

        {isOwner ? (
          <form onSubmit={handleSubmit} data-testid="account-invite-form" className="account-overview__form">
            <fieldset disabled={submitting}>
              <legend className="sr-only">Invite or update a teammate</legend>
              <div className="account-overview__form-grid">
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select value={role} onChange={event => setRole(event.target.value as Membership['role'])}>
                    <option value="owner">Owner</option>
                    <option value="staff">Staff</option>
                  </select>
                </label>
                <label>
                  <span>Password (optional)</span>
                  <input
                    type="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <button type="submit" className="button button--primary">
                  {submitting ? 'Sending…' : 'Send invite'}
                </button>
              </div>
              {formError && <p className="account-overview__form-error">{formError}</p>}
            </fieldset>
          </form>
        ) : (
          <p role="note">You have read-only access to the team roster.</p>
        )}

        <div className="account-overview__roster" role="table" aria-label="Team roster">
          <div className="account-overview__roster-header" role="row">
            <span role="columnheader">Email</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Invited by</span>
            <span role="columnheader">Updated</span>
            <span role="columnheader">Last seen</span>
            {isOwner && <span role="columnheader">Actions</span>}
          </div>
          {roster.length === 0 && !rosterLoading ? (
            <div role="row" className="account-overview__roster-empty">
              <span role="cell" colSpan={isOwner ? 6 : 5}>
                No team members found.
              </span>
            </div>
          ) : (
            roster.map(member => (
              <div role="row" key={member.id} data-testid={`account-roster-${member.id}`}>
                <span role="cell">{formatValue(member.email)}</span>
                <span role="cell">{member.role === 'owner' ? 'Owner' : 'Staff'}</span>
                <span role="cell">{formatValue(member.invitedBy)}</span>
                <span role="cell">{formatTimestamp(member.updatedAt ?? member.createdAt)}</span>
                <span role="cell">
                  {formatTimestamp(member.lastSeenAt ?? member.updatedAt ?? member.createdAt)}
                </span>
                {isOwner && (
                  <span role="cell">
                    {member.role === 'owner' ? (
                      '—'
                    ) : (
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => handleRevoke(member)}
                        disabled={revokingMemberId === member.id}
                      >
                        {revokingMemberId === member.id ? 'Revoking…' : 'Revoke access'}
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
