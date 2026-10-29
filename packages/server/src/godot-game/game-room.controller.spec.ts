import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { GameRoomController } from './game-room.controller';
import { GameRoomService } from './game-room.service';

describe('GameRoomController', () => {
  let app: INestApplication;
  const service = {
    connect: jest.fn(),
    getStatus: jest.fn(),
  };

  const build = async (authenticated = true) => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GameRoomController],
      providers: [{ provide: GameRoomService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          if (!authenticated) {
            throw new UnauthorizedException();
          }
          context.switchToHttp().getRequest().user = {
            id: 7,
            email: 'player@wired.io',
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    service.connect.mockResolvedValue({
      roomId: 42,
      endpoint: 'ws://127.0.0.1:19100',
      ticket: 'ticket',
      ticketExpiresAt: 1_800_000_000,
      activePlayers: 0,
    });
    service.getStatus.mockResolvedValue({
      roomId: 42,
      state: 'idle',
      endpoint: null,
      activePlayers: 0,
      error: null,
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  it('issues a ticket through POST /rooms/:id/game/connection', async () => {
    await build();

    const response = await request(app.getHttpServer())
      .post('/rooms/42/game/connection')
      .expect(201);

    expect(response.body).toMatchObject({ roomId: 42, ticket: 'ticket' });
    expect(service.connect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      42,
    );
  });

  it('reads status through GET /rooms/:id/game/status', async () => {
    await build();

    const response = await request(app.getHttpServer())
      .get('/rooms/42/game/status')
      .expect(200);

    expect(response.body).toMatchObject({ roomId: 42, state: 'idle' });
    expect(service.getStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      42,
    );
  });

  it('requires authentication on both routes', async () => {
    await build(false);

    await request(app.getHttpServer())
      .post('/rooms/42/game/connection')
      .expect(401);
    await request(app.getHttpServer()).get('/rooms/42/game/status').expect(401);
    expect(service.connect).not.toHaveBeenCalled();
    expect(service.getStatus).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric room id before touching the service', async () => {
    await build();

    await request(app.getHttpServer())
      .post('/rooms/not-a-number/game/connection')
      .expect(400);
    expect(service.connect).not.toHaveBeenCalled();
  });
});
