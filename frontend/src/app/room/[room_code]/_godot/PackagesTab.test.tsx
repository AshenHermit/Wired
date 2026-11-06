import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  IntlProvider,
  renderWithIntl as render,
} from "@/test/render-with-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PackageSlugAvailability,
  Room,
  ScriptingPackage,
  WorkshopPackageSummary,
} from "@wired-io/shared";
import type {
  RoomPackageEntry,
  RoomPackagesController,
} from "./use-room-packages";
import {
  LocalChangesError,
  NewerRevisionError,
  PackageDirectoryRenameError,
  SlugRenameDependentsError,
  WorkshopActionError,
  WorkshopSlugTakenError,
} from "./use-room-packages";
import { PackagesTab } from "./PackagesTab";
import { resetWorkshopTagsCache } from "@/components/packages/use-workshop-tags";

vi.mock("@/api/services/scripting-packages", async (importActual) => {
  const actual =
    await importActual<typeof import("@/api/services/scripting-packages")>();
  return {
    ...actual,
    listWorkshopPackages: vi.fn(),
    listWorkshopTags: vi.fn(),
    lookupWorkshopPackage: vi.fn(),
    getScriptingPackage: vi.fn(),
  };
});

import * as packagesApi from "@/api/services/scripting-packages";

function entry(overrides: Partial<RoomPackageEntry> = {}): RoomPackageEntry {
  return {
    packageId: 5,
    slug: "demo",
    name: "Demo",
    version: "0.1.0",
    description: "",
    tags: [],
    previewImage: null,
    status: "loaded",
    enabled: true,
    loaded: true,
    inEditor: true,
    publishedRevision: 2,
    loadedRevision: 2,
    publishedAt: "2026-10-30T10:00:00.000Z",
    localChanges: [],
    backendState: "ready",
    runtimeState: "applied",
    runtimeError: null,
    clientsReady: 1,
    clientsTotal: 1,
    ...overrides,
  };
}

function controller(
  overrides: Partial<RoomPackagesController> = {},
): RoomPackagesController {
  const base: RoomPackagesController = {
    entries: [entry()],
    fsReady: true,
    statusLoaded: true,
    error: null,
    actions: {},
    actionFor: () => ({
      busy: false,
      progress: null,
      notice: null,
      error: null,
    }),
    afterEditorStart: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    createPackage: vi.fn().mockResolvedValue({ id: 7, name: "New" }),
    checkSlugAvailability: vi
      .fn()
      .mockResolvedValue({
        slug: "new",
        available: true,
        global: { available: true },
      }),
    updatePackageMetadata: vi.fn().mockResolvedValue({} as never),
    isPackageDirOccupied: vi.fn().mockResolvedValue(false),
    renamePackageDir: vi.fn().mockResolvedValue(undefined),
    applyPublishedRevision: vi.fn().mockResolvedValue(undefined),
    removePackageDirectory: vi.fn().mockResolvedValue(undefined),
    setPackageEnabled: vi.fn().mockResolvedValue(undefined),
    deletePackageRecord: vi.fn().mockResolvedValue(undefined),
    adoptPackage: vi.fn().mockResolvedValue(undefined),
    emitPackage: vi.fn().mockResolvedValue(undefined),
    copyFromWorkshop: vi.fn().mockResolvedValue({ id: 9 }),
    publishToWorkshop: vi
      .fn()
      .mockResolvedValue({ mode: "created", package: workshopPackage() }),
    forkWorkshopPackage: vi.fn().mockResolvedValue({ id: 11 }),
  };
  return { ...base, ...overrides };
}

function workshopPackage(
  overrides: Partial<WorkshopPackageSummary> = {},
): WorkshopPackageSummary {
  return {
    id: 100,
    slug: "demo",
    name: "Workshop Demo",
    version: "1.0.0",
    description: "",
    tags: [],
    author: {
      id: 42,
      name: "Автор",
      picture: "",
    },
    revision: 1,
    publishedAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    ...overrides,
  };
}

/** The room package a publish dialog falls back to when no record exists. */
function roomPackage(
  overrides: Partial<ScriptingPackage> = {},
): ScriptingPackage {
  return {
    id: 5,
    slug: "demo",
    name: "Demo",
    version: "0.1.0",
    description: "Описание из комнаты",
    tags: ["room", "demo"],
    previewImage: null,
    enabled: true,
    dependencies: [],
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    ...overrides,
  };
}

function roomFixture(overrides: Partial<Room> = {}): Room {
  return {
    id: 1,
    name: "Room",
    type: "godot",
    description: "",
    isPublic: false,
    parentRoomId: null,
    previewImage: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    ...overrides,
  };
}

async function openPackageActions() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Действия с пакетом" }),
    { button: 0 },
  );
  const menu = await screen.findByRole("menu");
  return within(menu);
}

beforeEach(() => {
  vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
    items: [],
    total: 0,
  });
  vi.mocked(packagesApi.lookupWorkshopPackage).mockResolvedValue(null);
  vi.mocked(packagesApi.getScriptingPackage).mockResolvedValue(roomPackage());
  vi.mocked(packagesApi.listWorkshopTags).mockResolvedValue({
    items: [],
    total: 0,
  });
  resetWorkshopTagsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PackagesTab", () => {
  it("lists all room packages with their editor and backend states", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [
            entry(),
            entry({
              packageId: 6,
              name: "Other",
              status: "not-loaded",
              loaded: false,
              inEditor: false,
              publishedRevision: null,
              loadedRevision: null,
              backendState: null,
              runtimeState: null,
              clientsReady: 0,
              clientsTotal: 0,
            }),
            entry({
              packageId: 7,
              name: "Fresh",
              status: "new-revision",
              publishedRevision: 5,
              loadedRevision: 2,
            }),
            entry({
              packageId: 8,
              name: "Dirty",
              status: "local-changes",
              localChanges: ["scripts/hero.gd"],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("Demo")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.getByText("Fresh")).toBeTruthy();
    expect(screen.getByText("Dirty")).toBeTruthy();
    expect(screen.getByText("не загружен")).toBeTruthy();
    expect(screen.getByText("загружен")).toBeTruthy();
    expect(screen.getByText("есть новая ревизия")).toBeTruthy();
    expect(screen.getByText("локальные изменения")).toBeTruthy();
    expect(screen.getByText("scripts/hero.gd")).toBeTruthy();
    expect(screen.getAllByText(/готов у всех клиентов/).length).toBeGreaterThan(
      0,
    );
  });

  it("shows the backend runtime error verbatim", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [
            entry({
              runtimeError: "Godot: script error at res://main.gd:12",
            }),
          ],
        })}
      />,
    );

    expect(
      screen.getByText(/Godot: script error at res:\/\/main.gd:12/),
    ).toBeTruthy();
  });

  it("renders package statuses in English", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [
            entry({
              packageId: 6,
              name: "Other",
              status: "not-loaded",
              loaded: false,
              inEditor: false,
              publishedRevision: null,
              loadedRevision: null,
              backendState: null,
              runtimeState: null,
              clientsReady: 0,
              clientsTotal: 0,
            }),
          ],
        })}
      />,
      { locale: "en" },
    );

    expect(screen.getByText("Room packages")).toBeTruthy();
    expect(screen.getByText("not loaded")).toBeTruthy();
  });

  it("retranslates a stored package notice", () => {
    const props = {
      roomId: 1,
      canManagePackages: true,
      canCreatePackages: true,
      viewerId: 42,
      room: roomFixture(),
      packages: controller({
        actionFor: () => ({
          busy: false,
          progress: null,
          notice: { key: "Packages.notices.addedToRoom" },
          error: null,
        }),
      }),
    };
    const view = render(<PackagesTab onRoomSaved={vi.fn()} {...props} />, { locale: "ru" });

    expect(screen.getByText("Пакет добавлен в комнату")).toBeTruthy();

    view.rerender(
      <IntlProvider locale="en">
        <PackagesTab onRoomSaved={vi.fn()} {...props} />
      </IntlProvider>,
    );

    expect(screen.getByText("Package added to the room")).toBeTruthy();
  });

  it("explains that Godot needs a project reload to see written files", () => {
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}canCreatePackages canManagePackages viewerId={42} packages={controller()} />);

    expect(
      screen.getByText(/Project → Reload Current Project/),
    ).toBeTruthy();
  });

  it("asks before replacing local changes and repeats the download", async () => {
    const applyPublishedRevision = vi
      .fn()
      .mockRejectedValueOnce(
        new LocalChangesError(5, ["scripts/hero.gd"]),
      )
      .mockResolvedValueOnce(undefined);

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({ applyPublishedRevision })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: /скачать в редактор/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/локальные изменения/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));

    await waitFor(() => expect(applyPublishedRevision).toHaveBeenCalledTimes(2));
    expect(applyPublishedRevision).toHaveBeenLastCalledWith(5, { force: true });
  });

  it("keeps local changes when the confirmation is declined", async () => {
    const applyPublishedRevision = vi
      .fn()
      .mockRejectedValueOnce(
        new LocalChangesError(5, ["scripts/hero.gd"]),
      );

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({ applyPublishedRevision })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: /скачать в редактор/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));

    await waitFor(() => expect(applyPublishedRevision).toHaveBeenCalledTimes(1));
  });

  it("asks before removing a package with local changes", async () => {
    const removePackageDirectory = vi
      .fn()
      .mockRejectedValueOnce(new LocalChangesError(5, ["scripts/hero.gd"]))
      .mockResolvedValueOnce(undefined);

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({ removePackageDirectory })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: /убрать из редактора/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Удалить каталог пакета/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));

    await waitFor(() => expect(removePackageDirectory).toHaveBeenCalledTimes(2));
    expect(removePackageDirectory).toHaveBeenLastCalledWith(5, { force: true });
  });

  it("creates a package for the current user", async () => {
    const createPackage = vi
      .fn()
      .mockResolvedValue({ id: 7, name: "New" } as never);

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}canCreatePackages canManagePackages viewerId={42} packages={controller({ createPackage })} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Создать пакет" }),
    );
    fireEvent.change(screen.getByLabelText("Имя пакета"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "new" },
    });

    const submit = screen.getByRole("button", { name: "Создать" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(createPackage).toHaveBeenCalledWith({
        name: "New",
        version: "0.1.0",
        slug: "new",
      }),
    );
  });

  it("allows Emit only for a package loaded into the editor", async () => {
    const emitPackage = vi.fn().mockResolvedValue(undefined);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [
            entry(),
            entry({
              packageId: 6,
              name: "Other",
              status: "not-loaded",
              loaded: false,
              inEditor: false,
            }),
          ],
          emitPackage,
        })}
      />,
    );

    const [loadedEmit, notLoadedEmit] = screen.getAllByRole("button", {
      name: /emit/i,
    });
    expect(notLoadedEmit).toHaveProperty("disabled", true);
    fireEvent.click(loadedEmit);
    await waitFor(() => expect(emitPackage).toHaveBeenCalledWith(5));
  });

  it("adopts a leftover directory so its files can be published", async () => {
    const adoptPackage = vi.fn().mockResolvedValue(undefined);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [
            entry({
              status: "local-changes",
              loaded: false,
              loadedRevision: null,
              localChanges: ["scripts/hero.gd"],
            }),
          ],
          adoptPackage,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /использовать каталог/i }),
    );
    await waitFor(() => expect(adoptPackage).toHaveBeenCalledWith(5));
  });

  it("asks before emitting over a newer published revision", async () => {
    const emitPackage = vi
      .fn()
      .mockRejectedValueOnce(new NewerRevisionError(5, 2, 3))
      .mockResolvedValueOnce(undefined);

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [
            entry({
              status: "new-revision",
              publishedRevision: 3,
              loadedRevision: 2,
            }),
          ],
          emitPackage,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /emit/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ревизия 3/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));

    await waitFor(() => expect(emitPackage).toHaveBeenCalledTimes(2));
    expect(emitPackage).toHaveBeenLastCalledWith(5, { force: true });
  });

  it("shows a disabled badge and hides Emit for a disabled package", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [entry({ enabled: false, status: "disabled" })],
        })}
      />,
    );

    expect(screen.getByText("отключён")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /emit/i })).toBeNull();
    expect(screen.getByText(/Пакет отключён в комнате/)).toBeTruthy();
  });

  it("keeps Emit and Использовать каталог outside the actions menu", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ entries: [entry({ loaded: false, localChanges: ["a.gd"] })] })}
        canCreatePackages canManagePackages viewerId={1}
      />,
    );
    expect(screen.getByRole("button", { name: /emit/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /использовать каталог/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /скачать в редактор/i }),
    ).toBeNull();
  });

  it("confirms permanent deletion in a dialog", async () => {
    const deletePackageRecord = vi.fn().mockResolvedValue(undefined);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [entry({ packageId: 42 })],
          deletePackageRecord,
        })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Удалить из комнаты" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/#demo/)).toBeTruthy();
    expect(deletePackageRecord).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Удалить навсегда" }),
    );

    await waitFor(() => expect(deletePackageRecord).toHaveBeenCalledWith(42));
  });

  it("opens the creation modal from the header button", () => {
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}packages={controller()} canCreatePackages canManagePackages viewerId={42} />);

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));

    expect(screen.getByLabelText("Slug")).toBeTruthy();
    expect(screen.getByLabelText("Версия")).toHaveProperty("value", "0.1.0");
  });

  it("lowercases the typed slug", () => {
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}packages={controller()} canCreatePackages canManagePackages viewerId={42} />);

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    const slugInput = screen.getByLabelText("Slug");
    fireEvent.change(slugInput, { target: { value: "Hero_One" } });

    expect(slugInput).toHaveProperty("value", "hero_one");
  });

  it("shows a taken slug and disables submit", async () => {
    const checkSlugAvailability = vi.fn().mockResolvedValue({
      slug: "hero",
      available: false,
      reason: "taken",
      global: { available: true },
    });

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ checkSlugAvailability })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "hero" },
    });

    await waitFor(() =>
      expect(screen.getByText("Slug уже занят")).toBeTruthy(),
    );
    expect(checkSlugAvailability).toHaveBeenCalledWith("hero", 1);
    expect(screen.getByRole("button", { name: "Создать" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("ignores an availability response for a slug that was changed", async () => {
    const resolvers = new Map<
      string,
      (value: PackageSlugAvailability) => void
    >();
    const checkSlugAvailability = vi.fn(
      (slug: string) =>
        new Promise<PackageSlugAvailability>((resolve) => {
          resolvers.set(slug, resolve);
        }),
    );

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ checkSlugAvailability })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    const slugInput = screen.getByLabelText("Slug");

    fireEvent.change(slugInput, { target: { value: "aaa" } });
    await waitFor(() => expect(resolvers.has("aaa")).toBe(true));

    fireEvent.change(slugInput, { target: { value: "hero" } });
    await waitFor(() => expect(resolvers.has("hero")).toBe(true));

    await act(async () => {
      resolvers.get("hero")?.({
        slug: "hero",
        available: true,
        global: { available: true },
      });
    });
    expect(screen.getByText("Slug свободен")).toBeTruthy();

    await act(async () => {
      resolvers.get("aaa")?.({
        slug: "aaa",
        available: false,
        reason: "taken",
        global: { available: false, reason: "taken" },
      });
    });
    expect(screen.queryByText("Slug уже занят")).toBeNull();
    expect(screen.getByText("Slug свободен")).toBeTruthy();
  });

  it("disables creation while the editor is not ready", async () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ fsReady: false })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Имя пакета"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "new" },
    });

    const submit = screen.getByRole("button", { name: "Создать" });
    await waitFor(() => expect(screen.getByText("Slug свободен")).toBeTruthy());
    expect(submit).toHaveProperty("disabled", true);
  });

  it.each([
    ["a signed-out visitor", null],
    ["a signed-in visitor who is not a member", 42],
  ])(
    "disables creation for %s",
    async (_label, viewerId) => {
      render(
        <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
          roomId={1}
          packages={controller()}
          canManagePackages={false}
          canCreatePackages={false}
          viewerId={viewerId}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
      fireEvent.change(screen.getByLabelText("Имя пакета"), {
        target: { value: "New" },
      });
      fireEvent.change(screen.getByLabelText("Slug"), {
        target: { value: "new" },
      });

      const submit = screen.getByRole("button", { name: "Создать" });
      await waitFor(() =>
        expect(screen.getByText("Slug свободен")).toBeTruthy(),
      );
      expect(submit).toHaveProperty("disabled", true);
    },
  );

  it("shows a creation error inside the modal", async () => {
    const createPackage = vi.fn().mockRejectedValue(new Error("boom"));

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ createPackage })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Имя пакета"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "new" },
    });

    const submit = screen.getByRole("button", { name: "Создать" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(screen.getByText("Не удалось создать пакет")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Slug")).toBeTruthy();
  });

  it("shows a server slug conflict inside the open modal", async () => {
    const createPackage = vi
      .fn()
      .mockRejectedValue(new Error("Slug уже занят"));

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ createPackage })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Имя пакета"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "new" },
    });

    const submit = screen.getByRole("button", { name: "Создать" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(screen.getByText("Не удалось создать пакет")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Slug")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Создать" })).toBeTruthy();
  });

  it("retries a failed slug availability check from the modal", async () => {
    const checkSlugAvailability = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        slug: "hero",
        available: true,
        global: { available: true },
      });

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ checkSlugAvailability })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "hero" },
    });

    await waitFor(() =>
      expect(
        screen.getByText("Не удалось проверить slug. Попробуйте ещё раз"),
      ).toBeTruthy(),
    );
    expect(checkSlugAvailability).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));

    await waitFor(() => expect(screen.getByText("Slug свободен")).toBeTruthy());
    expect(checkSlugAvailability).toHaveBeenCalledTimes(2);
    expect(checkSlugAvailability).toHaveBeenLastCalledWith("hero", 1);
  });

  it("opens from the card menu and saves every field", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockResolvedValue({ id: 7, slug: "hero2" } as never);
    vi.mocked(packagesApi.getScriptingPackage).mockResolvedValue(
      roomPackage({ description: "desc", tags: ["a", "b"] }),
    );

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({
          entries: [
            entry({ packageId: 7, slug: "hero", name: "Hero", version: "1.0" }),
          ],
          updatePackageMetadata,
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Редактировать пакет" }));

    const slugInput = await screen.findByLabelText("Slug");
    await waitFor(() => expect(slugInput).toHaveProperty("value", "hero"));

    fireEvent.change(slugInput, { target: { value: "hero2" } });
    const save = screen.getByRole("button", { name: "Сохранить" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);

    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenCalledWith(7, {
        name: "Hero",
        version: "1.0",
        slug: "hero2",
        description: "desc",
        tags: ["a", "b"],
        previewImage: null,
      }),
    );
  });

  it("adds a suggested tag to the saved metadata", async () => {
    vi.mocked(packagesApi.getScriptingPackage).mockResolvedValue(
      roomPackage({ description: "desc", tags: ["a"] }),
    );
    vi.mocked(packagesApi.listWorkshopTags).mockResolvedValue({
      items: [
        { tag: "gameplay", count: 4 },
        { tag: "a", count: 1 },
      ],
      total: 2,
    });
    const updatePackageMetadata = vi.fn().mockResolvedValue({} as never);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Hero" })],
          updatePackageMetadata,
        })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Редактировать пакет" }));

    const tagsInput = await screen.findByLabelText("Теги");
    await waitFor(() => expect(tagsInput).toHaveProperty("disabled", false));
    fireEvent.focus(tagsInput);
    fireEvent.click(
      await screen.findByRole("option", { name: /gameplay/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ tags: ["a", "gameplay"] }),
      ),
    );
  });

  it("shows dependents and repeats the request with confirmation", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockRejectedValueOnce(
        new SlugRenameDependentsError([{ packageId: 9, name: "Level" }]),
      )
      .mockResolvedValue({} as never);

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Hero" })],
          updatePackageMetadata,
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Редактировать пакет" }));

    const slugInput = await screen.findByLabelText("Slug");
    fireEvent.change(slugInput, { target: { value: "hero2" } });
    const save = screen.getByRole("button", { name: "Сохранить" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);

    expect(await screen.findByText("Level")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Переименовать и обновить ссылки" }),
    );

    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenLastCalledWith(
        7,
        expect.objectContaining({ slug: "hero2", confirmSlugRename: true }),
      ),
    );
  });

  it("offers a retry when only the editor directory rename failed", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockRejectedValueOnce(
        new PackageDirectoryRenameError(7, "hero", "hero2", new Error("io")),
      );
    const renamePackageDir = vi.fn().mockResolvedValue(undefined);

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Hero" })],
          updatePackageMetadata,
          renamePackageDir,
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Редактировать пакет" }));

    const slugInput = await screen.findByLabelText("Slug");
    fireEvent.change(slugInput, { target: { value: "hero2" } });
    const save = screen.getByRole("button", { name: "Сохранить" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);

    fireEvent.click(
      await screen.findByRole("button", { name: "Повторить переименование папки" }),
    );

    expect(renamePackageDir).toHaveBeenCalledWith(7, "hero", "hero2");
  });

  it("keeps the dialog open when the tag draft is invalid", async () => {
    vi.mocked(packagesApi.getScriptingPackage).mockResolvedValue(
      roomPackage({ description: "desc", tags: ["a"] }),
    );
    const updatePackageMetadata = vi.fn().mockResolvedValue({} as never);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        canCreatePackages canManagePackages viewerId={42}
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Hero" })],
          updatePackageMetadata,
        })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Редактировать пакет" }));

    const tagsInput = await screen.findByLabelText("Теги");
    await waitFor(() => expect(tagsInput).toHaveProperty("disabled", false));
    fireEvent.change(tagsInput, { target: { value: "Привет!" } });
    const save = screen.getByRole("button", { name: "Сохранить" });
    fireEvent.click(save);

    await waitFor(() => expect(save).toHaveProperty("disabled", true));
    expect(
      screen.getByText("Латиница, цифры, _ и -, до 32 символов."),
    ).toBeTruthy();
    expect(updatePackageMetadata).not.toHaveBeenCalled();
  });

  it("shows the card metadata read-only", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({
          entries: [
            entry({
              packageId: 7,
              slug: "hero",
              name: "Demo",
              description: "desc",
              tags: ["a", "b"],
            }),
          ],
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Редактировать имя/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Редактировать версию/ })).toBeNull();
    expect(screen.getByText("desc")).toBeTruthy();
    expect(screen.getByText("a, b")).toBeTruthy();
    expect(screen.getByText("#hero")).toBeTruthy();
  });

  it("hints that a workshop slug is taken without blocking creation", async () => {
    const checkSlugAvailability = vi.fn().mockResolvedValue({
      slug: "hero",
      available: true,
      global: { available: false, reason: "taken" },
    });

    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({ checkSlugAvailability })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Имя пакета"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "hero" },
    });

    expect(
      await screen.findByText(/при публикации будет предложен fork/i),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("renders the slug instead of the numeric id", () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1}
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero" })],
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    expect(screen.getByText("#hero")).toBeTruthy();
    expect(screen.queryByText("#7")).toBeNull();
  });

  it("opens the workshop browser in a dialog", async () => {
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
      items: [workshopPackage()],
      total: 1,
    });
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1} packages={controller()} canCreatePackages canManagePackages viewerId={42} />);

    fireEvent.click(screen.getByRole("button", { name: "Workshop" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Пакеты сообщества. Добавление создаст копию в этой комнате.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Поиск пакетов")).toBeTruthy();
    expect(
      await within(dialog).findByRole("button", { name: "Добавить" }),
    ).toBeTruthy();
  });

  it("adds a workshop package into the room", async () => {
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
      items: [workshopPackage()],
      total: 1,
    });
    const copyFromWorkshop = vi.fn().mockResolvedValue({ id: 9 } as never);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ copyFromWorkshop })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workshop" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Добавить" }),
    );

    await waitFor(() => expect(copyFromWorkshop).toHaveBeenCalledWith(100));
  });

  it("disables publishing a package without a published revision", async () => {
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({
          entries: [entry({ publishedRevision: null })],
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    const item = menu.getByRole("menuitem", {
      name: /опубликовать в workshop/i,
    });
    expect(item.getAttribute("data-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe(
      "Сначала опубликуйте пакет через Emit",
    );

    fireEvent.click(item);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("publishes without editing metadata", async () => {
    const publishToWorkshop = vi
      .fn()
      .mockResolvedValue({ mode: "created", package: workshopPackage() });
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ publishToWorkshop })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        "Будет создана новая запись в workshop",
      ),
    ).toBeTruthy();
    // Metadata lives in the package edit dialog, so the preview has no inputs.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByText("Demo")).toBeTruthy();
    expect(within(dialog).getByText("0.1.0")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Опубликовать" }));

    await waitFor(() => expect(publishToWorkshop).toHaveBeenCalledWith(5));
  });

  it("shows a mapped workshop dependency error in the publish dialog", async () => {
    const publishToWorkshop = vi.fn().mockRejectedValue(
      new WorkshopActionError(
        {
          key: "Packages.errors.dependencyNotGlobal",
          values: { slug: "hero" },
        },
        "workshop_publish_failed:package_dependency_not_global:#hero",
      ),
    );
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ publishToWorkshop })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Опубликовать" }));

    expect(
      await within(dialog).findByText(
        "Пакет зависит от пакета комнаты #hero: его нельзя опубликовать в workshop без форка зависимости",
      ),
    ).toBeTruthy();
  });

  it("shows the room package description and tags in the preview", async () => {
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1} packages={controller()} canCreatePackages canManagePackages viewerId={42} />);

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Описание из комнаты"),
    ).toBeTruthy();
    expect(within(dialog).getByText("room, demo")).toBeTruthy();
    expect(packagesApi.getScriptingPackage).toHaveBeenCalledWith(5);
  });

  it("fills the preview when the room package details arrive", async () => {
    let resolveRoomPackage!: (value: ScriptingPackage) => void;
    vi.mocked(packagesApi.getScriptingPackage).mockReturnValue(
      new Promise<ScriptingPackage>((resolve) => {
        resolveRoomPackage = resolve;
      }),
    );
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1} packages={controller()} canCreatePackages canManagePackages viewerId={42} />);

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Будет создана новая запись в workshop");
    expect(within(dialog).queryByText("Описание из комнаты")).toBeNull();

    await act(async () => {
      resolveRoomPackage(roomPackage());
    });

    expect(within(dialog).getByText("Описание из комнаты")).toBeTruthy();
  });

  it("disables publishing until a failed workshop lookup is retried", async () => {
    vi.mocked(packagesApi.lookupWorkshopPackage).mockRejectedValue(
      new Error("network down"),
    );
    render(<PackagesTab onRoomSaved={vi.fn()} room={roomFixture()} roomId={1} packages={controller()} canCreatePackages canManagePackages viewerId={42} />);

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        /Не удалось проверить запись в workshop/,
      ),
    ).toBeTruthy();
    const submit = within(dialog).getByRole("button", {
      name: "Опубликовать",
    });
    expect(submit).toHaveProperty("disabled", true);

    vi.mocked(packagesApi.lookupWorkshopPackage).mockResolvedValue(null);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Проверить снова" }),
    );
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  });

  it("publishes an existing record without changing its metadata", async () => {
    vi.mocked(packagesApi.lookupWorkshopPackage).mockResolvedValue(
      workshopPackage({
        name: "Workshop Demo",
        version: "1.0.0",
        description: "Старое описание",
        tags: ["old", "tags"],
      }),
    );
    const publishToWorkshop = vi
      .fn()
      .mockResolvedValue({ mode: "updated", package: workshopPackage() });
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ publishToWorkshop })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Публикация обновится");

    fireEvent.click(within(dialog).getByRole("button", { name: "Опубликовать" }));

    await waitFor(() => expect(publishToWorkshop).toHaveBeenCalledWith(5));
  });

  it("offers a fork when the workshop slug belongs to another author", async () => {
    vi.mocked(packagesApi.lookupWorkshopPackage).mockResolvedValue(
      workshopPackage({
        author: {
          id: 7,
          name: "Чужой автор",
          picture: "",
        },
      }),
    );
    const publishToWorkshop = vi.fn();
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ publishToWorkshop })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Slug занят: Чужой автор"),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Опубликовать" }),
    ).toBeNull();
    expect(publishToWorkshop).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Создать fork" }));

    // The fork form replaces the publication form.
    expect(await screen.findByLabelText("Новый slug")).toBeTruthy();
    expect(
      screen.getByText(/Создастся копия пакета/),
    ).toBeTruthy();
  });

  it("switches to the fork form when the server reports a taken slug", async () => {
    const publishToWorkshop = vi
      .fn()
      .mockRejectedValue(
        new WorkshopSlugTakenError(
          "demo",
          workshopPackage({
            author: {
              id: 7,
              name: "Чужой автор",
              picture: "",
            },
          }),
        ),
      );
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ publishToWorkshop })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Опубликовать" }),
    );

    expect(
      await within(dialog).findByText("Slug занят: Чужой автор"),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Создать fork" })).toBeTruthy();
  });

  it("forks a package with a new free slug", async () => {
    vi.mocked(packagesApi.lookupWorkshopPackage).mockResolvedValue(
      workshopPackage({
        author: {
          id: 7,
          name: "Чужой автор",
          picture: "",
        },
      }),
    );
    const checkSlugAvailability = vi.fn().mockResolvedValue({
      slug: "hero_two",
      available: true,
      global: { available: true },
    });
    const forkWorkshopPackage = vi.fn().mockResolvedValue({ id: 11 } as never);
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({
          checkSlugAvailability,
          forkWorkshopPackage,
        })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Создать fork" }),
    );

    const slugInput = await screen.findByLabelText("Новый slug");
    fireEvent.change(slugInput, { target: { value: "Hero_Two" } });
    expect(slugInput).toHaveProperty("value", "hero_two");

    await waitFor(() =>
      expect(screen.getByText("Slug свободен")).toBeTruthy(),
    );
    expect(checkSlugAvailability).toHaveBeenCalledWith("hero_two", 1);

    const submit = screen.getByRole("button", { name: "Создать fork" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(forkWorkshopPackage).toHaveBeenCalledWith(5, "hero_two"),
    );
  });

  it("keeps the fork disabled when the slug is taken in the workshop", async () => {
    vi.mocked(packagesApi.lookupWorkshopPackage).mockResolvedValue(
      workshopPackage({
        author: {
          id: 7,
          name: "Чужой автор",
          picture: "",
        },
      }),
    );
    const checkSlugAvailability = vi.fn().mockResolvedValue({
      slug: "hero_two",
      available: true,
      global: { available: false, reason: "taken" },
    });
    render(
      <PackagesTab onRoomSaved={vi.fn()} room={roomFixture()}
        roomId={1}
        packages={controller({ checkSlugAvailability })}
        canCreatePackages canManagePackages viewerId={42}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(
      menu.getByRole("menuitem", { name: /опубликовать в workshop/i }),
    );
    const publishDialog = await screen.findByRole("dialog");
    // The record belongs to another author, so the primary action is the fork.
    fireEvent.click(
      await within(publishDialog).findByRole("button", {
        name: "Создать fork",
      }),
    );

    fireEvent.change(await screen.findByLabelText("Новый slug"), {
      target: { value: "hero_two" },
    });

    await waitFor(() =>
      expect(screen.getByText("Slug уже занят")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Создать fork" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
