import { within } from '@testing-library/react'

function resolveTodayPageRoot(root: HTMLElement) {
  const { getByRole } = within(root)
  const heading = getByRole('heading', { level: 2, name: /today/i })
  const header = heading.closest('header')
  const pageRoot =
    (header?.parentElement as HTMLElement | null) ??
    (heading.closest('main') as HTMLElement | null) ??
    root
  if (!pageRoot) {
    throw new Error('Unable to locate today page root')
  }
  return { heading, pageRoot: pageRoot as HTMLElement }
}

export function createTodaySelectors(root: HTMLElement = document.body) {
  const { heading, pageRoot } = resolveTodayPageRoot(root)
  const queries = within(pageRoot)

  const quickActionsNav = () => queries.getByRole('navigation', { name: 'Quick actions' })
  const quickActionLink = (label: string) => {
    const nav = quickActionsNav()
    try {
      return within(nav).getByRole('link', { name: label })
    } catch (error) {
      const links = within(nav).getAllByRole('link')
      const match = links.find(link => link.textContent?.trim() === label)
      if (match) {
        return match
      }
      throw new Error(`Quick action link "${label}" not found`)
    }
  }

  const kpiHeading = () => queries.getByRole('heading', { name: 'Key performance indicators' })
  const kpiSection = () => {
    const section = kpiHeading().closest('section')
    if (!section) {
      throw new Error('Unable to locate KPI section')
    }
    return section as HTMLElement
  }
  const kpiCards = () => within(kpiSection()).queryAllByRole('article')

  const activityHeading = () => queries.getByRole('heading', { name: 'Activity feed' })
  const activitySection = () => {
    const section = activityHeading().closest('section')
    if (!section) {
      throw new Error('Unable to locate activity section')
    }
    return section as HTMLElement
  }
  const activityFilterGroup = () => queries.getByRole('group', { name: 'Filter activity feed' })
  const activityFilterButton = (label: string) =>
    within(activityFilterGroup()).getByRole('button', { name: label })
  const activityList = () => within(activitySection()).queryByRole('list')
  const activityItems = () => {
    const list = activityList()
    return list ? within(list).queryAllByRole('listitem') : []
  }

  return {
    heading: () => heading,
    quickActionsNav,
    quickActionLink,
    kpiHeading,
    kpiSection,
    kpiCards,
    activityHeading,
    activitySection,
    activityFilterGroup,
    activityFilterButton,
    activityList,
    activityItems,
  }
}

export const todaySelectors = createTodaySelectors

export type TodaySelectors = ReturnType<typeof createTodaySelectors>
