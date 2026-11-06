import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from './config.interface';

/**
 * Token of the single resolved {@link AppConfig}.
 *
 * `config()` reads the environment and resolves every path, so it must run
 * exactly once per boot. Handing the result to consumers through this token
 * replaces the previous `get(key) ?? config().key` fallback, which could
 * re-read the environment and the runtime manifest on every property access.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Injectable()
export class AppConfigService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get port() {
    return this.config.port;
  }
  get site() {
    return this.config.site;
  }
  get auth() {
    return this.config.auth;
  }
  get db() {
    return this.config.db;
  }
  get storage() {
    return this.config.storage;
  }
  get isProduction() {
    return this.config.nodeEnv === 'production';
  }
  get godot() {
    return this.config.godot;
  }
  get godotRuntime() {
    return this.config.godotRuntime;
  }
  get packages() {
    return this.config.packages;
  }
}
