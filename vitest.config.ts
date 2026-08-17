import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/**/*.ts'],
			// The standalone app is browser UI, verified by the HTML integrity
			// test and by opening it. Barrels and type-only modules have no
			// behaviour to cover.
			exclude: ['src/app/**', 'src/types.ts', 'src/**/index.ts'],
			thresholds: {
				statements: 92,
				branches: 86,
				functions: 92,
				lines: 92,
				'src/encoding/**': {
					statements: 100,
					branches: 95,
					functions: 100,
					lines: 100,
				},
				'src/protobuf/**': {
					statements: 100,
					branches: 95,
					functions: 100,
					lines: 100,
				},
				'src/otp/**': {
					statements: 100,
					branches: 95,
					functions: 100,
					lines: 100,
				},
				'src/migration/**': {
					statements: 98,
					branches: 92,
					functions: 100,
					lines: 98,
				},
				// The decode ladder has fallback rungs that only fire on
				// pathological input. Chasing the last few percent there
				// produces tests that assert implementation detail; the fixture
				// corpus is the real measure of decoder quality.
				'src/qr/decode/**': {
					statements: 88,
					branches: 80,
					functions: 90,
					lines: 88,
				},
				'src/dom/**': {
					statements: 80,
					branches: 70,
					functions: 85,
					lines: 80,
				},
			},
		},
	},
});
