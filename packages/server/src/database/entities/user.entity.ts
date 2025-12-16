import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { ScriptingPackage } from './scripting-package.entity';
import { Room } from './room.entity';

@Entity()
export class User {
  @ApiProperty({ example: 1, description: 'Unique user ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({
    example: 'user@example.com',
    description: 'User email',
  })
  @Column({ unique: true })
  email: string;

  @ApiProperty({ example: 'hashpass', description: 'Hashed password' })
  @Column({ select: false })
  @Exclude({ toClassOnly: true })
  password: string;

  @ApiProperty({ example: 'Anna Lord', description: 'User name' })
  @Column()
  name: string;

  @ApiProperty({
    example: 'https://site.com/picture.webp',
    description: 'picture',
  })
  @Column({ default: '' })
  picture: string;

  @ApiProperty({
    example: 'google',
    description: 'Authorization service',
  })
  @Column({ default: 'email' })
  service: 'email' | 'google' | 'vk' | 'yandex' | 'github';

  @ApiProperty({ description: 'user rooms' })
  @OneToMany(() => Room, (room) => room.author)
  rooms: Room[];

  @ApiProperty({ description: 'user rooms' })
  @ManyToMany(() => Room, (room) => room.author)
  contributedRooms: Room[];

  @ApiProperty({ description: 'user scripting packages' })
  @OneToMany(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.author,
  )
  scriptingPackages: ScriptingPackage[];

  @ApiProperty({ description: 'user scripting packages' })
  @ManyToMany(
    () => ScriptingPackage,
    (scriptingPackage) => scriptingPackage.contributors,
  )
  contributedPackages: ScriptingPackage[];
}
