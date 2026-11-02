import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackageSlugAvailability } from "@/api/services/scripting-packages";
import type {
  RoomPackageEntry,
  RoomPackagesController,
} from "./use-room-packages";
import { LocalChangesError, NewerRevisionError } from "./use-room-packages";
import { PackagesTab } from "./PackagesTab";

function entry(overrides: Partial<RoomPackageEntry> = {}): RoomPackageEntry {
  return {
    packageId: 5,
    slug: "demo",
    name: "Demo",
    version: "0.1.0",
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
      .mockResolvedValue({ slug: "new", available: true }),
    updatePackageMetadata: vi.fn().mockResolvedValue({} as never),
    downloadPackage: vi.fn().mockResolvedValue(undefined),
    removePackage: vi.fn().mockResolvedValue(undefined),
    setPackageEnabled: vi.fn().mockResolvedValue(undefined),
    deletePackage: vi.fn().mockResolvedValue(undefined),
    adoptPackage: vi.fn().mockResolvedValue(undefined),
    emitPackage: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

async function openPackageActions() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Действия с пакетом" }),
    { button: 0 },
  );
  const menu = await screen.findByRole("menu");
  return within(menu);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PackagesTab", () => {
  it("lists all room packages with their editor and backend states", () => {
    render(
      <PackagesTab
        authorId={42}
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

  it("explains that Godot needs a project reload to see written files", () => {
    render(<PackagesTab authorId={42} packages={controller()} />);

    expect(
      screen.getByText(/Project → Reload Current Project/),
    ).toBeTruthy();
  });

  it("asks before replacing local changes and repeats the download", async () => {
    const downloadPackage = vi
      .fn()
      .mockRejectedValueOnce(
        new LocalChangesError(5, ["scripts/hero.gd"]),
      )
      .mockResolvedValueOnce(undefined);

    render(
      <PackagesTab
        authorId={42}
        packages={controller({ downloadPackage })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: /скачать в редактор/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/локальные изменения/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));

    await waitFor(() => expect(downloadPackage).toHaveBeenCalledTimes(2));
    expect(downloadPackage).toHaveBeenLastCalledWith(5, { force: true });
  });

  it("keeps local changes when the confirmation is declined", async () => {
    const downloadPackage = vi
      .fn()
      .mockRejectedValueOnce(
        new LocalChangesError(5, ["scripts/hero.gd"]),
      );

    render(
      <PackagesTab
        authorId={42}
        packages={controller({ downloadPackage })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: /скачать в редактор/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));

    await waitFor(() => expect(downloadPackage).toHaveBeenCalledTimes(1));
  });

  it("asks before removing a package with local changes", async () => {
    const removePackage = vi
      .fn()
      .mockRejectedValueOnce(new LocalChangesError(5, ["scripts/hero.gd"]))
      .mockResolvedValueOnce(undefined);

    render(
      <PackagesTab
        authorId={42}
        packages={controller({ removePackage })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: /убрать из редактора/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Удалить каталог пакета/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));

    await waitFor(() => expect(removePackage).toHaveBeenCalledTimes(2));
    expect(removePackage).toHaveBeenLastCalledWith(5, { force: true });
  });

  it("creates a package for the current user", async () => {
    const createPackage = vi
      .fn()
      .mockResolvedValue({ id: 7, name: "New" } as never);

    render(
      <PackagesTab authorId={42} packages={controller({ createPackage })} />,
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
      expect(createPackage).toHaveBeenCalledWith(
        "New",
        42,
        "0.1.0",
        "new",
      ),
    );
  });

  it("allows Emit only for a package loaded into the editor", async () => {
    const emitPackage = vi.fn().mockResolvedValue(undefined);
    render(
      <PackagesTab
        authorId={42}
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
      <PackagesTab
        authorId={42}
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
      <PackagesTab
        authorId={42}
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
      <PackagesTab
        authorId={42}
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
      <PackagesTab
        packages={controller({ entries: [entry({ loaded: false, localChanges: ["a.gd"] })] })}
        authorId={1}
      />,
    );
    expect(screen.getByRole("button", { name: /emit/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /использовать каталог/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /скачать в редактор/i }),
    ).toBeNull();
  });

  it("confirms permanent deletion in a dialog", async () => {
    const deletePackage = vi.fn().mockResolvedValue(undefined);
    render(
      <PackagesTab
        authorId={42}
        packages={controller({
          entries: [entry({ packageId: 42 })],
          deletePackage,
        })}
      />,
    );

    const menu = await openPackageActions();
    fireEvent.click(menu.getByRole("menuitem", { name: "Удалить из комнаты" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/#demo/)).toBeTruthy();
    expect(deletePackage).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Удалить навсегда" }),
    );

    await waitFor(() => expect(deletePackage).toHaveBeenCalledWith(42));
  });

  it("opens the creation modal from the header button", () => {
    render(<PackagesTab packages={controller()} authorId={42} />);

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));

    expect(screen.getByLabelText("Slug")).toBeTruthy();
    expect(screen.getByLabelText("Версия")).toHaveProperty("value", "0.1.0");
  });

  it("lowercases the typed slug", () => {
    render(<PackagesTab packages={controller()} authorId={42} />);

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
    });

    render(
      <PackagesTab
        packages={controller({ checkSlugAvailability })}
        authorId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "hero" },
    });

    await waitFor(() =>
      expect(screen.getByText("Slug уже занят")).toBeTruthy(),
    );
    expect(checkSlugAvailability).toHaveBeenCalledWith("hero");
    expect(screen.getByRole("button", { name: "Создать" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("explains that a retired slug cannot be reused", async () => {
    const checkSlugAvailability = vi.fn().mockResolvedValue({
      slug: "hero",
      available: false,
      reason: "retired",
    });

    render(
      <PackagesTab
        packages={controller({ checkSlugAvailability })}
        authorId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "hero" },
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "Этот slug был удалён и не может быть использован снова",
        ),
      ).toBeTruthy(),
    );
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
      <PackagesTab
        packages={controller({ checkSlugAvailability })}
        authorId={42}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать пакет" }));
    const slugInput = screen.getByLabelText("Slug");

    fireEvent.change(slugInput, { target: { value: "aaa" } });
    await waitFor(() => expect(resolvers.has("aaa")).toBe(true));

    fireEvent.change(slugInput, { target: { value: "hero" } });
    await waitFor(() => expect(resolvers.has("hero")).toBe(true));

    await act(async () => {
      resolvers.get("hero")?.({ slug: "hero", available: true });
    });
    expect(screen.getByText("Slug свободен")).toBeTruthy();

    await act(async () => {
      resolvers.get("aaa")?.({ slug: "aaa", available: false, reason: "taken" });
    });
    expect(screen.queryByText("Slug уже занят")).toBeNull();
    expect(screen.getByText("Slug свободен")).toBeTruthy();
  });

  it("disables creation while the editor is not ready", async () => {
    render(
      <PackagesTab
        packages={controller({ fsReady: false })}
        authorId={42}
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

  it("disables creation without an author", async () => {
    render(<PackagesTab packages={controller()} authorId={null} />);

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

  it("shows a creation error inside the modal", async () => {
    const createPackage = vi.fn().mockRejectedValue(new Error("boom"));

    render(
      <PackagesTab
        packages={controller({ createPackage })}
        authorId={42}
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

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    expect(screen.getByLabelText("Slug")).toBeTruthy();
  });

  it("saves an edited package name", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockResolvedValue({ id: 7, slug: "hero", name: "Renamed" } as never);

    render(
      <PackagesTab
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Demo" })],
          updatePackageMetadata,
        })}
        authorId={42}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать имя пакета" }),
    );
    const input = screen.getByLabelText("Имя пакета");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenCalledWith(7, {
        name: "Renamed",
      }),
    );
  });

  it("saves an edited package version", async () => {
    const updatePackageMetadata = vi
      .fn()
      .mockResolvedValue({ id: 7, slug: "hero", version: "1.2.3" } as never);

    render(
      <PackagesTab
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero" })],
          updatePackageMetadata,
        })}
        authorId={42}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать версию" }),
    );
    const input = screen.getByLabelText("Версия");
    fireEvent.change(input, { target: { value: "1.2.3" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(updatePackageMetadata).toHaveBeenCalledWith(7, {
        version: "1.2.3",
      }),
    );
  });

  it("cancels inline editing with Escape", () => {
    const updatePackageMetadata = vi.fn().mockResolvedValue({} as never);

    render(
      <PackagesTab
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Demo" })],
          updatePackageMetadata,
        })}
        authorId={42}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать имя пакета" }),
    );
    const input = screen.getByLabelText("Имя пакета");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("Имя пакета")).toBeNull();
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(updatePackageMetadata).not.toHaveBeenCalled();
  });

  it("does not submit an empty package name", () => {
    const updatePackageMetadata = vi.fn().mockResolvedValue({} as never);

    render(
      <PackagesTab
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero", name: "Demo" })],
          updatePackageMetadata,
        })}
        authorId={42}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать имя пакета" }),
    );
    const input = screen.getByLabelText("Имя пакета");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(updatePackageMetadata).not.toHaveBeenCalled();
    expect(
      screen.getByText("Имя пакета не может быть пустым"),
    ).toBeTruthy();
  });

  it("does not submit an empty package version", () => {
    const updatePackageMetadata = vi.fn().mockResolvedValue({} as never);

    render(
      <PackagesTab
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero" })],
          updatePackageMetadata,
        })}
        authorId={42}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Редактировать версию" }),
    );
    const input = screen.getByLabelText("Версия");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(updatePackageMetadata).not.toHaveBeenCalled();
    expect(screen.getByText("Версия не может быть пустой")).toBeTruthy();
  });

  it("renders the slug instead of the numeric id", () => {
    render(
      <PackagesTab
        packages={controller({
          entries: [entry({ packageId: 7, slug: "hero" })],
        })}
        authorId={42}
      />,
    );

    expect(screen.getByText("#hero")).toBeTruthy();
    expect(screen.queryByText("#7")).toBeNull();
  });
});
