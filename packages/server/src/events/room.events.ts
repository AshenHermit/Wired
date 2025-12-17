import { Room } from 'src/database/entities/room.entity';

export class RoomCreatedEvent {
  constructor(public readonly room: Room) {}
}
export class RoomUpdatedEvent {
  constructor(public readonly room: Room) {}
}
export class RoomDeletedEvent {
  constructor(public readonly room: Room) {}
}

export class RoomEvents {
  static readonly ROOM_CREATED = 'room.created';
  static readonly ROOM_UPDATED = 'room.updated';
  static readonly ROOM_DELETED = 'room.deleted';
}
