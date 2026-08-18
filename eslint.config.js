// ESLint 9 flat config. Mirrors the shape of the other Hex Pro packages.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'coverage/**',
			'tests/fixtures/**',
			// Measurement rigs and vendored references. Gitignored and never
			// shipped, so linting them only makes a working tree disagree with a
			// clean checkout about whether the gate passes.
			'scratch/**',
			'**/*.config.js',
			'**/*.config.ts',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/ban-ts-comment': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
		},
	},
	{
		// The QR codec is self-contained on purpose. It is roughly two thirds
		// of this package and has nothing to do with Google Authenticator, so
		// keeping its imports inside `src/qr/` (plus the shared error base)
		// means it can be lifted into its own package later without a rewrite.
		// If you need something from `src/encoding/` in here, copy it or move
		// it into `src/qr/`.
		files: ['src/qr/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// Named rather than "anything above this directory",
							// because `errors.js` does live above it and is the
							// one sanctioned exception.
							group: [
								'**/encoding/**',
								'**/protobuf/**',
								'**/migration/**',
								'**/otp/**',
								'**/dom/**',
								'**/app/**',
							],
							message:
								'src/qr must not import from outside src/qr, except ../errors.js. See eslint.config.js.',
						},
					],
				},
			],
		},
	},
	{
		// The standalone offline app is the one place allowed to touch the DOM
		// directly and to log, because it is an application rather than a
		// library.
		files: ['src/app/**/*.ts'],
		rules: {
			'no-restricted-imports': 'off',
		},
	},
);
