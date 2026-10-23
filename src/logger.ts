import chalk, { chalkStderr } from "chalk";

/** Keep stdout and stderr color detection independent, including redirected output. */
export const logger = {
  info(message: string): void {
    console.log(chalk.cyan(message));
  },
  success(message: string): void {
    console.log(chalk.green(message));
  },
  field(label: string, value: string | number): void {
    console.log(`${chalk.cyan(label)} ${chalk.bold(value)}`);
  },
  warn(message: string): void {
    console.warn(chalkStderr.yellow(message));
  },
  error(message: string): void {
    console.error(chalkStderr.red(message));
  },
};
