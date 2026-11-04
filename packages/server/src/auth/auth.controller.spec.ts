import { HttpStatus } from '@nestjs/common';
import { AuthController } from './auth.controller';

/** Where `@HttpCode()` keeps its status for the route handler. */
const HTTP_CODE_METADATA = '__httpCode__';

describe('AuthController', () => {
  describe('register', () => {
    it('creates the account and returns the token of the new user', async () => {
      const usersService = { create: jest.fn(async () => ({ id: 4 })) };
      const authService = {
        login: jest.fn(async () => ({ access_token: 'token' })),
      };
      const controller = new AuthController(
        authService as never,
        usersService as never,
        {} as never,
      );

      const dto = {
        email: 'ann@wired.io',
        password: 'secret1',
        name: 'Ann',
        picture: 'p',
      };
      await expect(controller.register(dto)).resolves.toEqual({
        access_token: 'token',
      });
      expect(usersService.create).toHaveBeenCalledWith(dto);
      expect(authService.login).toHaveBeenCalledWith('ann@wired.io', 'secret1');
    });
  });

  describe('login', () => {
    it('writes the token into the cookie and returns it', async () => {
      const authService = {
        login: jest.fn(async () => ({ access_token: 'token' })),
        writeCookie: jest.fn(),
      };
      const controller = new AuthController(
        authService as never,
        {} as never,
        {} as never,
      );
      const res = {};

      await expect(
        controller.login(res as never, {
          email: 'ann@wired.io',
          password: 'secret1',
        }),
      ).resolves.toEqual({ access_token: 'token' });
      expect(authService.writeCookie).toHaveBeenCalledWith(res, {
        access_token: 'token',
      });
    });
  });

  describe('googleCallback', () => {
    it('signs the Google profile in without a password and returns home', async () => {
      const token = { access_token: 'google-token' };
      const authService = {
        forceLogin: jest.fn(async () => token),
        writeCookie: jest.fn(),
      };
      const controller = new AuthController(
        authService as never,
        {} as never,
        { site: { host: 'https://wired.test' } } as never,
      );
      const res = { redirect: jest.fn() };
      const req = {
        user: {
          provider: 'google' as const,
          providerId: '1234',
          email: 'ann@wired.io',
          name: 'Ann Smith',
          picture: 'p',
        },
      };

      await controller.googleCallback(req as never, res as never);

      expect(authService.forceLogin).toHaveBeenCalledWith(
        'ann@wired.io',
        'Ann Smith',
        'p',
        '',
      );
      expect(authService.writeCookie).toHaveBeenCalledWith(res, token);
      expect(res.redirect).toHaveBeenCalledWith('https://wired.test');
    });
  });

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
