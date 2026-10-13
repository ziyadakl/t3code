import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const COOKIE_IMPORT_BANNER_STORAGE_KEY = "t3code:preview-cookie-import-banner:v1";

const CookieImportBannerSchema = Schema.Struct({ dismissed: Schema.Boolean });
const NOT_DISMISSED = { dismissed: false };

/**
 * Whether the preview pane's import prompt was put away. Device-local and
 * permanent: the ⋮ menu keeps the import reachable after it is gone.
 */
export function useCookieImportBannerDismissal() {
  const [state, setState] = useLocalStorage(
    COOKIE_IMPORT_BANNER_STORAGE_KEY,
    NOT_DISMISSED,
    CookieImportBannerSchema,
  );
  return {
    dismissed: state.dismissed,
    dismiss: () => setState({ dismissed: true }),
  };
}
