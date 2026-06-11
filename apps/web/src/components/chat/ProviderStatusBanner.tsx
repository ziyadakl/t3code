import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";

/**
 * The banner is shown only for a provider that is enabled/selected and in a
 * non-healthy state worth surfacing. A disabled or unselected provider must
 * never raise a red "CLI not installed" error — that was the spurious Codex
 * banner shown while using Claude with Codex switched off. Written as a type
 * guard so the component body can treat `status` as non-null.
 */
export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
): status is ServerProvider {
  return !!status && status.enabled && status.status !== "ready" && status.status !== "disabled";
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!shouldShowProviderStatusBanner(status)) {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});
