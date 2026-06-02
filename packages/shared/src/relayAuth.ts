export function clerkFrontendApiUrlFromPublishableKey(publishableKey: string): string {
  const encodedFrontendApi = publishableKey.split("_").slice(2).join("_");
  const frontendApi = globalThis.atob(encodedFrontendApi).replace(/\$$/u, "");
  if (frontendApi.length === 0 || frontendApi.includes("/")) {
    throw new Error("Invalid Clerk publishable key.");
  }
  return `https://${frontendApi}`;
}

export function relayClerkTokenOptions(template: string) {
  return {
    template,
    skipCache: true,
  } as const;
}
