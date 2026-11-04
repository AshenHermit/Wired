import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { AppConfigService } from 'src/config/config.service';
import { User } from 'src/database/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const password = 'correct horse battery staple';
  let repository: { findOne: jest.Mock; metadata: unknown };
  let usersService: { findOneByEmail: jest.Mock; create: jest.Mock };
  let jwtService: { sign: jest.Mock };
  let service: AuthService;

  beforeEach(async () => {
    repository = {
      findOne: jest.fn(),
      metadata: {
        columns: [
          { propertyName: 'id' },
          { propertyName: 'email' },
          { propertyName: 'name' },
          { propertyName: 'password' },
        ],
      },
    };
    usersService = {
      findOneByEmail: jest.fn(),
      create: jest.fn(),
    };
    jwtService = { sign: jest.fn().mockReturnValue('signed-token') };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repository },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        {
          provide: AppConfigService,
          useValue: {
            site: { authCookieName: 'access_token', commonDomain: 'localhost' },
          },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('returns the user without the password hash for valid credentials', async () => {
    repository.findOne.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
      name: 'User',
      password: await bcrypt.hash(password, 4),
    });

    await expect(
      service.validateUser('user@example.com', password),
    ).resolves.toEqual({
      id: 1,
      email: 'user@example.com',
      name: 'User',
    });
  });

  it('rejects an invalid password', async () => {
    repository.findOne.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
      name: 'User',
      password: await bcrypt.hash(password, 4),
    });

    await expect(
      service.validateUser('user@example.com', 'wrong'),
    ).resolves.toBeNull();
  });

  it('rejects an account without a password (for example, Google-only)', async () => {
    repository.findOne.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
      name: 'User',
      password: '',
    });

    await expect(
      service.validateUser('user@example.com', 'anything'),
    ).resolves.toBeNull();
  });

  it('throws UnauthorizedException from login when credentials are wrong', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      service.login('missing@example.com', 'x'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('signs a token with the user id for valid login', async () => {
    repository.findOne.mockResolvedValue({
      id: 7,
      email: 'user@example.com',
      name: 'User',
      password: await bcrypt.hash(password, 4),
    });

    await expect(service.login('user@example.com', password)).resolves.toEqual({
      access_token: 'signed-token',
    });
    expect(jwtService.sign).toHaveBeenCalledWith({
      email: 'user@example.com',
      sub: 7,
      name: 'User',
    });
  });

  describe('forceLogin', () => {
    it('signs in an existing account without touching the user store', async () => {
      usersService.findOneByEmail.mockResolvedValue({
        id: 3,
        email: 'ann@wired.io',
        name: 'Ann',
      });

      await expect(
        service.forceLogin('ann@wired.io', 'Ann', 'p', ''),
      ).resolves.toEqual({ access_token: 'signed-token' });
      expect(usersService.create).not.toHaveBeenCalled();
      expect(jwtService.sign).toHaveBeenCalledWith({
        email: 'ann@wired.io',
        sub: 3,
        name: 'Ann',
      });
    });

    it('creates the account on first login and signs the new id', async () => {
      usersService.findOneByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue({
        id: 11,
        email: 'ann@wired.io',
        name: 'Ann',
      });

      await expect(
        service.forceLogin('ann@wired.io', 'Ann', 'p', ''),
      ).resolves.toEqual({ access_token: 'signed-token' });
      expect(usersService.create).toHaveBeenCalledWith({
        email: 'ann@wired.io',
        name: 'Ann',
        picture: 'p',
        password: '',
      });
      expect(jwtService.sign).toHaveBeenCalledWith({
        email: 'ann@wired.io',
        sub: 11,
        name: 'Ann',
      });
    });
  });

  describe('cookie helpers', () => {
    it('writes the token under the shared cookie name and domain', () => {
      const res = { cookie: jest.fn() };

      service.writeCookie(res as never, { access_token: 'signed-token' });

      expect(res.cookie).toHaveBeenCalledWith('access_token', 'signed-token', {
        domain: 'localhost',
      });
    });

    it('clears the same cookie it wrote', () => {
      const res = { clearCookie: jest.fn() };

      service.clearCookie(res as never);

      expect(res.clearCookie).toHaveBeenCalledWith('access_token', {
        domain: 'localhost',
      });
    });
  });
});
