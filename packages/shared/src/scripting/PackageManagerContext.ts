import { ScriptingPackage } from "../api/types";
import EventEmitter from "easy-event-emitter";
import * as Game from "../game";
import * as Phaser from "phaser";
import { PackageExecutionContext } from "./PackageExecutionContext";
import { ScriptAgent, ScriptExports } from "./ScriptAgent";
import * as b2 from "@box2d";

export type PackageManagerEvents = {
  packagesChanged: PackageExecutionContext[];
  packageUpserted: PackageExecutionContext;
  packageRemoved: number;
  errorOccured: { script: ScriptAgent; error: Error };
};

export class PackageManagerContext {
  packages: PackageExecutionContext[] = [];
  events: EventEmitter<PackageManagerEvents>;
  constructor() {
    this.packages = [];
    this.events = new EventEmitter<PackageManagerEvents>();
  }
  upsertPackage(pack: ScriptingPackage) {
    var packContext = this.getPackageById(pack.id);
    if (!packContext) {
      packContext = new PackageExecutionContext(this);
      this.packages = [...this.packages, packContext];
    } else {
      this.packages = [...this.packages];
    }
    packContext.initFromPackage(pack);
    this.events.emit("packagesChanged", this.packages);
    this.events.emit("packageUpserted", packContext);
  }
  getPackages() {
    return this.packages.map((p) => p.getPackage());
  }
  execute() {
    const exports: ScriptExports[] = [];
    for (const pack of this.packages) {
      const scriptExports = pack.execute();
      if (scriptExports) exports.push(scriptExports);
    }
    return exports;
  }
  getPackage(name: string) {
    return this.packages.find((p) => p.package.name === name);
  }
  getPackageById(id: number) {
    return this.packages.find((p) => p.package.id === id);
  }
  require(filepath: string) {
    if (filepath.startsWith("/")) {
      const packageName = filepath.split("/")[1];
      const pkg = this.getPackage(packageName);
      if (pkg) return pkg.requireScript(filepath);
    }
    return this.requirePackage(filepath);
  }
  requirePackage(name: string) {
    const pack = this.getPackage(name);
    if (name == "@wired-io") return Game;
    if (name == "phaser") return Phaser;
    if (name == "@box2d") return b2;
    if (pack) return pack.execute();
    return null;
  }
  removePackage(id: number) {
    this.packages = this.packages.filter((p) => p.package.id !== id);
    this.events.emit("packagesChanged", this.packages);
    this.events.emit("packageRemoved", id);
  }
}
