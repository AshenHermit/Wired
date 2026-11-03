import { GodotGameModule } from './godot-game.module';
import {
  InMemoryTicketRateLimitStore,
  TICKET_RATE_LIMIT_STORE,
} from './game-room.rate-limiter';
import { PackageSyncService } from './package-sync.service';
import { PACKAGE_REVISION_DISPATCHER } from 'src/common/runtime-contracts';

type ProviderBinding = { provide?: unknown; useClass?: unknown };

const providers = (): ProviderBinding[] =>
  Reflect.getMetadata('providers', GodotGameModule) as ProviderBinding[];

describe('GodotGameModule wiring', () => {
  it('exports the publish dispatcher consumed by ScriptingPackagesModule', () => {
    const exports = Reflect.getMetadata(
      'exports',
      GodotGameModule,
    ) as unknown[];

    expect(exports).toEqual(
      expect.arrayContaining([PackageSyncService, PACKAGE_REVISION_DISPATCHER]),
    );
  });

  it('binds the rate-limit store seam to the in-memory store', () => {
    // The limiter injects TICKET_RATE_LIMIT_STORE without a fallback, so a
    // missing binding is a boot-time DI failure rather than a silent default.
    const binding = providers().find(
      (provider) => provider.provide === TICKET_RATE_LIMIT_STORE,
    );

    expect(binding?.useClass).toBe(InMemoryTicketRateLimitStore);
  });
});
