import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider } from "@/test/render-with-intl";
import { useRequestHandler } from "./use-request-handler";

const wrapper = ({ children }: { children: ReactNode }) => (
  <IntlProvider locale="en">{children}</IntlProvider>
);

describe("useRequestHandler", () => {
  it("stores a status-mapped AppMessage for an API failure", async () => {
    const { result } = renderHook(
      () => useRequestHandler({ toastOnError: false }),
      { wrapper },
    );

    await act(async () => {
      const ok = await result.current.handleRequest(async () => {
        throw { isAxiosError: true, response: { status: 403 } };
      });
      expect(ok).toBe(false);
    });

    expect(result.current.error).toEqual({ key: "Errors.forbidden" });
  });

  it("uses the caller's specific error message", async () => {
    const { result } = renderHook(
      () => useRequestHandler({ toastOnError: false }),
      { wrapper },
    );

    await act(async () => {
      await result.current.handleRequest(
        async () => {
          throw new Error("Forbidden");
        },
        { errorMessage: { key: "Rooms.errors.create" } },
      );
    });

    expect(result.current.error).toEqual({ key: "Rooms.errors.create" });
  });
});
