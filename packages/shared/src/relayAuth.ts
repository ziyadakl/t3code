export function relayClerkTokenOptions(template: string) {
  return {
    template,
    skipCache: true,
  } as const;
}
