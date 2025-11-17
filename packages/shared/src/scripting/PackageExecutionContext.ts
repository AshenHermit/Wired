import { PackageManagerContext } from "./PackageManagerContext";
import { ScriptAgent, ScriptExports } from "./ScriptAgent";

export type ScriptFile = {
  filepath: string;
  script: string;
};

export type Package = {
  id: string;
  name: string;
  version: string;
  dependencies: string[];
  description: string;
  scripts: ScriptFile[];
};

export class PackageExecutionContext {
  scriptAgents: ScriptAgent[] = [];
  package: Package;
  packageManager: PackageManagerContext;
  lastExports: ScriptExports | null = null;
  constructor(packageManager: PackageManagerContext) {
    this.packageManager = packageManager;
  }
  initFromPackage(pack: Package) {
    this.package = pack;
    this.initialize();
  }
  getPackage(): Package {
    return {
      ...this.package,
      scripts: this.scriptAgents.map((s) => ({
        filepath: s.filepath,
        script: s.script,
      })),
    };
  }
  initialize() {
    this.scriptAgents = [];
    for (const script of this.package.scripts) {
      const isMain = script.filepath.endsWith("main.ts");
      this.scriptAgents.push(
        new ScriptAgent(script.filepath, script.script, isMain, this)
      );
    }
  }
  execute() {
    for (const script of this.scriptAgents) {
      if (script.isMain) {
        this.lastExports = script.exec();
        return this.lastExports;
      }
    }
    return null;
  }
  requireScript(filepath: string) {
    const script = this.scriptAgents.find((s) => s.filepath === filepath);
    if (script) return script.exec();
    return this.packageManager.requirePackage(filepath);
  }
}
