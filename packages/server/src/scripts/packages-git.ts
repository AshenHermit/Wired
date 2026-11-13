import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { ScriptingPackageRevision } from '../database/entities/scripting-package-revision.entity';
import { PackageGitMaintenanceService } from '../scripting-packages/publish/package-git-maintenance.service';
import { PackageRevisionsService } from '../scripting-packages/publish/package-revisions.service';

const USAGE = `Usage: packages-git <command> --all|--package <id>

Commands:
  migrate   convert legacy published revisions into git commits
  cleanup   delete legacy revision directories of converted packages
  gc        repack and prune unreachable git objects
  export    write published revisions back to legacy directories
  repair    fsck and rebuild missing refs`;

type Command = 'migrate' | 'cleanup' | 'gc' | 'export' | 'repair';

const COMMANDS: readonly Command[] = [
  'migrate',
  'cleanup',
  'gc',
  'export',
  'repair',
];

interface CliOptions {
  command: Command;
  all: boolean;
  packageId: number | null;
}

function parseOptions(argv: string[]): CliOptions {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) {
    throw new Error(USAGE);
  }
  let all = false;
  let packageId: number | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--package') {
      const value = Number(rest[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--package expects a positive integer id\n\n${USAGE}`);
      }
      packageId = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  if (all && packageId !== null) {
    throw new Error(`Specify either --all or --package <id>\n\n${USAGE}`);
  }
  if (!all && packageId === null) {
    throw new Error(`Specify --all or --package <id>\n\n${USAGE}`);
  }
  return { command: command as Command, all, packageId };
}

/** Packages that have at least one published revision. */
async function publishedPackageIds(dataSource: DataSource): Promise<number[]> {
  const rows = await dataSource.getRepository(ScriptingPackageRevision).find({
    where: { status: 'published' },
    relations: { package: true },
  });
  return [...new Set(rows.map((row) => row.package.id))].sort(
    (left, right) => left - right,
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const logger = new Logger('packages-git');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const revisions = app.get(PackageRevisionsService);
    const maintenance = app.get(PackageGitMaintenanceService);
    const dataSource = app.get(DataSource);
    const packageIds =
      options.packageId !== null
        ? [options.packageId]
        : await publishedPackageIds(dataSource);

    if (packageIds.length === 0) {
      logger.log('no packages to process');
      return;
    }

    for (const packageId of packageIds) {
      switch (options.command) {
        case 'migrate': {
          const count = await revisions.migratePackage(packageId);
          logger.log(`package ${packageId}: ${count} revision(s) migrated`);
          break;
        }
        case 'cleanup': {
          const count = await revisions.cleanupLegacyRevisions(packageId);
          logger.log(`package ${packageId}: ${count} legacy director(ies) removed`);
          break;
        }
        case 'gc':
          await maintenance.maintainPackage(packageId);
          logger.log(`package ${packageId}: maintenance complete`);
          break;
        case 'export': {
          const count = await maintenance.exportPackage(packageId);
          logger.log(`package ${packageId}: ${count} revision(s) exported`);
          break;
        }
        case 'repair':
          await maintenance.repairPackage(packageId);
          logger.log(`package ${packageId}: refs repaired`);
          break;
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
