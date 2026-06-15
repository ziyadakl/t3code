/**
 * Minimal reader for the flat top-level maps in `pnpm-workspace.yaml`
 * (`catalog:` and `overrides:`), used by the VPS pack/deploy tooling to
 * resolve `catalog:` dependency specs to concrete versions.
 *
 * Why hand-rolled instead of a YAML library: the only maps we need are the
 * flat, two-space-indented `name: version` blocks under a top-level key, and
 * no `yaml` package is reliably resolvable from this scripts context. This is
 * NOT a general YAML parser — it only understands `key:` top-level sections
 * whose entries are single-line `name: value` pairs (keys optionally quoted,
 * values optionally quoted, `#` comment lines and blanks skipped). That is
 * exactly the shape of `catalog:` and `overrides:`.
 */

/**
 * Parse one flat top-level section (e.g. `catalog` or `overrides`) from a
 * `pnpm-workspace.yaml` document into a `name -> value` record. A section ends
 * at the next column-0 (non-indented) key. Missing section -> empty record.
 */
export function readWorkspaceSection(yamlText: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;

  for (const rawLine of yamlText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0 || /^\s*#/.test(line)) {
      continue; // blank / comment
    }
    if (/^[^\s]/.test(line)) {
      // Column-0 key: starts a new top-level section (and ends any prior one).
      const key = line.match(/^([^:]+):/);
      inSection = key !== null && (key[1] ?? "").trim() === section;
      continue;
    }
    if (!inSection) {
      continue;
    }
    // Indented entry: `name: value`, name optionally quoted, value optionally
    // quoted. The value may itself contain ':' (e.g. `npm:@scope/pkg@1.2.3`),
    // so capture everything after the first `: ` separator.
    const entry = line.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^:\s]+))\s*:\s*(.+?)\s*$/);
    if (entry === null) {
      continue;
    }
    const name = entry[1] ?? entry[2] ?? entry[3];
    let value = entry[4];
    if (name === undefined || value === undefined) {
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }

  return out;
}
