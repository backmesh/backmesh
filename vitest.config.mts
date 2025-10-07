import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { defaultExclude } from 'vitest/config';

export default defineWorkersConfig({
	test: {
		// set test timeout to 200 seconds
		testTimeout: 200000,
		hookTimeout: 30000,
		teardownTimeout: 30000,
		exclude: [
			...defaultExclude,
			'**/stripe/**',
		],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
			},
		},
	},
});
