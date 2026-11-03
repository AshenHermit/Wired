import { HttpStatus } from '@nestjs/common';
import { AuthController } from './auth.controller';

/** Where `@HttpCode()` keeps its status for the route handler. */
const HTTP_CODE_METADATA = '__httpCode__';

describe('AuthController', () => {
  describe('logout', () => {
    it('clears the cookie and writes no body', () => {
      const authService = { clearCookie: jest.fn() };
      const controller = new AuthController(
        authService as never,
        {} as never,
        {} as never,
      );
      const res = { json: jest.fn() };

      const result = controller.logout(res as never);

      expect(authService.clearCookie).toHaveBeenCalledWith(res);
      expect(res.json).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('answers 204 like the other deletes', () => {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.logout),
      ).toBe(HttpStatus.NO_CONTENT);
    });
  });
});
