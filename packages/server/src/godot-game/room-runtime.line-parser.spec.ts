import { parseRuntimeLine } from './room-runtime.line-parser';

describe('parseRuntimeLine', () => {
  it('parses a readiness line', () => {
    expect(
      parseRuntimeLine(
        'WIRED_SERVER_READY room=room-1 port=19100 bind=127.0.0.1',
      ),
    ).toEqual({ kind: 'ready', roomId: 'room-1', port: 19100 });
  });

  it('parses an authentication line', () => {
    expect(
      parseRuntimeLine('WIRED_AUTH_OK peer=42 player=7 room=room-1'),
    ).toEqual({ kind: 'auth', peer: 42, roomId: 'room-1' });
  });

  it('parses a player departure line', () => {
    expect(parseRuntimeLine('WIRED_PLAYER_LEFT peer=42 player=7')).toEqual({
      kind: 'player-left',
      peer: 42,
    });
  });

  it('ignores unrelated output', () => {
    expect(parseRuntimeLine('Godot Engine v4.3')).toBeNull();
  });

  it('ignores malformed protocol lines', () => {
    expect(
      parseRuntimeLine('WIRED_SERVER_READY room=room-1 port=abc'),
    ).toBeNull();
    expect(
      parseRuntimeLine('WIRED_AUTH_OK peer=x player=7 room=room-1'),
    ).toBeNull();
  });
});
