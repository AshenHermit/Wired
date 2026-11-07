import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { ScriptingPackage } from './scripting-package.entity';
import {
  GAME_ROOMS_TYPES,
  GameRoomsType,
  RoomAccessMode,
} from '@wired-io/shared';

@Entity()
export class Room {
  @ApiProperty({ example: 1, description: 'Unique room ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: 'date room created at' })
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public createdAt: Date;

  @ApiProperty({ description: 'date room updated at' })
  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  public updatedAt: Date;

  @ApiProperty({ example: 'Untitled', description: 'room title' })
  @Column({ default: 'Untitled' })
  name: string;

  @ApiProperty({
    example: 'true',
    description: 'is public',
  })
  @Column({ default: true })
  isPublic: boolean;

  @ApiProperty({
    description: 'room description',
  })
  @Column({ default: '' })
  description: string;

  @ApiProperty({
    description: 'room type',
    enum: GAME_ROOMS_TYPES,
  })
  @Column({ type: 'enum', enum: GAME_ROOMS_TYPES, default: 'godot' })
  type: GameRoomsType;

  @ApiProperty({ description: 'room author', type: () => User, nullable: true })
  @ManyToOne(() => User, (user) => user.rooms)
  author?: User;

  @ApiProperty({
    description: 'room contributors',
    type: () => User,
    isArray: true,
  })
  @ManyToMany(() => User, (user) => user.contributedRooms)
  @JoinTable()
  contributors: User[];

  @ApiProperty({
    description: 'parent room id',
  })
  // Explicit type: TypeORM cannot infer a column type from `number | null`
  // (it sees `Object` and refuses to start).
  @Column({ type: 'int', nullable: true, default: null })
  parentRoomId: number | null;

  @ApiProperty({
    description: 'optional preview image URL from POST /media',
    nullable: true,
  })
  @Column({ type: 'varchar', nullable: true, default: null })
  previewImage: string | null;

  @ApiProperty({
    description: 'room packages',
    type: () => ScriptingPackage,
    isArray: true,
  })
  @OneToMany(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.room,
  )
  scriptingPackages: ScriptingPackage[];

  @ApiProperty({
    description: 'package management access mode',
    nullable: true,
  })
  @Column({ type: 'varchar', nullable: true, default: null })
  packageManagementAccess: RoomAccessMode | null;

  @ApiProperty({
    description: 'user IDs with package management access',
    isArray: true,
    nullable: true,
  })
  @Column({ type: 'jsonb', nullable: true, default: () => "'[]'" })
  packageManagementUserIds: number[] | null;

  @ApiProperty({
    description: 'package creation access mode',
    nullable: true,
  })
  @Column({ type: 'varchar', nullable: true, default: null })
  packageCreationAccess: RoomAccessMode | null;

  @ApiProperty({
    description: 'user IDs with package creation access',
    isArray: true,
    nullable: true,
  })
  @Column({ type: 'jsonb', nullable: true, default: () => "'[]'" })
  packageCreationUserIds: number[] | null;

  @ApiProperty({
    description: 'room read access mode for package runtime delivery',
    nullable: true,
  })
  @Column({ type: 'varchar', nullable: true, default: null })
  readAccess: RoomAccessMode | null;

  @ApiProperty({
    description: 'user IDs with room read access',
    isArray: true,
    nullable: true,
  })
  @Column({ type: 'jsonb', nullable: true, default: () => "'[]'" })
  readUserIds: number[] | null;
}
