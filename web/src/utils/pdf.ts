function escapePdfText(text: string) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
}

export function buildSimplePdf(title: string, lines: string[]): Uint8Array {
  const encoder = new TextEncoder()
  const header = '%PDF-1.4\n'

  let content = 'BT\n'
  content += '/F1 18 Tf\n'
  content += '72 760 Td\n'
  content += `(${escapePdfText(title)}) Tj\n`
  content += '/F1 11 Tf\n'
  content += '0 -20 Td\n'

  lines.forEach((line, index) => {
    content += `(${escapePdfText(line)}) Tj\n`
    if (index < lines.length - 1) {
      content += '0 -16 Td\n'
    }
  })

  content += 'ET\n'

  const contentBytes = encoder.encode(content)

  const objects: string[] = []
  const offsets: number[] = [0]

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n')
  objects.push(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream\nendobj\n`)
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  let currentOffset = header.length
  const encodedObjects = objects.map(obj => {
    offsets.push(currentOffset)
    const bytes = encoder.encode(obj)
    currentOffset += bytes.length
    return bytes
  })

  const xrefOffset = currentOffset
  let xref = `xref\n0 ${objects.length + 1}\n`
  xref += '0000000000 65535 f \n'
  for (let i = 1; i < offsets.length; i++) {
    xref += offsets[i].toString().padStart(10, '0') + ' 00000 n \n'
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  const parts: Uint8Array[] = [encoder.encode(header), ...encodedObjects, encoder.encode(xref), encoder.encode(trailer)]

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  parts.forEach(part => {
    result.set(part, offset)
    offset += part.length
  })

  return result
}
