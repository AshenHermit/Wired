import { AuthController } from './auth.controller';

describe('AuthController', () => {
  describe('logout', () => {
    it('clears the cookie and lets Nest send the response', () => {
      const authService = { clearCookie: jest.fn() };
      const controller = new AuthController(
        authService as never,
        {} as never,
        {} as never,
      );
      const res = { json: jest.fn(() => 'sent') };

      const result = controller.logout(res as never);

      expect(authService.clearCookie).toHaveBeenCalledWith(res);
      expect(res.json).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });
});
