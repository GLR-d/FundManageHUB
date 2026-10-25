export const getMonthlyExpenseLabels = (count: number, availableWidth: number): number[] => {
  if (!Number.isInteger(count) || count < 1) return []
  if (count === 1) return [0]
  const width = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0
  const capacity = Math.max(2, Math.min(count, Math.floor(width / 62)))
  const step = Math.max(1, Math.ceil((count - 1) / (capacity - 1)))
  const labels = [0]
  for (let index = step; index < count - 1; index += step) labels.push(index)
  if (labels.length > 1 && count - 1 - labels[labels.length - 1] < step / 2) labels.pop()
  labels.push(count - 1)
  return labels
}
export const nearestExpenseMonth = (x: number, left: number, width: number, count: number): number => {
  if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0 || count <= 1) return 0
  return Math.max(0, Math.min(count - 1, Math.floor((x - left) / width * count)))
}
