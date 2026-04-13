type ClosestCapable = Pick<Element, 'closest'>

export function shouldMutateLiveSidenoteDom(
  target: ClosestCapable | null | undefined,
  isComposing: boolean,
): boolean {
  return !isComposing && !target?.closest('.md-focus')
}
