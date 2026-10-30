import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RoomPackageEntry,
  RoomPackagesController,
} from "./use-room-packages";
import { LocalChangesError, NewerRevisionError } from "./use-room-packages";
import { PackagesTab } from "./PackagesTab";

function entry(overrides: Partial<RoomPackageEntry> = {}): RoomPackageEntry {
  return {
    packageId: 5,
    name: "Demo",
    version: "0.1.0",
    status: "loaded",
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
    beforeEditorStart: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    createPackage: vi.fn().mockResolvedValue({ id: 7, name: "New" }),
    downloadPackage: vi.fn().mockResolvedValue(undefined),
    removePackage: vi.fn().mockResolvedValue(undefined),
    adoptPackage: vi.fn().mockResolvedValue(undefined),
    emitPackage: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
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
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <PackagesTab
        authorId={42}
        packages={controller({ downloadPackage })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /скачать в редактор/i }),
    );

    await waitFor(() => expect(downloadPackage).toHaveBeenCalledTimes(2));
    expect(downloadPackage).toHaveBeenLastCalledWith(5, { force: true });
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("локальные изменения"),
    );
  });

  it("keeps local changes when the confirmation is declined", async () => {
    const downloadPackage = vi
      .fn()
      .mockRejectedValueOnce(
        new LocalChangesError(5, ["scripts/hero.gd"]),
      );
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <PackagesTab
        authorId={42}
        packages={controller({ downloadPackage })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /скачать в редактор/i }),
    );

    await waitFor(() => expect(downloadPackage).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalled();
  });

  it("creates a package for the current user", async () => {
    const createPackage = vi
      .fn()
      .mockResolvedValue({ id: 7, name: "New" } as never);

    render(
      <PackagesTab authorId={42} packages={controller({ createPackage })} />,
    );

    fireEvent.change(screen.getByLabelText(/имя пакета/i), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: /создать пакет/i }));

    await waitFor(() =>
      expect(createPackage).toHaveBeenCalledWith("New", 42, "0.1.0"),
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
    vi.spyOn(window, "confirm").mockReturnValue(true);

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

    await waitFor(() => expect(emitPackage).toHaveBeenCalledTimes(2));
    expect(emitPackage).toHaveBeenLastCalledWith(5, { force: true });
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("ревизия 3"),
    );
  });
});
