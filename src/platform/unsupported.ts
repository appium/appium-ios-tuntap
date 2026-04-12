import {TunTapError} from '../errors.js';
import type {TunTapInterfaceStats, TunTapPlatform} from './types.js';

/**
 * Stub backend for unsupported `process.platform` values; every method throws {@link TunTapError}.
 */
export class UnsupportedTunTapPlatform implements TunTapPlatform {
  /**
   * @param platformId — value from `process.platform` (or test override)
   */
  constructor(private readonly platformId: string) {}

  /** @inheritdoc */
  async configure(): Promise<void> {
    this.unsupported();
  }

  /** @inheritdoc */
  async addRoute(): Promise<void> {
    this.unsupported();
  }

  /** @inheritdoc */
  async removeRoute(): Promise<void> {
    this.unsupported();
  }

  /** @inheritdoc */
  async getStats(): Promise<TunTapInterfaceStats> {
    this.unsupported();
  }

  private unsupported(): never {
    throw new TunTapError(`Unsupported platform: ${this.platformId}`);
  }
}
