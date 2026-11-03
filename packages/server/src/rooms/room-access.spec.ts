import { canEditRoom, canViewRoom, isRoomMember } from './room-access';

describe('room access policy', () => {
  const author = { id: 1 };
  const contributor = { id: 2 };
  const stranger = { id: 3 };

  const privateRoom = {
    isPublic: false,
    author,
    contributors: [contributor],
  };
  const publicRoom = {
    isPublic: true,
    author,
    contributors: [] as { id: number }[],
  };

  describe('canViewRoom', () => {
    it('lets anyone view a public room', () => {
      expect(canViewRoom(publicRoom, undefined)).toBe(true);
      expect(canViewRoom(publicRoom, stranger.id)).toBe(true);
    });

    it('lets the author view a private room', () => {
      expect(canViewRoom(privateRoom, author.id)).toBe(true);
    });

    it('lets a contributor view a private room', () => {
      expect(canViewRoom(privateRoom, contributor.id)).toBe(true);
    });

    it('hides a private room from anonymous users and strangers', () => {
      expect(canViewRoom(privateRoom, undefined)).toBe(false);
      expect(canViewRoom(privateRoom, stranger.id)).toBe(false);
    });
  });

  describe('isRoomMember', () => {
    it('counts the author and contributors as members', () => {
      expect(isRoomMember(privateRoom, author.id)).toBe(true);
      expect(isRoomMember(privateRoom, contributor.id)).toBe(true);
    });

    it('does not let public visibility create membership', () => {
      expect(isRoomMember(publicRoom, stranger.id)).toBe(false);
      expect(isRoomMember(publicRoom, undefined)).toBe(false);
      expect(isRoomMember(privateRoom, undefined)).toBe(false);
    });

    it('ignores a missing contributors relation', () => {
      expect(isRoomMember({ isPublic: false, author }, contributor.id)).toBe(
        false,
      );
      expect(isRoomMember({ isPublic: false, author }, author.id)).toBe(true);
    });
  });

  describe('canEditRoom', () => {
    it('only allows the author to edit the room', () => {
      expect(canEditRoom(privateRoom, author.id)).toBe(true);
      expect(canEditRoom(privateRoom, contributor.id)).toBe(false);
      expect(canEditRoom(publicRoom, stranger.id)).toBe(false);
      expect(canEditRoom(publicRoom, undefined)).toBe(false);
    });
  });
});
