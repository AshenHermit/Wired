import type { PublicUser } from '@wired-io/shared';
import type { User } from 'src/database/entities/user.entity';

/**
 * The part of a user every reader may see.
 *
 * Room and package payloads embed their author and contributors, and those
 * endpoints answer anonymous callers, so the record must not carry the email
 * that only the signed-in owner is entitled to.
 */
export function toPublicUser(user: User): PublicUser {
  return { id: user.id, name: user.name, picture: user.picture };
}

/** A room/package shaped value with its user relations projected. */
export function withPublicUsers<
  T extends {
    author?: User | null;
    contributors?: User[] | null;
  },
>(row: T): T {
  return {
    ...row,
    ...(row.author === undefined || row.author === null
      ? {}
      : { author: toPublicUser(row.author) }),
    ...(row.contributors === undefined || row.contributors === null
      ? {}
      : { contributors: row.contributors.map(toPublicUser) }),
  } as T;
}
