# T3 Cloud Clerk Setup

T3 Cloud uses one Clerk application for web, desktop, and mobile authentication. The relay accepts
Clerk JWTs only when they are generated from the `t3-relay` template with the relay URL as the
audience.

## Application Keys

Use keys from the same Clerk instance in each location:

| Consumer                 | Configuration                           | Value                                                 |
| ------------------------ | --------------------------------------- | ----------------------------------------------------- |
| Web and desktop renderer | `apps/web/.env`                         | `VITE_CLERK_PUBLISHABLE_KEY=<publishable key>`        |
| Mobile build             | `apps/mobile/.env` or build environment | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=<publishable key>` |
| Relay deployment         | Alchemy secret                          | `CLERK_SECRET_KEY=<secret key>`                       |

Never put `CLERK_SECRET_KEY` in a client application environment.

## JWT Template

In **Clerk Dashboard > JWT templates**, create a template with:

| Setting | Value                                                  |
| ------- | ------------------------------------------------------ |
| Name    | `t3-relay`                                             |
| Claims  | `{ "aud": "https://t3code-relay.ineededadomain.com" }` |

The `aud` value must be the deployed relay public URL, with no trailing slash, and must match
`VITE_T3_RELAY_URL` and `T3_RELAY_URL`. If the relay domain changes, update all three values.

## Desktop OAuth Redirect Allowlist

The desktop app opens OAuth in the system browser and returns to the app with a custom URL scheme.
In **Clerk Dashboard > Native applications**, enable native application support and add these
entries under the mobile SSO redirect allowlist:

```text
t3code-dev://auth/callback
t3code://auth/callback
```

The first entry is for local desktop development. The second is for packaged desktop builds.
The app also adds a request-scoped `t3_state` query parameter and validates it on callback.

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to the same allowlist.

## Enable Waitlist Access

For a private beta where people should request access, use **Clerk Dashboard > Waitlist**:

1. Toggle on **Enable waitlist** and save.
2. Review requests on the same page and select **Invite** or **Deny**.

Signed-out web and desktop users see Clerk's waitlist enrollment as the T3 Cloud page content,
while approved signed-in users see cloud settings. The browser app also uses `/settings/cloud` as
its Clerk waitlist URL.

On mobile, signed-out users open **Settings > T3 Account** to reach `/settings/waitlist` within the
Settings form sheet. It submits enrollment through Clerk's `useWaitlist()` flow because the prebuilt
`<Waitlist />` component is web-only in the Expo SDK. Approved users can use **Sign in** from that
screen.

## Alternative: Known-User Allowlist

For a closed beta where all permitted users are known in advance, use an allowlist instead of a
request-and-approval waitlist:

To restrict the beta to permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created without a waitlist request flow.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.
