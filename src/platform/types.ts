/**
 * Per-interface traffic counters returned by {@link TunTapPlatform.getStats}.
 */
export interface TunTapInterfaceStats {
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    rxErrors: number;
    txErrors: number;
}

/**
 * OS-specific commands for configuring the TUN interface (address, MTU, routes, stats).
 * Built-in Darwin/Linux implementations require **effective UID 0** (run the process as root) for
 * {@link TunTapPlatform.configure}, {@link TunTapPlatform.addRoute}, and {@link TunTapPlatform.removeRoute}.
 * Add a new implementation (e.g. Windows) by extending this interface and wiring it in `create-platform.ts`.
 */
export interface TunTapPlatform {
    /**
     * Assign an IPv6 address (typically /64) and MTU on the interface, and bring it up.
     *
     * @param interfaceName — kernel interface name (e.g. `utun7`)
     * @param address — IPv6 address
     * @param mtu — link MTU in bytes
     */
    configure(interfaceName: string, address: string, mtu: number): Promise<void>;

    /**
     * Add an IPv6 route via this interface.
     *
     * @param interfaceName — kernel interface name
     * @param destination — IPv6 host or CIDR (e.g. `fd00::1/128`)
     */
    addRoute(interfaceName: string, destination: string): Promise<void>;

    /**
     * Remove an IPv6 route for the given destination.
     *
     * @param interfaceName — kernel interface name (ignored on some platforms)
     * @param destination — same form as passed to {@link TunTapPlatform.addRoute}
     */
    removeRoute(interfaceName: string, destination: string): Promise<void>;

    /**
     * Read RX/TX byte and packet counters for the interface from the OS.
     *
     * @param interfaceName — kernel interface name
     * @returns interface statistics
     */
    getStats(interfaceName: string): Promise<TunTapInterfaceStats>;
}
