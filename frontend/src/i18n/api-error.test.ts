import { describe, expect, it } from "vitest";
import { toAppMessage } from "./api-error";

const axiosError = (status: number) => ({
  isAxiosError: true,
  response: { status },
  message: "Request failed",
});

describe("toAppMessage", () => {
  it("maps common HTTP statuses", () => {
    expect(toAppMessage(axiosError(401)).key).toBe("Errors.unauthorized");
    expect(toAppMessage(axiosError(403)).key).toBe("Errors.forbidden");
    expect(toAppMessage(axiosError(404)).key).toBe("Errors.notFound");
    expect(toAppMessage(axiosError(409)).key).toBe("Errors.conflict");
    expect(toAppMessage(axiosError(500)).key).toBe("Errors.server");
  });

  it("falls back for network errors, unknown throws, and unknown statuses", () => {
    expect(toAppMessage(new Error("Network Error")).key).toBe(
      "Errors.unexpected",
    );
    expect(toAppMessage(undefined).key).toBe("Errors.unexpected");
    expect(toAppMessage(axiosError(418)).key).toBe("Errors.unexpected");
  });
});
