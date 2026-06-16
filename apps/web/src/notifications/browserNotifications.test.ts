import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getNotificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  showCompletionNotification,
} from "./browserNotifications";

const originalWindow = globalThis.window;

interface FakeNotificationInstance {
  listeners: Record<string, Array<() => void>>;
  addEventListener: (type: string, handler: () => void) => void;
  close: ReturnType<typeof vi.fn>;
}

interface FakeNotificationConstructor {
  (this: FakeNotificationInstance, title: string, options?: NotificationOptions): void;
  permission: NotificationPermission;
  requestPermission: ReturnType<typeof vi.fn>;
  instances: Array<{
    title: string;
    options: NotificationOptions | undefined;
    instance: FakeNotificationInstance;
  }>;
}

function makeFakeNotification(permission: NotificationPermission): FakeNotificationConstructor {
  const ctor = vi.fn(function (
    this: FakeNotificationInstance,
    title: string,
    options?: NotificationOptions,
  ) {
    this.listeners = {};
    this.addEventListener = (type: string, handler: () => void) => {
      (this.listeners[type] ??= []).push(handler);
    };
    this.close = vi.fn();
    ctor.instances.push({ title, options, instance: this });
  }) as unknown as FakeNotificationConstructor;

  ctor.instances = [];
  ctor.permission = permission;
  ctor.requestPermission = vi.fn(async () => ctor.permission);

  return ctor;
}

function installWindow(notification: FakeNotificationConstructor | undefined): {
  focus: ReturnType<typeof vi.fn>;
} {
  const focus = vi.fn();
  const win: Record<string, unknown> = { focus };
  if (notification !== undefined) {
    win.Notification = notification;
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: win,
  });
  return { focus };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }
  globalThis.window = originalWindow;
});

describe("notificationsSupported", () => {
  it("returns true when Notification is present on window", () => {
    installWindow(makeFakeNotification("default"));
    expect(notificationsSupported()).toBe(true);
  });

  it("returns false when Notification is absent from window", () => {
    installWindow(undefined);
    expect(notificationsSupported()).toBe(false);
  });
});

describe("getNotificationPermission", () => {
  it("returns the current Notification.permission value", () => {
    installWindow(makeFakeNotification("granted"));
    expect(getNotificationPermission()).toBe("granted");
  });

  it("reflects denied permission", () => {
    installWindow(makeFakeNotification("denied"));
    expect(getNotificationPermission()).toBe("denied");
  });

  it("returns denied when notifications are unsupported", () => {
    installWindow(undefined);
    expect(getNotificationPermission()).toBe("denied");
  });
});

describe("requestNotificationPermission", () => {
  it("resolves the permission returned by Notification.requestPermission", async () => {
    const notification = makeFakeNotification("default");
    notification.requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    installWindow(notification);

    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("short-circuits to granted without re-prompting when already granted", async () => {
    const notification = makeFakeNotification("granted");
    installWindow(notification);

    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it("resolves denied when notifications are unsupported", async () => {
    installWindow(undefined);
    await expect(requestNotificationPermission()).resolves.toBe("denied");
  });
});

describe("showCompletionNotification", () => {
  it("constructs a Notification with the right title, body, and tag when granted", () => {
    const notification = makeFakeNotification("granted");
    installWindow(notification);

    showCompletionNotification({
      title: "Done",
      body: "Thread finished",
      tag: "thread-42",
      onClick: () => {},
    });

    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification.instances).toHaveLength(1);
    const entry = notification.instances[0];
    if (!entry) throw new Error("expected one notification instance");
    expect(entry.title).toBe("Done");
    expect(entry.options?.body).toBe("Thread finished");
    expect(entry.options?.tag).toBe("thread-42");
  });

  it("wires a click listener so a click focuses window, invokes onClick, and closes", () => {
    const notification = makeFakeNotification("granted");
    const { focus } = installWindow(notification);
    const onClick = vi.fn();

    showCompletionNotification({
      title: "Done",
      body: "Thread finished",
      tag: "thread-42",
      onClick,
    });

    const entry = notification.instances[0];
    if (!entry) throw new Error("expected one notification instance");
    const { instance } = entry;
    const clickHandlers = instance.listeners.click ?? [];
    expect(clickHandlers).toHaveLength(1);

    for (const handler of clickHandlers) {
      handler();
    }

    expect(focus).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it("does not construct a Notification when permission is not granted", () => {
    const notification = makeFakeNotification("default");
    installWindow(notification);

    showCompletionNotification({
      title: "Done",
      body: "Thread finished",
      tag: "thread-42",
      onClick: () => {},
    });

    expect(notification).not.toHaveBeenCalled();
    expect(notification.instances).toHaveLength(0);
  });

  it("does not construct a Notification when unsupported", () => {
    installWindow(undefined);
    expect(() =>
      showCompletionNotification({
        title: "Done",
        body: "Thread finished",
        tag: "thread-42",
        onClick: () => {},
      }),
    ).not.toThrow();
  });
});
