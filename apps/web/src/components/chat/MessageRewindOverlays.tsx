import type { ComponentProps } from "react";
import { RewindDialog } from "./RewindDialog";
import { RewindPicker } from "./RewindPicker";

/** The Esc picker and the rewind menu `useMessageRewind` drives; ChatView renders one element. */
export function MessageRewindOverlays(props: {
  picker: ComponentProps<typeof RewindPicker>;
  dialog: ComponentProps<typeof RewindDialog>;
}) {
  return (
    <>
      <RewindPicker {...props.picker} />
      <RewindDialog {...props.dialog} />
    </>
  );
}
