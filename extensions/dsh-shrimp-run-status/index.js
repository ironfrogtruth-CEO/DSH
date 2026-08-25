// dsh-shrimp-run-status — client-only durable shrimp run status rail.
// The host already exposes the read-only /api/shrimp/tank proxy.  Keeping this
// package host-free avoids another singleton and makes the UI safe to unmount.
export const name = 'dsh-shrimp-run-status'
export const inject = []
export function apply() {}
