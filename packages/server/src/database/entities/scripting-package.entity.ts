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
import { Room } from './room.entity';

/*
 * The shapes below describe columns written by the retired Phaser-era package
 * model. Package content now travels as revision files, so nothing writes them
 * any more; they survive only because `DB_SYNC` cannot drop populated columns
 * and older rows still carry values.
 */

export type ScriptFile = {
  filepath: string;
  script: string;
};

export type PhysicalFile = {
  filepath: string;
  hash?: string;
};

@Entity()
export class ScriptingPackage {
  @ApiProperty({ example: 1, description: 'Unique package ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: 'date package created at' })
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public createdAt: Date;

  @ApiProperty({ description: 'date package updated at' })
  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  public updatedAt: Date;

  @ApiProperty({
    example: 'hero_controller',
    description: 'Stable package slug',
  })
  // Nullable only for rows written before slugs existed: the startup backfill
  // fills them before the app serves a request, and refuses to boot if it
  // cannot. Wire payloads use requirePackageSlug() rather than this field.
  @Column({ type: 'varchar', length: 64, nullable: true })
  slug: string | null;

  @ApiProperty({ example: 'Untitled', description: 'package title' })
  @Column({ default: 'Untitled' })
  name: string;

  @ApiProperty({ example: '0.1', description: 'package version' })
  @Column({ default: '0.1' })
  version: string;

  @ApiProperty({ description: 'package description' })
  @Column({ default: '' })
  description: string;

  @ApiProperty({ description: 'Workshop tags', isArray: true })
  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @ApiProperty({ description: 'package dependencies' })
  @Column({ type: 'jsonb', default: [] })
  dependencies: string[];

  @ApiProperty({ description: 'package scripts' })
  @Column({ type: 'jsonb', default: [] })
  scripts: ScriptFile[];

  @ApiProperty({ description: 'package physical files' })
  @Column({ type: 'jsonb', default: [] })
  physicalFiles: PhysicalFile[];

  @ApiProperty({ description: 'package is active in its room' })
  @Column({ default: true })
  enabled: boolean;

  @ApiProperty({
    description: 'editing access level for the package',
    nullable: true,
  })
  @Column({ type: 'varchar', length: 64, nullable: true })
  editingAccess: string | null;

  @ApiProperty({
    description: 'user IDs with editing access',
    isArray: true,
  })
  @Column({ type: 'jsonb', default: [] })
  editingUserIds: number[];

  @ApiProperty({ description: 'package author', type: () => User })
  @ManyToOne(() => User, (user) => user.scriptingPackages, { nullable: true })
  author?: User | null;

  @ApiProperty({
    description: 'package contributors',
    type: () => User,
    isArray: true,
  })
  @ManyToMany(() => User, (user) => user.contributedPackages)
  @JoinTable()
  contributors: User[];

  @ApiProperty({ description: 'package room', type: () => Room })
  @ManyToOne(() => Room, (room) => room.scriptingPackages, { nullable: true })
  room?: Room | null;

  @ApiProperty({
    description: 'package parent package',
    type: () => ScriptingPackage,
  })
  @ManyToOne(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.childrenPackages,
    { nullable: true },
  )
  parentPackage?: ScriptingPackage | null;

  @ApiProperty({
    description: 'package children packages',
    type: () => ScriptingPackage,
    isArray: true,
  })
  @OneToMany(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.parentPackage,
  )
  childrenPackages: ScriptingPackage[];
}
