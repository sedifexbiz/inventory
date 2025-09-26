const STORAGE_PREFIX = 'sedifex.onboarding.status.'

export type OnboardingStatus = 'pending' | 'completed'

function getStorageKey(uid: string) {
  return `${STORAGE_PREFIX}${uid}`
}

function canUseStorage(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return typeof window.localStorage !== 'undefined'
  } catch (error) {
    console.warn('[onboarding] Local storage is not accessible', error)
    return false
  }
}

export function getOnboardingStatus(uid: string | null): OnboardingStatus | null {
  if (!uid || !canUseStorage()) {
    return null
  }

  try {
    const value = window.localStorage.getItem(getStorageKey(uid))
    if (value === 'pending' || value === 'completed') {
      return value
    }
    return null
  } catch (error) {
    console.warn('[onboarding] Failed to read onboarding status', error)
    return null
  }
}

export function setOnboardingStatus(uid: string | null, status: OnboardingStatus) {
  if (!uid || !canUseStorage()) {
    return
  }

  try {
    window.localStorage.setItem(getStorageKey(uid), status)
  } catch (error) {
    console.warn('[onboarding] Failed to persist onboarding status', error)
  }
}

export function clearOnboardingStatus(uid: string | null) {
  if (!uid || !canUseStorage()) {
    return
  }

  try {
    window.localStorage.removeItem(getStorageKey(uid))
  } catch (error) {
    console.warn('[onboarding] Failed to clear onboarding status', error)
  }
}

export function hasCompletedOnboarding(uid: string | null): boolean {
  return getOnboardingStatus(uid) === 'completed'
}
