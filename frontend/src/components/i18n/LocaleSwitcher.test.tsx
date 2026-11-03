import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/render-with-intl";
import { LocaleSwitcher } from "./LocaleSwitcher";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

describe("LocaleSwitcher", () => {
  beforeEach(() => {
    refresh.mockClear();
    document.cookie = "NEXT_LOCALE=; path=/; max-age=0";
  });

  it("writes the locale cookie and refreshes the route", async () => {
    renderWithIntl(<LocaleSwitcher />, { locale: "en" });

    fireEvent.click(screen.getByRole("button", { name: "Русский" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(document.cookie).toContain("NEXT_LOCALE=ru");
  });

  it("leaves the current locale untouched", () => {
    renderWithIntl(<LocaleSwitcher />, { locale: "en" });

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(refresh).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("NEXT_LOCALE=ru");
  });
});
