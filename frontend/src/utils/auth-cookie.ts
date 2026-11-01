/**
 * Name of the cookie that carries the backend access token. The backend reads
 * the same name (`AUTH_COOKIE_NAME`), so changing it requires an env change on
 * both sides.
 */
export const AUTH_COOKIE_NAME = "access_token";

/**
 * Reads the access token from `document.cookie`.
 *
 * Browser only: returns null during server rendering or when the cookie is
 * absent. The cookie is not httpOnly because the browser client and the Godot
 * game bridge have to copy it into an `Authorization` header.
 */
export function readAccessToken(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${AUTH_COOKIE_NAME}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}
