import { build } from 'esbuild';
await build({ entryPoints: ['web/firebase-sdk.js'], outfile: 'js/firebase-sdk.js', bundle: true, format: 'esm', minify: true, target: ['safari15', 'chrome100'], legalComments: 'eof' });
