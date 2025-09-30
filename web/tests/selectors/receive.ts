import { within } from '@testing-library/react'

function resolveReceivePageRoot(root: HTMLElement) {
  const { getByRole } = within(root)
  const heading = getByRole('heading', { level: 2, name: /receive stock/i })
  const pageRoot = heading.closest('.page')
  if (!pageRoot) {
    throw new Error('Unable to locate receive page root')
  }
  return { heading, pageRoot: pageRoot as HTMLElement }
}

export function createReceiveSelectors(root: HTMLElement = document.body) {
  const { heading, pageRoot } = resolveReceivePageRoot(root)
  const queries = within(pageRoot)

  return {
    heading: () => heading,
    productSelect: () => queries.getByLabelText('Product') as HTMLSelectElement,
    quantityInput: () => queries.getByLabelText('Quantity received') as HTMLInputElement,
    supplierInput: () => queries.getByLabelText('Supplier') as HTMLInputElement,
    referenceInput: () => queries.getByLabelText('Reference number') as HTMLInputElement,
    unitCostInput: () => queries.getByLabelText('Unit cost (optional)') as HTMLInputElement,
    addStockButton: () => queries.getByRole('button', { name: /add stock/i }),
    statusMessage: () => queries.queryByRole('status') ?? queries.queryByRole('alert'),
  }
}

export const receiveSelectors = createReceiveSelectors

export type ReceiveSelectors = ReturnType<typeof createReceiveSelectors>
