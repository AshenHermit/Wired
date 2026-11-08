import { RoomsController } from './rooms.controller';
import { UpdateRoomAccessDto } from './dto/update-room-access.dto';
import { AUTH_POLICY_KEY } from 'src/auth/auth-policy';

describe('RoomsController', () => {
  describe('updateAccess', () => {
    it('marks updateAccess with @UseAuthGuard() so anonymous callers get 401', () => {
      // The real 401 for an unauthenticated request is produced by
      // @UseAuthGuard() before the handler runs, which a unit test cannot
      // exercise. Pin the contract instead: the decorator writes the
      // `required` policy that drives the guard's rejection.
      expect(
        Reflect.getMetadata(
          AUTH_POLICY_KEY,
          RoomsController.prototype.updateAccess,
        ),
      ).toBe('required');
    });

    it('calls assertRoomAccessEditing to enforce authorization', async () => {
      const roomsService = {
        assertRoomAccessEditing: jest.fn(),
        updateAccess: jest.fn(() =>
          Promise.resolve({
            id: 1,
            packageManagementAccess: 'users',
            packageManagementUserIds: [5],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
      };

      const controller = new RoomsController(roomsService as never, { dropSelfState: jest.fn() } as never);
      const user = { id: 10 };
      const req = { user } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementAccess: 'users',
        packageManagementUserIds: [5],
      };

      await controller.updateAccess(1, dto, req);

      expect(roomsService.assertRoomAccessEditing).toHaveBeenCalledWith(
        user,
        1,
      );
    });

    it('calls updateAccess service method with room id, dto, and user', async () => {
      const roomsService = {
        assertRoomAccessEditing: jest.fn(),
        updateAccess: jest.fn(() =>
          Promise.resolve({
            id: 1,
            packageManagementAccess: 'users',
            packageManagementUserIds: [5],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
      };

      const controller = new RoomsController(roomsService as never, { dropSelfState: jest.fn() } as never);
      const user = { id: 10 };
      const req = { user } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementAccess: 'users',
        packageManagementUserIds: [5],
      };

      await controller.updateAccess(1, dto, req);

      expect(roomsService.updateAccess).toHaveBeenCalledWith(1, dto, user);
    });
  });
});
