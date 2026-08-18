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
			exclude: [
				'src/app/**',
				'src/types.ts',
				'src/**/index.ts',
				// Interfaces and type aliases only. It compiles to `export {}`,
				// so v8 scores it 0 of 0 and reports 0 percent, which dragged
				// the whole decode directory down by about two points.
				'src/qr/decode/telemetry.ts',
			],
			// Every threshold below sits just under what the suite actually
			// reaches, so a real regression trips it. Setting one lower than
			// that would gate nothing; setting one higher would leave a gate
			// that has never been green, which teaches everybody to ignore it.
			// Raise them when the coverage rises, rather than leaving slack.
			thresholds: {
				statements: 95.5,
				branches: 95,
				functions: 96.5,
				lines: 95.5,
				// Nothing in these two is uncovered. They read untrusted input
				// on a security tool, so the gate is the full hundred and a new
				// branch has to arrive with a test.
				'src/encoding/**': {
					statements: 100,
					branches: 100,
					functions: 100,
					lines: 100,
				},
				'src/protobuf/**': {
					statements: 100,
					branches: 100,
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
					statements: 98.5,
					branches: 97,
					functions: 100,
					lines: 98.5,
				},
				// The decode ladder has fallback rungs that only fire on
				// pathological input. Chasing the last few percent there
				// produces tests that assert implementation detail; the fixture
				// corpus is the real measure of decoder quality. What is left is
				// mostly in decoder.ts, where the rungs below the first
				// successful read never run on an image that decodes.
				'src/qr/decode/**': {
					statements: 92.5,
					branches: 92.5,
					functions: 96.5,
					lines: 92.5,
				},
				// The PNG and SVG writers are checked byte for byte, so this
				// directory stays near the top. The gap is in encoder.ts, on
				// capacity arithmetic for versions no otpauth payload reaches.
				'src/qr/encode/**': {
					statements: 97.5,
					branches: 95.5,
					functions: 100,
					lines: 97.5,
				},
				// What is left here is unreachable rather than untested: two
				// invariant guards in image-source.ts that only a fake breaking
				// the invariant could reach, and two branches in camera.ts for a
				// stream that opens with no video track and for a global that is
				// absent. See the notes on those lines.
				'src/dom/**': {
					statements: 98.5,
					branches: 97,
					functions: 100,
					lines: 98.5,
				},
			},
		},
	},
});
