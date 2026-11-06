import axios, { AxiosError, AxiosResponse } from "axios";
import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "./api-client";

const client = new ApiClient(axios.create());

/** An axios failure shaped like the ones the axios instance produces. */
function axiosFailure(status: number, data: unknown): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_RESPONSE",
    undefined,
    undefined,
    { status, data } as AxiosResponse,
  );
}

describe("ApiClient.processResponse", () => {
  it("resolves with the response body", async () => {
    const body = { id: 1 };
    await expect(
      client.processResponse(Promise.resolve({ data: body } as AxiosResponse)),
    ).resolves.toBe(body);
  });

  it("keeps the response so callers can read the status and the code", async () => {
    // `packages_pending` is a wait, not a failure, so the caller has to be able
    // to tell a 409 apart from a 500.
    const error = await client
      .processResponse<never>(
        Promise.reject(axiosFailure(409, { code: "packages_pending" })),
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).response?.status).toBe(409);
    expect((error as ApiError).response?.data).toMatchObject({
      code: "packages_pending",
    });
  });

  it("uses the message the server sent", async () => {
    await expect(
      client.processResponse(
        Promise.reject(axiosFailure(400, { message: "slug is taken" })),
      ),
    ).rejects.toThrow("slug is taken");
  });

  it("joins a validation message list", async () => {
    await expect(
      client.processResponse(
        Promise.reject(
          axiosFailure(400, { message: ["name too short", "slug invalid"] }),
        ),
      ),
    ).rejects.toThrow("name too short; slug invalid");
  });

  it("falls back to axios's own message when the body carries none", async () => {
    await expect(
      client.processResponse(Promise.reject(axiosFailure(500, {}))),
    ).rejects.toThrow("Request failed with status code 500");
  });

  it("wraps a non-axios failure instead of leaking it", async () => {
    const error = await client
      .processResponse<never>(Promise.reject(new Error("boom")))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("boom");
  });

  it("describes a rejection that is not an Error at all", async () => {
    await expect(
      client.processResponse(Promise.reject("nope")),
    ).rejects.toThrow("Request failed");
  });
});
