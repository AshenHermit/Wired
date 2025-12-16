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

export type ScriptFile = {
  filepath: string;
  script: string;
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

  @ApiProperty({ example: 'Untitled', description: 'package title' })
  @Column({ default: 'Untitled' })
  name: string;

  @ApiProperty({ example: '0.1', description: 'package version' })
  @Column({ default: '0.1' })
  version: string;

  @ApiProperty({ description: 'package description' })
  @Column({ default: '' })
  description: string;

  @ApiProperty({ description: 'package dependencies' })
  @Column({ type: 'jsonb', default: [] })
  dependencies: string[];

  @ApiProperty({ description: 'package scripts' })
  @Column({ type: 'jsonb', default: [] })
  scripts: ScriptFile[];

  @ApiProperty({ description: 'package author', type: () => User })
  @ManyToOne(() => User, (user) => user.scriptingPackages)
  author: User;

  @ApiProperty({
    description: 'package contributors',
    type: () => User,
    isArray: true,
  })
  @ManyToMany(() => User, (user) => user.contributedPackages)
  @JoinTable()
  contributors: User[];

  @ApiProperty({ description: 'package room', type: () => Room })
  @ManyToOne(() => Room, (room) => room.scriptingPackages)
  room: Room;

  @ApiProperty({
    description: 'package parent package',
    type: () => ScriptingPackage,
  })
  @ManyToOne(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.childrenPackages,
  )
  parentPackage: ScriptingPackage;

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
