#!/usr/bin/env node
import { runWmCli } from './cli/wm-program.js';

// Browser profiles and imported sessions inherit private permissions, including files
// created by browser subprocesses. This affects only this CLI process and its children.
process.umask(0o077);
process.exitCode = await runWmCli(process.argv.slice(2));
