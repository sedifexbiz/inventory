import React from 'react'

type SparklineProps = {
  data: number[]
  comparisonData?: number[]
  color?: string
  comparisonColor?: string
}

export default function Sparkline({
  data,
  comparisonData,
  color = '#4338CA',
  comparisonColor = '#A5B4FC',
}: SparklineProps) {
  if (!data.length) {
    return null
  }

  const width = Math.max(80, data.length * 12)
  const height = 48
  const allValues = [...data, ...(comparisonData ?? [])]
  const maxValue = Math.max(...allValues, 0)
  const minValue = Math.min(...allValues, 0)
  const range = maxValue - minValue || 1

  const createPoints = (series: number[]) =>
    series
      .map((value, index) => {
        const x = series.length > 1 ? (index / (series.length - 1)) * (width - 4) + 2 : width / 2
        const normalized = (value - minValue) / range
        const y = height - 4 - normalized * (height - 8)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const primaryPoints = createPoints(data)
  const comparisonPoints = comparisonData && comparisonData.length ? createPoints(comparisonData) : null

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="48"
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      {comparisonPoints && (
        <polyline
          points={comparisonPoints}
          fill="none"
          stroke={comparisonColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="4 4"
          opacity={0.7}
        />
      )}
      <polyline
        points={primaryPoints}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  )
}
