#!/usr/bin/env node
import { add } from "@/src/commands/add"
import { diff } from "@/src/commands/diff"
import { info } from "@/src/commands/info"
import { init } from "@/src/commands/init"
import { migrate } from "@/src/commands/migrate"
import { Command } from "commander"
import { z } from "zod"

import packageJson from "../package.json"
import { extractStyles } from "./commands/extractStyles"
import { registry } from "./commands/registry"
import { LogLevel, logger } from "./utils/logger"

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))

export const globalOptionsSchema = z.object({
  log: z.enum(["debug", "verbose"]).optional(),
})

async function main() {
  const program = new Command()
    .option("--log <log>", "set log level to 'debug' or 'verbose'", "info")
    .name("shadcn")
    .description("add components and dependencies to your project")
    .version(
      packageJson.version || "1.0.0",
      "-v, --version",
      "display the version number"
    )
    .hook("preAction", (command) => {
      const options = globalOptionsSchema.safeParse(command.opts())
      if (options.success) {
        switch (options.data.log) {
          case "debug":
            logger.logLevel = LogLevel.Debug
            break
          case "verbose":
            logger.logLevel = LogLevel.Verbose
            break
        }
      }
    })

  program
    .addCommand(init)
    .addCommand(add)
    .addCommand(diff)
    .addCommand(migrate)
    .addCommand(info)
    .addCommand(registry)
    .addCommand(extractStyles)

  program.parse()
}

main()
