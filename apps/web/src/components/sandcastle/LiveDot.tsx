/**
 * Small pulsing green dot signalling a Sandcastle run that is live right now.
 * Mirrors the ConnectionStatusDot ping/dot pattern (settings/ConnectionsSettings):
 * an expanding `animate-ping` ring behind a solid dot, in the themed success color.
 */
export function LiveDot() {
  return (
    <span
      aria-hidden
      className="relative flex size-2 shrink-0 items-center justify-center"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/75" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}
