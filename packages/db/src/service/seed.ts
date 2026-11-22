import type { ServiceDeps } from './deps';
import type { SeedSummary } from './seed-common';
import { seedKiryanaDemo } from './seed-kiryana';

export type { SeedSummary } from './seed-common';

/**
 * Creates the kiryana demo shop through the REAL service (so outbox rows and the hash chain are exercised).
 * Throws ALREADY_SETUP if the shop exists.
 */
export const seedDemoData = (deps: ServiceDeps): Promise<SeedSummary> => seedKiryanaDemo(deps);
