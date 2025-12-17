import { ScriptFile, ScriptingPackage } from "../api/types";
import { PackageManagerContext } from "./PackageManagerContext";
import { ScriptAgent, ScriptExports } from "./ScriptAgent";

export class PackageExecutionContext {
  scriptAgents: ScriptAgent[] = [];
  package!: ScriptingPackage;
  packageManager: PackageManagerContext;
  lastExports: ScriptExports | null = null;
  constructor(packageManager: PackageManagerContext) {
    this.packageManager = packageManager;
  }
  initFromPackage(pack: ScriptingPackage) {
    this.package = pack;
    this.initialize();
  }
  getPackage(): ScriptingPackage {
    return {
      ...this.package,
      scripts: this.scriptAgents.map((s) => ({
        filepath: s.filepath,
        script: s.script,
      })),
    };
  }
  findScriptByFilepath(filepath: string) {
    return this.scriptAgents.find((s) => s.filepath === filepath);
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
  getScriptPathWithoutType(filepath: string) {
    return filepath.replace(".ts", "");
  }
  requireScript(filepath: string) {
    const script = this.scriptAgents.find(
      (s) =>
        this.getScriptPathWithoutType(s.filepath) ===
        this.getScriptPathWithoutType(filepath)
    );
    if (script) return script.exec();
    return this.packageManager.requirePackage(filepath);
  }
}
