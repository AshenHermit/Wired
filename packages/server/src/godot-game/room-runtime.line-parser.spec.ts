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

  it('parses a package application confirmation', () => {
    expect(
      parseRuntimeLine('WIRED_PACKAGES_APPLIED package=42 revision=3 files=7'),
    ).toEqual({ kind: 'packages-applied', packageId: 42, revision: 3, files: 7 });
  });

  it('parses a package application failure', () => {
    expect(
      parseRuntimeLine(
        'WIRED_PACKAGES_SYNC_FAILED package=42 revision=3 error=hash mismatch',
      ),
    ).toEqual({
      kind: 'packages-failed',
      packageId: 42,
      revision: 3,
      error: 'hash mismatch',
    });
  });

  it('parses a client package readiness report', () => {
    expect(
      parseRuntimeLine('WIRED_CLIENT_PACKAGES_READY peer=5 package=42 revision=3'),
    ).toEqual({
      kind: 'client-packages-ready',
      peer: 5,
      packageId: 42,
      revision: 3,
    });
  });

  it('parses a client package failure report', () => {
    expect(
      parseRuntimeLine(
        'WIRED_CLIENT_PACKAGES_FAILED peer=5 package=42 revision=3 error=download failed',
      ),
    ).toEqual({
      kind: 'client-packages-failed',
      peer: 5,
      packageId: 42,
      revision: 3,
      error: 'download failed',
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
