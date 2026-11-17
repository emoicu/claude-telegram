/** Is version a newer than b? Compares the first three numeric parts (1.2.3, 1.2.3-x). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}
