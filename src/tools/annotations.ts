/** Tool annotation presets shared by all tools. */

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
// Overwrites existing data on YouTube; repeating the same call gives the same result.
export const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
export const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
