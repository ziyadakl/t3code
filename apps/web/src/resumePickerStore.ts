import { create } from "zustand";

/**
 * Open/close state for the `/resume` picker (CLI <-> t3 conversation continuity).
 *
 * The picker is rendered once inside ChatView (which owns the project cwd and
 * environment id), but it can be opened from two places: the composer's
 * `/resume` slash-command menu-select, and the typed-and-Enter path in
 * ChatView.onSend. A tiny shared store lets both trigger it without threading a
 * new callback prop through ChatComposer. Mirrors `commandPaletteStore`.
 */
interface ResumePickerStore {
  open: boolean;
  /** Request the picker to open (from a slash-command trigger). */
  requestOpen: () => void;
  setOpen: (open: boolean) => void;
}

export const useResumePickerStore = create<ResumePickerStore>((set) => ({
  open: false,
  requestOpen: () => set({ open: true }),
  setOpen: (open) => set({ open }),
}));
