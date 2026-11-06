import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { PublicUser } from '@wired-io/shared';
import { User } from 'src/database/entities/user.entity';
import { ILike, Repository } from 'typeorm';
import { toPublicUser } from 'src/common/public-user';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private usersRepository: Repository<User>,
  ) {}

  async assertUserEditing(editor: User, userId: number): Promise<void> {
    if (editor.id !== userId) {
      throw new ForbiddenException('You are not allowed to edit this user');
    }
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const { email, password, name, picture } = createUserDto;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = this.usersRepository.create({
      email,
      password: hashedPassword,
      name,
      picture: picture,
    });
    return this.usersRepository.save(user);
  }

  async findOneByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: number): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Case-insensitive search over name and email, capped at `limit`, for the
   * authenticated user picker used by access lists. Results are projected to
   * the public shape, so an email match can surface a user without ever leaking
   * the email, password or any other private field.
   */
  async search(query: string, limit: number): Promise<PublicUser[]> {
    const users = await this.usersRepository.find({
      where: [{ name: ILike(`%${query}%`) }, { email: ILike(`%${query}%`) }],
      order: { name: 'ASC' },
      take: limit,
    });
    return users.map(toPublicUser);
  }

  async update(id: number, updateUserDto: UpdateUserDto): Promise<User> {
    const { password, name, picture, ...other } = updateUserDto;
    const hashedPassword = password
      ? await bcrypt.hash(password, 10)
      : undefined;
    await this.usersRepository.update(id, {
      ...(password && { password: hashedPassword }),
      ...(name && { name }),
      ...(picture && { picture }),
      ...other,
    });
    const updated = await this.findById(id);
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }

  async remove(id: number): Promise<void> {
    await this.usersRepository.delete(id);
  }
}
