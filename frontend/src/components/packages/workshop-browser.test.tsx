import type { WorkshopPackageSummary } from "@wired-io/shared";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl as render } from "@/test/render-with-intl";

vi.mock("@/api/services/scripting-packages", () => ({
  listWorkshopPackages: vi.fn(),
}));

import * as packagesApi from "@/api/services/scripting-packages";
import { WorkshopBrowser } from "./workshop-browser";

function workshopPackage(
  overrides: Partial<WorkshopPackageSummary> = {},
): WorkshopPackageSummary {
  return {
    id: 5,
    slug: "hero",
    name: "Hero",
    version: "1.2.0",
    description: "Пакет с героем для платформера",
    tags: ["gameplay", "platformer"],
    author: {
      id: 42,
      name: "Аня",
      email: "anya@example.com",
      picture: "",
      service: "google",
    },
    revision: 3,
    publishedAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(packagesApi.listWorkshopPackages).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkshopBrowser", () => {
  it("renders workshop packages and the author", async () => {
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
      items: [workshopPackage()],
      total: 1,
    });

    render(<WorkshopBrowser />);

    expect(await screen.findByText("Hero")).toBeTruthy();
    expect(screen.getByText("#hero")).toBeTruthy();
    expect(screen.getByText("Аня")).toBeTruthy();
    expect(screen.getByText("1.2.0", { exact: false })).toBeTruthy();
    expect(screen.getByText("ревизия 3")).toBeTruthy();
    expect(screen.getByText("gameplay")).toBeTruthy();
  });

  it("debounces the search and sends the query", async () => {
    vi.useFakeTimers();
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
      items: [],
      total: 0,
    });

    render(<WorkshopBrowser />);

    const search = screen.getByLabelText("Поиск пакетов");
    fireEvent.change(search, { target: { value: "he" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(search, { target: { value: "hero" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(
      vi.mocked(packagesApi.listWorkshopPackages),
    ).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(packagesApi.listWorkshopPackages),
    ).toHaveBeenCalledWith({ q: "hero", limit: 50, offset: 0 });
  });

  it("calls onSelect with the chosen package", async () => {
    const onSelect = vi.fn();
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
      items: [workshopPackage()],
      total: 1,
    });

    render(<WorkshopBrowser onSelect={onSelect} />);

    fireEvent.click(await screen.findByRole("button", { name: "Добавить" }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5, slug: "hero" }),
    );
  });

  it("renders the empty state in English", async () => {
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValue({
      items: [],
      total: 0,
    });

    render(<WorkshopBrowser />, { locale: "en" });

    expect(
      await screen.findByText("No packages in the workshop yet"),
    ).toBeTruthy();
  });

  it("shows the empty and error states", async () => {
    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValueOnce({
      items: [],
      total: 0,
    });

    const first = render(<WorkshopBrowser />);
    expect(
      await screen.findByText("В workshop пока нет пакетов"),
    ).toBeTruthy();
    first.unmount();

    vi.mocked(packagesApi.listWorkshopPackages).mockRejectedValueOnce(
      new Error("Сервер недоступен"),
    );
    render(<WorkshopBrowser />);

    expect(await screen.findByText("Сервер недоступен")).toBeTruthy();

    vi.mocked(packagesApi.listWorkshopPackages).mockResolvedValueOnce({
      items: [],
      total: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(
      await screen.findByText("В workshop пока нет пакетов"),
    ).toBeTruthy();
    expect(
      vi.mocked(packagesApi.listWorkshopPackages),
    ).toHaveBeenCalledTimes(3);
  });
});
