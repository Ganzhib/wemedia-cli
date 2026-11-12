import type { Command } from 'commander';

export interface CommandContext { program: Command; emit(value: unknown): void }
