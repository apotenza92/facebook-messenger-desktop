export const LINUX_NO_SANDBOX_ARG = "--no-sandbox";

export function withLinuxNoSandboxArg(args: string[]): string[] {
  return args.includes(LINUX_NO_SANDBOX_ARG)
    ? args
    : [LINUX_NO_SANDBOX_ARG, ...args];
}
