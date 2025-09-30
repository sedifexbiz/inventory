export const DEFAULT_CURRENCY_CODE = 'GHS'
export const DEFAULT_CURRENCY_SYMBOL = 'GHS'

export interface FormatCurrencyOptions extends Intl.NumberFormatOptions {
  locale?: string
  symbol?: string
}

export function formatCurrency(amount: number, options: FormatCurrencyOptions = {}): string {
  const { locale, symbol = DEFAULT_CURRENCY_SYMBOL, style, currency, ...intlOptions } = options

  if (style === 'currency') {
    const formatted = amount
      .toLocaleString(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        style: 'currency',
        currency: currency ?? DEFAULT_CURRENCY_CODE,
        ...intlOptions,
      })
      .replace(/\u00a0/g, ' ')

    return formatted
  }

  const formatted = amount.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...intlOptions,
  })

  return `${symbol} ${formatted}`
}
