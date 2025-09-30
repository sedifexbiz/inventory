import { within } from '@testing-library/react'

function resolveSellPageRoot(root: HTMLElement) {
  const { getByRole } = within(root)
  const heading = getByRole('heading', { level: 2, name: /sell/i })
  const pageRoot = heading.closest('.page')
  if (!pageRoot) {
    throw new Error('Unable to locate sell page root')
  }
  return { heading, pageRoot: pageRoot as HTMLElement }
}

export function createSellSelectors(root: HTMLElement = document.body) {
  const { heading, pageRoot } = resolveSellPageRoot(root)
  const queries = within(pageRoot)

  return {
    heading: () => heading,
    searchField: () => queries.getByLabelText('Find a product'),
    productCatalogSection: () => queries.getByRole('region', { name: 'Product list' }),
    cartSection: () => queries.getByRole('region', { name: 'Cart' }),
    paymentMethodSelect: () => queries.getByLabelText('Payment method'),
    cashReceivedInput: () => queries.getByLabelText('Cash received'),
    recordSaleButton: () => queries.getByRole('button', { name: /record sale/i }),
    subtotalDisplay: () => {
      const subtotalLabel = queries.getByText('Subtotal')
      const subtotalContainer = subtotalLabel.closest('div')
      if (!subtotalContainer) {
        throw new Error('Unable to locate subtotal container')
      }
      return subtotalContainer as HTMLElement
    },
    loyaltyNotice: () =>
      queries.queryByRole('status', {
        name: /keep .* coming back/i,
      }),
  }
}

export const sellSelectors = createSellSelectors

export type SellSelectors = ReturnType<typeof createSellSelectors>
