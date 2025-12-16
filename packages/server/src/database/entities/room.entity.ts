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

  @ApiProperty({ description: 'room author' })
  @ManyToOne(() => User, (user) => user.rooms)
  author: User;

  @ApiProperty({ description: 'room contributors' })
  @ManyToMany(() => User, (user) => user.contributedRooms)
  @JoinTable()
  contributors: User[];

  @ApiProperty({
    description: 'parent room id',
  })
  @Column({ nullable: true, default: null })
  parentRoomId: number;

  @ApiProperty({ description: 'room packages' })
  @OneToMany(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.room,
  )
  scriptingPackages: ScriptingPackage[];
}
