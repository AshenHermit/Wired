import { Injectable, NotFoundException } from '@nestjs/common';
import { glob, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const sharedRequire = createRequire(__filename);

export type TypeFile = {
  filepath: string;
  content: string;
};

@Injectable()
export class TypesService {
  getModuleDeclaration(name: string, indexPath: string) {
    // Convert absolute path to relative path for both reference directive and export
    // Since module.d.ts is in the same directory as index.d.ts, use "./index"
    const relativePath = './index';

    // Use triple-slash reference directive with relative path (Monaco resolves it relative to the file)
    return `/// <reference path="${relativePath}.d.ts" />
declare module "${name}" {
  export * from "${relativePath}";
}
`;
  }

  async buildModuleTypesFiles(moduleDir: string, name: string) {
    const files: TypeFile[] = [];
    const viritalDir = `node_modules/@types/${name}`;
    const searchFiles = await glob('**/*.d.ts', { cwd: moduleDir });

    // Build all type files first
    for await (const file of searchFiles) {
      const filepath = file.replace(/\\/g, '/');
      const script = {
        filepath: `${viritalDir}/${filepath}`,
        content: await readFile(join(moduleDir, filepath), 'utf8'),
      };
      files.push(script);
    }

    // Create module declaration file
    // Use the full virtual file path for better resolution in Monaco
    const indexPath = `${viritalDir}/index.d.ts`;
    // files.push({
    //   filepath: `${viritalDir}/module.d.ts`,
    //   content: this.getModuleDeclaration(name, indexPath),
    // });

    return files;
  }

  async getSharedTypings(): Promise<TypeFile[]> {
    const sharedDeclarationPath = join(
      dirname(sharedRequire.resolve('@wired-io/shared/package.json')),
      'dist',
      'types',
    );

    return await this.buildModuleTypesFiles(sharedDeclarationPath, 'wired-io');
  }

  async getLibsTypings(): Promise<TypeFile[]> {
    const libs = ['phaser'];
    const files: TypeFile[] = [];
    const nodeModulesPath = join(
      dirname(sharedRequire.resolve('@wired-io/shared/package.json')),
      'node_modules',
    );
    const packagesPath = join(
      dirname(dirname(sharedRequire.resolve('@wired-io/shared/package.json'))),
    );
    files.push(
      ...(await this.buildModuleTypesFiles(
        join(nodeModulesPath, 'phaser', 'types'),
        'phaser',
      )),
    );
    files.push(
      ...(await this.buildModuleTypesFiles(
        join(packagesPath, 'box2d', 'build'),
        'box2d',
      )),
    );
    return files;
  }
}
