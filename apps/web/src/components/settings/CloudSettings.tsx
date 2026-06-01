import { UserButton, Waitlist, useAuth, useClerk } from "@clerk/react";
import { useSignIn, useSignUp } from "@clerk/react/legacy";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { CloudIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DesktopCloudAuthOAuthStrategy,
  resolveDesktopCloudAuthOAuthOptions,
} from "../../cloud/desktopAuth";
import {
  listCloudDevices,
  readPrimaryCloudLinkState,
  type CloudLinkState,
  updatePrimaryCloudPreferences,
} from "../../cloud/linkEnvironment";
import { isElectron } from "../../env";
import { fetchSessionState, usePrimaryEnvironmentId } from "../../environments/primary";
import { webRuntime } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function hasClerkConfig(): boolean {
  return Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}

class CloudSettingsOperationError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CloudSettingsOperationError";
    this.cause = cause;
  }
}

async function runCloudOperation<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new CloudSettingsOperationError(message, cause);
  }
}

function cloudErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CloudSettingsOperationError) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function CloudSettingsPanel() {
  if (!hasClerkConfig()) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
          <SettingsRow
            title="Cloud account"
            description="Set VITE_CLERK_PUBLISHABLE_KEY to enable optional cloud features."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <ConfiguredCloudSettingsPanel />;
}

function ConfiguredCloudSettingsPanel() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return null;
  }

  return isSignedIn ? <CloudSettingsPanelInner /> : <CloudWaitlistPanel />;
}

function CloudWaitlistPanel() {
  return (
    <SettingsPageContainer className="min-h-full items-center justify-center">
      <Waitlist />
      {isElectron ? (
        <div className="flex flex-col items-center gap-3 text-xs text-muted-foreground">
          <p>Already approved? Sign in through the desktop app.</p>
          <DesktopCloudSignInButton />
        </div>
      ) : null}
    </SettingsPageContainer>
  );
}

function CloudSettingsPanelInner() {
  const { getToken } = useAuth();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [primaryLinkState, setPrimaryLinkState] = useState<CloudLinkState | null>(null);
  const [devices, setDevices] = useState<ReadonlyArray<RelayClientDeviceRecord>>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);
  const [canManageRelay, setCanManageRelay] = useState(false);

  const refreshPrimaryLinkState = useCallback(() => {
    if (!primaryEnvironmentId) {
      setPrimaryLinkState(null);
      return;
    }
    void webRuntime
      .runPromise(readPrimaryCloudLinkState())
      .then(setPrimaryLinkState, () => setPrimaryLinkState(null));
  }, [primaryEnvironmentId]);

  useEffect(() => {
    refreshPrimaryLinkState();
  }, [refreshPrimaryLinkState]);

  useEffect(() => {
    void fetchSessionState()
      .then((session) =>
        setCanManageRelay(
          session.authenticated && Boolean(session.scopes?.includes(AuthRelayWriteScope)),
        ),
      )
      .catch(() => setCanManageRelay(false));
  }, []);

  const refreshDevices = useCallback(async () => {
    setIsLoadingDevices(true);
    try {
      const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
      if (!token) {
        setDevices([]);
        return;
      }
      setDevices(await webRuntime.runPromise(listCloudDevices({ clerkToken: token })));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud devices unavailable",
        description: cloudErrorMessage(error, "Could not load notification devices."),
      });
    } finally {
      setIsLoadingDevices(false);
    }
  }, [getToken]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const updatePublishAgentActivity = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    try {
      const state = await webRuntime.runPromise(
        updatePrimaryCloudPreferences({ publishAgentActivity: enabled }),
      );
      setPrimaryLinkState(state);
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment can publish agent activity to your notification devices."
          : "This environment will stop publishing agent activity.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud preference update failed",
        description: cloudErrorMessage(error, "Could not update cloud preferences."),
      });
    } finally {
      setIsUpdatingPreference(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
        <SettingsRow
          title="Cloud account"
          description="Manage your private-beta T3 Cloud session."
          control={<UserButton />}
        />
      </SettingsSection>
      <SettingsSection title="Preferences">
        <SettingsRow
          title="Publish agent activity"
          description="Allow this environment to send agent activity to your notification devices."
          status={
            !primaryLinkState?.linked ? "Link this environment from Connections first." : null
          }
          control={
            <Switch
              aria-label="Publish agent activity"
              checked={primaryLinkState?.publishAgentActivity ?? false}
              disabled={!primaryLinkState?.linked || !canManageRelay || isUpdatingPreference}
              onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Notification devices"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={isLoadingDevices}
            onClick={() => void refreshDevices()}
          >
            {isLoadingDevices ? "Refreshing..." : "Refresh"}
          </Button>
        }
      >
        {devices.map((device) => (
          <SettingsRow
            key={device.deviceId}
            title={device.label}
            description={`iOS ${device.iosMajorVersion}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`}
            status={
              device.notifications.enabled
                ? device.liveActivities.enabled
                  ? "Notifications and Live Activities enabled"
                  : "Notifications enabled · Live Activities disabled"
                : "Notifications disabled on device"
            }
          />
        ))}
        {!isLoadingDevices && devices.length === 0 ? (
          <SettingsRow
            title="No notification devices"
            description="Sign in on the mobile app to register a device for account-level notifications."
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function DesktopCloudSignInButton() {
  const clerk = useClerk();
  const { setActive } = clerk;
  const { isLoaded: signInLoaded, signIn } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const [startingStrategy, setStartingStrategy] = useState<DesktopCloudAuthOAuthStrategy | null>(
    null,
  );
  const oauthOptions = resolveDesktopCloudAuthOAuthOptions(clerk);
  const callbackCleanupRef = useRef<(() => void) | null>(null);

  const clearCallbackListener = useCallback(() => {
    callbackCleanupRef.current?.();
    callbackCleanupRef.current = null;
  }, []);

  const completeOAuthCallback = useCallback(
    async (rawUrl: string) => {
      if (!signInLoaded || !signIn || !signUpLoaded || !signUp) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: "Clerk is still loading. Try signing in again.",
        });
        return;
      }

      let rotatingTokenNonce: string | null = null;
      let sessionId: string | null = null;
      try {
        const callbackUrl = new URL(rawUrl);
        rotatingTokenNonce = callbackUrl.searchParams.get("rotating_token_nonce");
        sessionId = callbackUrl.searchParams.get("created_session_id");
      } catch {
        // Handled by the explicit nonce check below.
      }
      if (!rotatingTokenNonce) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description:
            "Clerk did not return a native session nonce. Verify this redirect URL is allowlisted for native SSO redirects.",
        });
        return;
      }

      try {
        await runCloudOperation(
          () => signIn.reload({ rotatingTokenNonce }),
          "Could not reload the desktop sign-in session.",
        );
        sessionId = sessionId || signIn.createdSessionId;

        if (!sessionId && signIn.firstFactorVerification.status === "transferable") {
          const signUpAttempt = await runCloudOperation(
            () => signUp.create({ transfer: true }),
            "Could not transfer the desktop sign-up session.",
          );
          sessionId = signUpAttempt.createdSessionId;
        }

        if (!sessionId) {
          throw new CloudSettingsOperationError("Clerk did not create a desktop session.");
        }

        await runCloudOperation(
          () => setActive({ session: sessionId! }),
          "Could not activate the desktop cloud session.",
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: cloudErrorMessage(error, "Could not complete cloud sign-in."),
        });
      }
    },
    [setActive, signIn, signInLoaded, signUp, signUpLoaded],
  );

  useEffect(() => {
    return () => {
      clearCallbackListener();
    };
  }, [clearCallbackListener]);

  const startOAuth = async (strategy: DesktopCloudAuthOAuthStrategy) => {
    if (!signInLoaded || !signIn) {
      toastManager.add({
        type: "error",
        title: "Cloud sign-in failed",
        description: "Clerk is still loading. Try signing in again.",
      });
      return;
    }

    setStartingStrategy(strategy);
    clearCallbackListener();
    try {
      const redirectUrl = await runCloudOperation(
        () => window.desktopBridge?.createCloudAuthRequest() ?? Promise.resolve(undefined),
        "Desktop auth callback is unavailable.",
      );
      if (!redirectUrl) {
        throw new CloudSettingsOperationError("Desktop auth callback is unavailable.");
      }

      callbackCleanupRef.current =
        window.desktopBridge?.onCloudAuthCallback((rawUrl) => {
          clearCallbackListener();
          void completeOAuthCallback(rawUrl);
        }) ?? null;

      const signInAttempt = await runCloudOperation(
        () => signIn.create({ strategy, redirectUrl } as never),
        "Could not create the desktop OAuth request.",
      );
      const externalUrl =
        signInAttempt.firstFactorVerification.externalVerificationRedirectURL?.toString();
      if (!externalUrl) {
        throw new CloudSettingsOperationError(
          "Clerk did not return an external OAuth redirect URL.",
        );
      }

      const opened = await runCloudOperation(
        () => window.desktopBridge?.openExternal(externalUrl) ?? Promise.resolve(false),
        "Could not open the system browser.",
      );
      if (!opened) {
        throw new CloudSettingsOperationError("Could not open the system browser.");
      }
    } catch (error) {
      clearCallbackListener();
      toastManager.add({
        type: "error",
        title: "Cloud sign-in failed",
        description: cloudErrorMessage(error, "Could not start cloud sign-in."),
      });
    } finally {
      setStartingStrategy(null);
    }
  };

  const isStarting = startingStrategy !== null;

  if (oauthOptions.length === 0) {
    return (
      <Button disabled size="sm">
        No OAuth providers enabled
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {oauthOptions.map((option) => (
        <Button
          key={option.strategy}
          disabled={isStarting}
          onClick={() => void startOAuth(option.strategy)}
          size="sm"
        >
          {startingStrategy === option.strategy ? "Opening..." : `Continue with ${option.label}`}
        </Button>
      ))}
    </div>
  );
}
