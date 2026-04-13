/** Base error for TUN/TAP and tunnel configuration failures. */
export class TunTapError extends Error {
  public override name = 'TunTapError';

  /**
   * @param message — human-readable description
   * @param code — optional machine-readable code (e.g. `EPERM`)
   */
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Raised when the process lacks privileges required for a networking operation (e.g. not running as root). */
export class TunTapPermissionError extends TunTapError {
  public override name = 'TunTapPermissionError';

  /** @param message — description including hint to run with appropriate privileges */
  constructor(message: string) {
    super(message, 'EPERM');
  }
}

/** Raised when the TUN device cannot be opened or is unavailable. */
export class TunTapDeviceError extends TunTapError {
  public override name = 'TunTapDeviceError';

  /** @param message — description from the native layer or OS */
  constructor(message: string) {
    super(message, 'ENODEV');
  }
}
