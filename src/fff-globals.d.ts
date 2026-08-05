/**
 * Ambient declarations for third-party packages that reference build-time
 * constants without declaring them.
 *
 * `@ff-labs/fff-bun` uses `FFF_LIBC` (a `bun build --define` constant, default
 * "gnu" for glibc) inside its source; tsc needs it declared to type-check the
 * import. We run via `bun run` (no build define), so it always falls back to
 * the glibc default at runtime.
 */
declare const FFF_LIBC: string | undefined;
