import { safeRoomName } from './room-runtime.names';

describe('safeRoomName', () => {
  it('keeps identifiers that are already safe', () => {
    expect(safeRoomName('room-1_alpha.beta')).toBe('room-1_alpha.beta');
  });

  it('replaces path separators and other unsafe characters', () => {
    expect(safeRoomName('../room/1')).toBe('.._room_1');
    expect(safeRoomName('room 1:2')).toBe('room_1_2');
  });

  it('is used for both the state directory and the log file name', () => {
    const names = new Set([safeRoomName('room 1'), safeRoomName('room 1')]);
    expect(names.size).toBe(1);
  });
});
