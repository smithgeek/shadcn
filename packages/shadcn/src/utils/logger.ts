import { highlighter } from "@/src/utils/highlighter"

export enum LogLevel {
  Info,
  Debug,
  Verbose,
}

export const logger = {
  logLevel: LogLevel.Info,
  error(...args: unknown[]) {
    console.log(highlighter.error(args.join(" ")))
  },
  warn(...args: unknown[]) {
    console.log(highlighter.warn(args.join(" ")))
  },
  info(...args: unknown[]) {
    console.log(highlighter.info(args.join(" ")))
  },
  success(...args: unknown[]) {
    console.log(highlighter.success(args.join(" ")))
  },
  log(...args: unknown[]) {
    console.log(args.join(" "))
  },
  debug(...args: unknown[]) {
    if (this.logLevel >= LogLevel.Debug) {
      console.log(args.join(" "))
    }
  },
  verbose(...args: unknown[]) {
    if (this.logLevel >= LogLevel.Verbose) {
      console.log(args.join(" "))
    }
  },
  break() {
    console.log("")
  },
}
