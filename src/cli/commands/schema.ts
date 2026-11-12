import type { Command } from 'commander';

function describeOptions(command: Command) {
  return command.options.filter(option => !option.hidden).map(option => ({
    flags: option.flags,
    description: option.description,
    required: option.mandatory,
    value_required: option.required,
    value_optional: option.optional,
    default: option.defaultValue as unknown,
    choices: option.argChoices,
  }));
}

interface CommandDescription {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean; variadic: boolean; default: unknown; choices: string[] | undefined }[];
  options: ReturnType<typeof describeOptions>;
  commands: CommandDescription[];
}

export function describeCommand(command: Command): CommandDescription {
  return {
    name: command.name(),
    description: command.description(),
    arguments: command.registeredArguments.map(argument => ({
      name: argument.name(), description: argument.description,
      required: argument.required, variadic: argument.variadic,
      default: argument.defaultValue as unknown, choices: argument.argChoices,
    })),
    options: describeOptions(command),
    commands: command.commands.map(describeCommand),
  };
}
