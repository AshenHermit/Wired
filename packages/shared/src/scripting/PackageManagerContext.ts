import EventEmitter from "easy-event-emitter";
import * as Game from "../game";
import * as Phaser from "phaser";
import { Package, PackageExecutionContext } from "./PackageExecutionContext";
import { ScriptAgent, ScriptExports } from "./ScriptAgent";

export type PackageManagerEvents = {
  packagesChanged: PackageExecutionContext[];
};

export class PackageManagerContext {
  packages: PackageExecutionContext[] = [];
  events: EventEmitter<PackageManagerEvents>;
  constructor() {
    this.packages = [];
    this.events = new EventEmitter<PackageManagerEvents>();
  }
  upsertPackage(pack: Package) {
    var packContext = this.getPackageById(pack.id);
    if (!packContext) {
      packContext = new PackageExecutionContext(this);
      this.packages = [...this.packages, packContext];
    } else {
      this.packages = [...this.packages];
    }
    packContext.initFromPackage(pack);
    this.events.emit("packagesChanged", this.packages);
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
  getPackageById(id: string) {
    return this.packages.find((p) => p.package.id === id);
  }
  requirePackage(name: string) {
    const pack = this.getPackage(name);
    if (name == "@wired-io") return Game;
    if (name == "phaser") return Phaser;
    if (pack) return pack.execute();
    return null;
  }
  removePackage(id: string) {
    this.packages = this.packages.filter((p) => p.package.id !== id);
    this.events.emit("packagesChanged", this.packages);
  }
}
