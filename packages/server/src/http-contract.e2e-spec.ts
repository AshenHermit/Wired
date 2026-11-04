import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Repository } from 'typeorm';
import { DefaultAuthGuard } from 'src/auth/default-auth.guard';
import { JwtAuthGuard, JwtSilentAuthGuard } from 'src/auth/jwt.guard';
import { JwtSilentStrategy, JwtStrategy } from 'src/auth/jwt.strategy';
import { AppConfigService } from 'src/config/config.service';
import { createValidationPipe } from 'src/common/validation';
import { User } from 'src/database/entities/user.entity';
import { UsersController } from 'src/users/users.controller';
import { UsersService } from 'src/users/users.service';

const SECRET = 'test-secret';
const USER = { id: 7, email: 'player@wired.io', name: 'Player' } as User;

/**
 * Boots the real HTTP stack — routing, the default-deny guard, both JWT
 * strategies, the validation pipe and the exception filter — with only the
 * repository faked. Controller specs replace the guard, so the wire contract
 * (status codes, empty bodies, error shapes) was never exercised end to end.
 */
describe('HTTP contract', () => {
  let app: INestApplication;
  let bearer: string;

  const repository = {
    find: jest.fn(async () => [USER]),
    findOne: jest.fn(async () => USER),
    create: jest.fn((values: Partial<User>) => values),
    save: jest.fn(async (values: Partial<User>) => values),
    update: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [UsersController],
      providers: [
        JwtStrategy,
        JwtSilentStrategy,
        JwtAuthGuard,
        JwtSilentAuthGuard,
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
        {
          provide: UsersService,
          useValue: new UsersService(repository as unknown as Repository<User>),
        },
        { provide: AppConfigService, useValue: { site: { authSecret: SECRET } } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    bearer = `Bearer ${new JwtService({ secret: SECRET }).sign({
      email: USER.email,
    })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the profile with no body for an anonymous caller', async () => {
    // `@SilentAuth()` exists so a page can render signed out; a 401 here would
    // break every public route that also wants the viewer.
    const response = await request(app.getHttpServer()).get('/users/profile');

    expect(response.status).toBe(200);
    expect(response.text).toBe('');
  });

  it('answers the profile with the caller for a signed-in token', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/profile')
      .set('Authorization', bearer);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: USER.id, email: USER.email });
  });

  it('refuses a mutation without a token, because the guard is default-deny', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/7')
      .send({ name: 'Renamed' });

    expect(response.status).toBe(401);
  });

  it('returns the stored user from a patch', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/7')
      .set('Authorization', bearer)
      .send({ name: 'Renamed' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: USER.id });
    expect(repository.update).toHaveBeenCalledWith(7, { name: 'Renamed' });
  });

  it('rejects a bad body with the validator message array', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/7')
      .set('Authorization', bearer)
      .send({ password: 'x' });

    expect(response.status).toBe(400);
    expect(response.body.message).toEqual(
      expect.arrayContaining([expect.stringMatching(/password/i)]),
    );
  });

  it('refuses to edit another user', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/8')
      .set('Authorization', bearer)
      .send({ name: 'Renamed' });

    expect(response.status).toBe(403);
  });

  it('answers a delete with 204 and no body', async () => {
    const response = await request(app.getHttpServer())
      .delete('/users/7')
      .set('Authorization', bearer);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(repository.delete).toHaveBeenCalledWith(7);
  });

  it('answers an unknown route with 404', async () => {
    await expect(
      request(app.getHttpServer()).get('/no-such-route'),
    ).resolves.toMatchObject({ status: 404 });
  });
});
