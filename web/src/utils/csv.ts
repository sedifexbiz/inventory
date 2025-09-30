export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let row: string[] = []
  let insideQuotes = false

  const pushValue = () => {
    row.push(current)
    current = ''
  }

  const pushRow = () => {
    if (!row.length) return
    rows.push(row.map(cell => cell.trim()))
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (insideQuotes && text[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        insideQuotes = !insideQuotes
      }
    } else if (char === ',' && !insideQuotes) {
      pushValue()
    } else if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      pushValue()
      if (row.some(cell => cell.trim().length > 0)) {
        pushRow()
      } else {
        row = []
      }
    } else {
      current += char
    }
  }

  if (current.length > 0 || row.length > 0) {
    pushValue()
    if (row.some(cell => cell.trim().length > 0)) {
      pushRow()
    }
  }

  return rows
}
