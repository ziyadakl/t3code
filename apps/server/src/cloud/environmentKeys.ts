import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const CLOUD_LINK_PRIVATE_KEY = "cloud-link-ed25519-private-key";
const CLOUD_LINK_PUBLIC_KEY = "cloud-link-ed25519-public-key";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export const getOrCreateEnvironmentKeyPairFromSecretStore = Effect.fn(function* (
  secrets: ServerSecretStore.ServerSecretStoreShape,
) {
  const existingPrivate = yield* secrets.get(CLOUD_LINK_PRIVATE_KEY);
  const existingPublic = yield* secrets.get(CLOUD_LINK_PUBLIC_KEY);
  if (existingPrivate && existingPublic) {
    return {
      privateKey: bytesToString(existingPrivate),
      publicKey: bytesToString(existingPublic),
    };
  }

  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  yield* secrets.set(CLOUD_LINK_PRIVATE_KEY, stringToBytes(keyPair.privateKey));
  yield* secrets.set(CLOUD_LINK_PUBLIC_KEY, stringToBytes(keyPair.publicKey));
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
});
