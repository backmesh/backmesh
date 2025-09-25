import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { defaultExclude } from 'vitest/config';

export default defineWorkersConfig({
	test: {
		// set test timeout to 100 seconds
		testTimeout: 100000,
		hookTimeout: 15000,
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
