/**
 * Header control that narrows the sidebar to one machine (environment). Its
 * icon swaps to the selected machine's icon while a filter is active. The
 * caller renders it only when more than one machine is known.
 */
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { ComputerIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function SidebarEnvironmentFilter(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  /** The effective filter: null means all machines. */
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId | null) => void;
}) {
  const selected =
    props.selectedEnvironmentId === null
      ? null
      : (props.environments.find(
          (environment) => environment.environmentId === props.selectedEnvironmentId,
        ) ?? null);
  // Same fallback the thread rows use when a machine has not reported its kind.
  const machineOf = (environmentId: EnvironmentId) =>
    props.machineByEnvironmentId.get(environmentId) ?? "server";

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              selected
                ? `Filter threads by machine: ${selected.label}`
                : "Filter threads by machine"
            }
          />
        }
      >
        {selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={machineOf(selected.environmentId)}
            className="size-4"
          />
        ) : (
          <ComputerIcon aria-hidden className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-[min(18rem,var(--available-width))]">
        {/* null is "All machines": Base UI radio values compare by identity and
            accept null, so no sentinel string shares the environment id space. */}
        <MenuRadioGroup
          value={selected?.environmentId ?? null}
          onValueChange={(value: EnvironmentId | null) => props.onSelect(value)}
        >
          <MenuRadioItem value={null} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <ComputerIcon aria-hidden className="size-4" />
              <span className="min-w-0 truncate">All machines</span>
            </span>
          </MenuRadioItem>
          <MenuSeparator />
          {props.environments.map((environment) => (
            <MenuRadioItem
              key={environment.environmentId}
              value={environment.environmentId}
              closeOnClick
            >
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={machineOf(environment.environmentId)}
                  className="size-4"
                />
                <span className="min-w-0 truncate">{environment.label}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
